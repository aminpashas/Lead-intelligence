/**
 * Smile Design Lab API client.
 *
 * Per-org config lives in connector_configs (connector_type 'smile_design_lab'):
 *   credentials: { api_url, api_key, webhook_secret }
 * The api_key is an SDL practice-scoped key (sdlk_...) — the LI org maps 1:1
 * to an SDL practice. Status updates flow back via /api/webhooks/lab/sdl,
 * HMAC-signed with webhook_secret.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CaseFileType } from '@/types/database'

export type SdlConfig = {
  apiUrl: string
  apiKey: string
  webhookSecret: string | null
}

export async function getSdlConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<SdlConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('enabled, credentials')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'smile_design_lab')
    .maybeSingle()
  if (!data?.enabled) return null
  const creds = (data.credentials ?? {}) as Record<string, string>
  if (!creds.api_url || !creds.api_key) return null
  return {
    apiUrl: creds.api_url.replace(/\/$/, ''),
    apiKey: creds.api_key,
    webhookSecret: creds.webhook_secret ?? null,
  }
}

export class SdlApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'SdlApiError'
  }
}

async function sdlFetch(config: SdlConfig, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new SdlApiError(String(json.error ?? `SDL API ${res.status}`), res.status)
  }
  return json
}

export type SdlCasePayload = {
  patient: {
    firstName: string
    lastName: string
    dateOfBirth: string
    email?: string
    phoneE164?: string
    externalCode?: string
    consentToShareWithLab: true
  }
  case: {
    caseType: string
    urgency?: 'standard' | 'rush'
    dueDate?: string
    doctorNotes?: string
    labId?: string
  }
  labSlip?: { shade?: string; additionalInstructions?: string }
}

export async function createSdlCase(
  config: SdlConfig,
  payload: SdlCasePayload
): Promise<{ caseId: string; caseNumber: string }> {
  const json = await sdlFetch(config, '/api/v1/cases', payload)
  return { caseId: String(json.caseId), caseNumber: String(json.caseNumber) }
}

export async function prepareSdlFileUpload(
  config: SdlConfig,
  sdlCaseId: string,
  file: { kind: string; fileName: string; sizeBytes: number; mimeType?: string }
): Promise<{ fileId: string; uploadUrl: string; uploadToken: string }> {
  const json = await sdlFetch(config, `/api/v1/cases/${sdlCaseId}/files`, file)
  return {
    fileId: String(json.fileId),
    uploadUrl: String(json.uploadUrl),
    uploadToken: String(json.uploadToken),
  }
}

/** Map LI case_files.file_type → SDL case_file_kind. */
export function toSdlFileKind(fileType: CaseFileType): string {
  switch (fileType) {
    case 'stl':
    case 'intraoral':
      return 'intraoral_scan_stl'
    case 'cbct':
    case 'ct_scan':
      return 'cbct_dicom'
    case 'xray':
    case 'panoramic':
    case 'periapical':
    case 'cephalometric':
      return 'xray_2d'
    default:
      return 'reference_image'
  }
}
