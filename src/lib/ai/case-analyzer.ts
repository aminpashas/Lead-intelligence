/**
 * Clinical Case AI Analyzer
 *
 * Uses Claude Vision to analyze dental images (intraoral photos, x-rays,
 * panoramic radiographs). Returns structured findings with conditions,
 * severity, and recommended procedures.
 *
 * For non-image files (STL, CT/DICOM), extracts metadata only.
 */

import Anthropic from '@anthropic-ai/sdk'

export type AIFinding = {
  area: string
  condition: string
  severity: 'mild' | 'moderate' | 'severe' | 'critical'
  confidence: number
  notes: string
}

export type CaseAnalysisResult = {
  findings: AIFinding[]
  summary: string
  recommended_procedures: string[]
  risk_factors: string[]
  overall_severity: 'mild' | 'moderate' | 'severe' | 'critical'
  confidence: number
  raw_analysis: string
}

const DENTAL_ANALYSIS_PROMPT = `You are an AI dental imaging analysis assistant. Analyze this dental image and provide a detailed clinical assessment.

Examine the image for:
1. **Missing teeth** — identify which teeth are missing by quadrant/number
2. **Decay/Caries** — note location and apparent severity
3. **Bone loss** — assess alveolar bone levels if visible
4. **Gum/periodontal issues** — inflammation, recession, pocketing signs
5. **Fractures/cracks** — any visible structural damage
6. **Existing restorations** — crowns, bridges, implants, fillings
7. **Root pathology** — periapical lesions, root resorption
8. **Occlusion issues** — malocclusion, wear patterns
9. **Soft tissue abnormalities** — lesions, swelling, discoloration
10. **Implant planning considerations** — bone width/height assessment

Respond in this exact JSON format:
{
  "findings": [
    {
      "area": "Upper right quadrant / Tooth #14 / etc.",
      "condition": "Brief description",
      "severity": "mild|moderate|severe|critical",
      "confidence": 0.85,
      "notes": "Additional clinical notes"
    }
  ],
  "summary": "One-paragraph clinical summary of all findings",
  "recommended_procedures": ["Procedure 1", "Procedure 2"],
  "risk_factors": ["Factor 1", "Factor 2"],
  "overall_severity": "mild|moderate|severe|critical",
  "confidence": 0.80
}

IMPORTANT:
- Be clinically precise but note that this is AI-assisted and requires doctor confirmation
- Rate your confidence honestly (0-1 scale)
- If the image quality is poor, note it and lower confidence
- If this is not a dental image, say so clearly in the summary`

/**
 * Analyze a dental image using Claude Vision API
 */
export async function analyzeDentalImage(
  imageUrl: string,
  fileType: string,
  chiefComplaint?: string
): Promise<CaseAnalysisResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[CaseAnalyzer] No ANTHROPIC_API_KEY set, skipping AI analysis')
    return null
  }

  // Non-analyzable file types
  if (['stl', 'ct_scan', 'cbct'].includes(fileType)) {
    return {
      findings: [],
      summary: `${fileType.toUpperCase()} file uploaded. This file format requires specialized 3D viewing software for analysis. The doctor should review this file using a compatible DICOM/STL viewer.`,
      recommended_procedures: [],
      risk_factors: [],
      overall_severity: 'moderate',
      confidence: 0,
      raw_analysis: 'File type not supported for AI image analysis.',
    }
  }

  try {
    const anthropic = new Anthropic({ apiKey })

    // Fetch the image and convert to base64
    const imageResponse = await fetch(imageUrl)
    if (!imageResponse.ok) {
      console.error('[CaseAnalyzer] Failed to fetch image:', imageResponse.status)
      return null
    }

    const imageBuffer = await imageResponse.arrayBuffer()
    const base64Image = Buffer.from(imageBuffer).toString('base64')

    // Determine media type
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg'
    const mediaType = contentType.startsWith('image/')
      ? contentType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      : 'image/jpeg'

    const contextNote = chiefComplaint
      ? `\n\nPatient's chief complaint: "${chiefComplaint}". Pay special attention to areas relevant to this complaint.`
      : ''

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: DENTAL_ANALYSIS_PROMPT + contextNote,
            },
          ],
        },
      ],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      console.error('[CaseAnalyzer] No text in response')
      return null
    }

    const rawText = textBlock.text
    // Extract JSON from the response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return {
        findings: [],
        summary: rawText.slice(0, 500),
        recommended_procedures: [],
        risk_factors: [],
        overall_severity: 'moderate',
        confidence: 0.3,
        raw_analysis: rawText,
      }
    }

    const parsed = JSON.parse(jsonMatch[0])
    return {
      findings: parsed.findings || [],
      summary: parsed.summary || '',
      recommended_procedures: parsed.recommended_procedures || [],
      risk_factors: parsed.risk_factors || [],
      overall_severity: parsed.overall_severity || 'moderate',
      confidence: parsed.confidence || 0.5,
      raw_analysis: rawText,
    }
  } catch (error) {
    console.error('[CaseAnalyzer] AI analysis failed:', error)
    return null
  }
}

/**
 * Aggregate multiple file analyses into a single case summary
 */
export function aggregateCaseAnalysis(
  fileAnalyses: Array<{ fileType: string; analysis: CaseAnalysisResult }>
): Record<string, unknown> {
  const allFindings: AIFinding[] = []
  const allProcedures: string[] = []
  const allRisks: string[] = []
  const summaries: string[] = []
  let maxSeverityScore = 0

  const severityScores: Record<string, number> = {
    mild: 1,
    moderate: 2,
    severe: 3,
    critical: 4,
  }

  for (const { analysis } of fileAnalyses) {
    allFindings.push(...analysis.findings)
    allProcedures.push(...analysis.recommended_procedures)
    allRisks.push(...analysis.risk_factors)
    summaries.push(analysis.summary)

    const score = severityScores[analysis.overall_severity] || 2
    if (score > maxSeverityScore) maxSeverityScore = score
  }

  const severityLabels = ['mild', 'moderate', 'severe', 'critical']
  const overallSeverity = severityLabels[Math.min(maxSeverityScore - 1, 3)] || 'moderate'

  return {
    findings: allFindings,
    recommended_procedures: [...new Set(allProcedures)],
    risk_factors: [...new Set(allRisks)],
    overall_severity: overallSeverity,
    file_count: fileAnalyses.length,
    summary: summaries.join(' '),
    analyzed_at: new Date().toISOString(),
  }
}
