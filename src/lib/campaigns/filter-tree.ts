/**
 * Advanced Filter Tree — the shared predicate representation behind the
 * Leads-page advanced search and the Smart List builder.
 *
 * A tree is either a GROUP (`and`/`or` over children, optionally negated) or a
 * leaf CONDITION (`field` `operator` `value`). This file owns two things:
 *
 *  1. FILTER_FIELDS — the registry of every filterable field. It is the security
 *     boundary: only fields listed here, with their declared operators and value
 *     shapes, validate. An unknown field name (or one crafted to break a
 *     PostgREST filter string) is rejected before it can reach a query. The UI
 *     reads the same registry to render controls, so search UI and query engine
 *     cannot drift apart.
 *  2. filterNodeSchema — the recursive Zod validator, depth-capped.
 *
 * The resolver (set-combination engine) lives alongside in a later step; keeping
 * the schema/registry pure here makes it unit-testable with no I/O.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceLineOrFilter } from '@/lib/leads/service-line'

export const FILTER_OPERATORS = [
  'in', 'not_in', 'eq', 'neq', 'gte', 'lte', 'between',
  'after', 'before', 'contains', 'is_null', 'not_null',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/**
 * How a field is filtered.
 *  - text/number/enum/uuid/date/boolean → a physical `leads` column
 *  - special → resolved by a dedicated resolver (service line, tags, keywords,
 *    conversation activity), not a plain column predicate
 */
export type FilterFieldKind =
  | 'text' | 'number' | 'enum' | 'uuid' | 'date' | 'boolean' | 'special'

export type FilterFieldDef = {
  kind: FilterFieldKind
  label: string
  operators: readonly FilterOperator[]
  /** Physical leads column. Absent for `special` fields (custom resolvers). */
  column?: string
  /** Optional enum options, surfaced to the builder UI. */
  options?: readonly string[]
}

// Operator presets per kind — keeps the registry declarations terse and
// consistent (every text field allows the same operators, etc.).
const TEXT_OPS = ['in', 'not_in', 'eq', 'neq', 'contains', 'is_null', 'not_null'] as const
const NUMBER_OPS = ['gte', 'lte', 'between', 'eq', 'neq', 'is_null', 'not_null'] as const
const ENUM_OPS = ['in', 'not_in', 'is_null', 'not_null'] as const
const UUID_OPS = ['in', 'not_in', 'is_null', 'not_null'] as const
const DATE_OPS = ['after', 'before', 'between', 'is_null', 'not_null'] as const
const BOOL_OPS = ['eq'] as const

/**
 * The filterable vocabulary. Grouped by intent to match how the builder UI
 * presents them. Adding a field here makes it available to BOTH surfaces.
 */
export const FILTER_FIELDS: Record<string, FilterFieldDef> = {
  // — Pipeline / lifecycle —
  status: { kind: 'enum', label: 'Lead status', operators: ENUM_OPS, column: 'status' },
  ai_qualification: { kind: 'enum', label: 'AI qualification', operators: ENUM_OPS, column: 'ai_qualification' },
  stage_id: { kind: 'uuid', label: 'Pipeline stage', operators: UUID_OPS, column: 'stage_id' },
  engagement_temperature: {
    kind: 'enum', label: 'Engagement temperature', operators: ENUM_OPS,
    column: 'engagement_temperature', options: ['hot', 'warm', 'cooling', 'cold', 'new'],
  },
  closing_temperature: { kind: 'enum', label: 'Closing temperature', operators: ENUM_OPS, column: 'closing_temperature' },
  is_existing_patient: { kind: 'boolean', label: 'Existing patient', operators: BOOL_OPS, column: 'is_existing_patient' },

  // — Scores / value —
  ai_score: { kind: 'number', label: 'AI score', operators: NUMBER_OPS, column: 'ai_score' },
  engagement_score: { kind: 'number', label: 'Engagement score', operators: NUMBER_OPS, column: 'engagement_score' },
  treatment_value: { kind: 'number', label: 'Treatment value', operators: NUMBER_OPS, column: 'treatment_value' },

  // — Demographics —
  age: { kind: 'number', label: 'Age', operators: NUMBER_OPS, column: 'age' },
  preferred_language: { kind: 'text', label: 'Preferred language', operators: TEXT_OPS, column: 'preferred_language' },

  // — Location (where they live) —
  city: { kind: 'text', label: 'City', operators: TEXT_OPS, column: 'city' },
  state: { kind: 'text', label: 'State', operators: TEXT_OPS, column: 'state' },
  zip_code: { kind: 'text', label: 'ZIP code', operators: TEXT_OPS, column: 'zip_code' },
  distance_to_practice_miles: {
    kind: 'number', label: 'Distance to practice (mi)', operators: NUMBER_OPS,
    column: 'distance_to_practice_miles',
  },

  // — Conversation analysis (sweep-written) —
  conversation_intent: { kind: 'enum', label: 'Conversation intent', operators: ENUM_OPS, column: 'conversation_intent' },
  conversation_sentiment: { kind: 'enum', label: 'Conversation sentiment', operators: ENUM_OPS, column: 'conversation_sentiment' },
  primary_objection: { kind: 'enum', label: 'Primary objection', operators: ENUM_OPS, column: 'primary_objection' },

  // — Source / attribution —
  source_type: { kind: 'enum', label: 'Source type', operators: ENUM_OPS, column: 'source_type' },

  // — Dates —
  created_at: { kind: 'date', label: 'Created date', operators: DATE_OPS, column: 'created_at' },
  last_contacted_at: { kind: 'date', label: 'Last contacted', operators: DATE_OPS, column: 'last_contacted_at' },
  last_responded_at: { kind: 'date', label: 'Last replied', operators: DATE_OPS, column: 'last_responded_at' },
  consultation_date: { kind: 'date', label: 'Consultation date', operators: DATE_OPS, column: 'consultation_date' },

  // — Special resolvers (not plain columns) —
  /** Treatment line — resolved via serviceLineOrFilter (implants is residual). */
  service_line: { kind: 'special', label: 'Treatment / service line', operators: ['eq'] },
  /** Conversation activity in a window — resolved against the messages table. */
  conversation_activity: { kind: 'special', label: 'Conversation activity date', operators: ['after', 'before', 'between'] },
}

/** Max group nesting depth. Bounds resolver work and rejects pathological trees. */
export const MAX_FILTER_DEPTH = 8

// ── Condition schema ─────────────────────────────────────────────────────────

const conditionSchema = z
  .object({
    type: z.literal('condition'),
    field: z.string(),
    operator: z.enum(FILTER_OPERATORS),
    // Value is operator-dependent; validated in superRefine below.
    value: z.unknown().optional(),
  })
  .superRefine((cond, ctx) => {
    const def = FILTER_FIELDS[cond.field]
    if (!def) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown filter field: ${cond.field}` })
      return
    }
    if (!def.operators.includes(cond.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${cond.operator}" not allowed on field "${cond.field}"`,
      })
      return
    }
    validateValueShape(def, cond.operator, cond.value, ctx)
  })

function validateValueShape(
  def: FilterFieldDef,
  operator: FilterOperator,
  value: unknown,
  ctx: z.RefinementCtx
) {
  const fail = (message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message })

  // Presence/absence of value.
  if (operator === 'is_null' || operator === 'not_null') {
    if (value !== undefined) fail(`"${operator}" takes no value`)
    return
  }
  if (value === undefined || value === null) {
    fail(`"${operator}" requires a value`)
    return
  }

  const numeric = def.kind === 'number'

  switch (operator) {
    case 'in':
    case 'not_in': {
      if (!Array.isArray(value) || value.length === 0) fail(`"${operator}" requires a non-empty array`)
      return
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        fail('"between" requires a [min, max] pair')
        return
      }
      if (numeric && !value.every((v) => typeof v === 'number')) fail('"between" bounds must be numbers')
      return
    }
    default: {
      // Scalar operators (eq/neq/gte/lte/after/before/contains).
      if (Array.isArray(value)) { fail(`"${operator}" takes a single value`); return }
      if (numeric && typeof value !== 'number') fail(`Field "${def.label}" expects a number`)
      return
    }
  }
}

// ── Group schema (recursive) ─────────────────────────────────────────────────

export type FilterCondition = {
  type: 'condition'
  field: string
  operator: FilterOperator
  value?: unknown
}
export type FilterGroup = {
  type: 'group'
  op: 'and' | 'or'
  negate?: boolean
  children: FilterNode[]
}
export type FilterNode = FilterCondition | FilterGroup

// Structural recursion with no depth cap; the cap is enforced once at the
// public entry (filterNodeSchema) by walking the parsed tree.
const nodeStructSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({
      type: z.literal('group'),
      op: z.enum(['and', 'or']),
      negate: z.boolean().optional(),
      children: z.array(nodeStructSchema).min(1).max(50),
    }),
  ])
) as z.ZodType<FilterNode>

function treeDepth(node: FilterNode): number {
  if (node.type === 'condition') return 1
  return 1 + Math.max(0, ...node.children.map(treeDepth))
}

/** Public schema for an advanced filter tree. Validates structure, the field
 *  registry, per-operator value shapes, and the nesting depth cap. */
export const filterNodeSchema = nodeStructSchema.superRefine((node, ctx) => {
  if (treeDepth(node) > MAX_FILTER_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Filter nested deeper than ${MAX_FILTER_DEPTH} levels`,
    })
  }
})

// ── Boolean set-combination (pure core of the resolver) ──────────────────────

/**
 * Combine a group's child lead-ID sets into the group's result set.
 *
 *  - op 'and'  → intersection of every child set
 *  - op 'or'   → union of every child set
 *  - negate    → complement of the combined result within `universe`
 *
 * `universe` is the org's candidate set (all lead IDs the org could match); it
 * is what a NOT is taken relative to. Vacuous groups use boolean identity:
 * an empty AND matches the whole universe, an empty OR matches nothing.
 *
 * See filter-tree-combine.test.ts for the exact contract.
 */
export function combineSets(
  op: 'and' | 'or',
  childSets: Set<string>[],
  opts: { negate?: boolean; universe: Set<string> }
): Set<string> {
  let result: Set<string>
  if (op === 'and') {
    // Empty AND = identity (whole universe). Otherwise intersect, smallest-first.
    if (childSets.length === 0) {
      result = new Set(opts.universe)
    } else {
      const ordered = [...childSets].sort((a, b) => a.size - b.size)
      result = new Set(ordered[0])
      for (let i = 1; i < ordered.length && result.size > 0; i++) {
        result = new Set([...result].filter((id) => ordered[i].has(id)))
      }
    }
  } else {
    // Empty OR = identity (nothing). Otherwise union.
    result = new Set<string>()
    for (const s of childSets) for (const id of s) result.add(id)
  }

  if (opts.negate) {
    result = new Set([...opts.universe].filter((id) => !result.has(id)))
  }
  return result
}

// ── Leaf predicate mapping (condition → PostgREST) ───────────────────────────

/** Strip characters that would break a manual PostgREST filter string
 *  (`(a,b)` in-lists). PostgREST's own `.in()` array encoding is safe, so this
 *  only guards the hand-built `not_in` list. */
function sanitizeInValue(v: unknown): string {
  return String(v).replace(/[,()"]/g, '').trim()
}

/**
 * Apply a single leaf condition to a `leads` query builder. Column-backed
 * fields map their operator to the matching PostgREST method; `service_line`
 * is derived, not a column, so it applies the shared serviceLineOrFilter `.or()`
 * group. `conversation_activity` is NOT handled here — it resolves against the
 * messages table (see resolveLeaf) — passing it is a no-op.
 *
 * Returns the (chained) query. Assumes the condition already validated against
 * filterNodeSchema; unknown fields are ignored defensively.
 */
export function applyLeafPredicate<Q>(query: Q, condition: FilterCondition): Q {
  const def = FILTER_FIELDS[condition.field]
  if (!def) return query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = query as any
  const { operator, value } = condition

  // Derived treatment line: an .or() group over intake signals, not a column.
  if (condition.field === 'service_line') {
    if (typeof value === 'string') {
      const orGroup = serviceLineOrFilter(value)
      if (orGroup) q = q.or(orGroup)
    }
    return q as Q
  }

  const col = def.column
  if (!col) return q as Q // special field with no column predicate (e.g. conversation_activity)

  switch (operator) {
    case 'in':
      q = q.in(col, value as unknown[])
      break
    case 'not_in':
      q = q.not(col, 'in', `(${(value as unknown[]).map(sanitizeInValue).join(',')})`)
      break
    case 'eq':
      q = q.eq(col, value)
      break
    case 'neq':
      q = q.neq(col, value)
      break
    case 'gte':
      q = q.gte(col, value)
      break
    case 'lte':
      q = q.lte(col, value)
      break
    case 'between': {
      const [min, max] = value as [unknown, unknown]
      q = q.gte(col, min).lte(col, max)
      break
    }
    case 'after':
      q = q.gte(col, value)
      break
    case 'before':
      q = q.lte(col, value)
      break
    case 'contains':
      q = q.ilike(col, `%${value}%`)
      break
    case 'is_null':
      q = q.is(col, null)
      break
    case 'not_null':
      q = q.not(col, 'is', null)
      break
  }
  return q as Q
}

// ── Pruning (drop half-built conditions before validate/save) ────────────────

/** True if a leaf condition carries a usable value for its operator. */
function conditionIsComplete(cond: FilterCondition): boolean {
  if (cond.operator === 'is_null' || cond.operator === 'not_null') return true
  const v = cond.value
  if (v === undefined || v === null) return false
  if (cond.operator === 'in' || cond.operator === 'not_in') return Array.isArray(v) && v.length > 0
  if (cond.operator === 'between') {
    return Array.isArray(v) && v.length === 2 && v.every((x) => x !== '' && x !== null && x !== undefined)
  }
  return v !== ''
}

/**
 * Drop incomplete conditions and any group left empty, returning a clean tree
 * or null when nothing usable remains. Lets the builder emit a partially-filled
 * UI state without producing an invalid `criteria.filter`.
 */
export function pruneFilterTree(node: FilterNode): FilterNode | null {
  if (node.type === 'condition') return conditionIsComplete(node) ? node : null
  const children = node.children
    .map(pruneFilterTree)
    .filter((c): c is FilterNode => c !== null)
  if (children.length === 0) return null
  return { ...node, children }
}

// ── Async resolution (tree → matching lead IDs) ──────────────────────────────

/** Per-leaf row cap. A leaf that would match more leads than this is truncated;
 *  callers combine leaves in memory, so this bounds worst-case memory/latency. */
const LEAF_ROW_CAP = 5000
/** Message rows scanned for a conversation-activity window (many per lead). */
const MESSAGE_ROW_CAP = 20000
/** Universe cap — the candidate pool a NOT is complemented against. */
const UNIVERSE_CAP = 20000

type ResolveLeaf = (condition: FilterCondition) => Promise<Set<string>>

/**
 * Walk a filter tree to the set of matching lead IDs, using an injected leaf
 * resolver. Pure orchestration (recursion + combine + negate) — no I/O of its
 * own, which keeps it unit-testable. `resolveFilterTree` supplies the real,
 * DB-backed leaf resolver.
 */
export async function walkFilterTree(
  node: FilterNode,
  ctx: { universe: Set<string>; resolveLeaf: ResolveLeaf }
): Promise<Set<string>> {
  if (node.type === 'condition') return ctx.resolveLeaf(node)
  const childSets = await Promise.all(node.children.map((c) => walkFilterTree(c, ctx)))
  return combineSets(node.op, childSets, { negate: node.negate, universe: ctx.universe })
}

/** True if any group in the tree is negated (⇒ we need the candidate universe). */
function treeHasNegate(node: FilterNode): boolean {
  if (node.type === 'condition') return false
  return node.negate === true || node.children.some(treeHasNegate)
}

/** Resolve a single leaf condition to matching lead IDs (org-scoped). */
async function resolveLeaf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  organizationId: string,
  condition: FilterCondition
): Promise<Set<string>> {
  const ids = new Set<string>()

  // Conversation activity: filter by message timestamps, not a leads column.
  if (condition.field === 'conversation_activity') {
    let q = supabase
      .from('messages')
      .select('lead_id')
      .eq('organization_id', organizationId)
    const v = condition.value
    if (condition.operator === 'after') q = q.gte('created_at', v)
    else if (condition.operator === 'before') q = q.lte('created_at', v)
    else if (condition.operator === 'between') {
      const [min, max] = v as [unknown, unknown]
      q = q.gte('created_at', min).lte('created_at', max)
    }
    const { data } = await q.limit(MESSAGE_ROW_CAP)
    for (const r of data || []) {
      const id = (r as { lead_id: string | null }).lead_id
      if (id) ids.add(id)
    }
    return ids
  }

  // Column-backed (and service_line): filter the leads table directly.
  let q = supabase
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
  q = applyLeafPredicate(q, condition)
  const { data } = await q.limit(LEAF_ROW_CAP)
  for (const r of data || []) ids.add((r as { id: string }).id)
  return ids
}

/** Fetch the org's candidate universe (all lead IDs, capped) for complementing
 *  negated groups. Only called when the tree actually contains a NOT. */
async function fetchUniverse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  organizationId: string
): Promise<Set<string>> {
  const { data } = await supabase
    .from('leads')
    .select('id')
    .eq('organization_id', organizationId)
    .limit(UNIVERSE_CAP)
  return new Set((data || []).map((r: { id: string }) => r.id))
}

/**
 * Resolve an advanced filter tree to the set of matching lead IDs for an org.
 * The universe (for NOT/complement) is fetched only when the tree contains a
 * negated group. Returns lead IDs; callers intersect with any other criteria.
 */
export async function resolveFilterTree(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  organizationId: string,
  node: FilterNode
): Promise<Set<string>> {
  const universe = treeHasNegate(node)
    ? await fetchUniverse(supabase, organizationId)
    : new Set<string>()
  return walkFilterTree(node, {
    universe,
    resolveLeaf: (c) => resolveLeaf(supabase, organizationId, c),
  })
}
