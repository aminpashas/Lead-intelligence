'use client'

/**
 * Advanced Filter Builder — a recursive AND/OR query builder over the shared
 * FILTER_FIELDS registry. Emits a FilterNode tree (see src/lib/campaigns/
 * filter-tree.ts) that the Smart List criteria and the Leads-page search both
 * consume. The UI is fully data-driven: the field picker lists the registry,
 * the operator picker follows the selected field, and the value editor switches
 * on the field's kind + operator — so a new registry field needs no new JSX.
 */

import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2, FolderPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FILTER_FIELDS, type FilterFieldDef, type FilterNode, type FilterGroup,
  type FilterCondition, type FilterOperator,
} from '@/lib/campaigns/filter-tree'
import { SERVICE_LINES } from '@/lib/leads/service-line'
import type { PipelineStage } from '@/types/database'

// ── Option sources for enum-ish fields (mirrors the flat SmartListBuilder) ────

const FIELD_OPTIONS: Record<string, string[]> = {
  status: [
    'new', 'contacted', 'qualified', 'consultation_scheduled', 'consultation_completed',
    'treatment_presented', 'financing', 'contract_sent', 'contract_signed', 'scheduled',
    'in_treatment', 'completed', 'lost', 'disqualified', 'no_show', 'unresponsive',
  ],
  ai_qualification: ['hot', 'warm', 'cold', 'unqualified'],
  engagement_temperature: ['hot', 'warm', 'cooling', 'cold', 'new'],
  source_type: [
    'google_ads', 'meta_ads', 'website_form', 'landing_page', 'referral',
    'walk_in', 'phone', 'email_campaign', 'sms_campaign', 'other',
  ],
  conversation_intent: ['ready_to_book', 'considering', 'exploring', 'resistant', 'disengaged'],
  conversation_sentiment: ['positive', 'neutral', 'mixed', 'negative'],
  primary_objection: [
    'cost', 'financing', 'fear_anxiety', 'timing', 'trust',
    'medical', 'logistics', 'spouse_approval', 'none', 'other',
  ],
  closing_temperature: ['deliberating', 'committed', 'stalled'],
  service_line: SERVICE_LINES.map((s) => s.key),
}

// Human-friendly operator labels. Base UI Select renders the raw value in the
// trigger otherwise (see the Select raw-value gotcha), so we always map.
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  in: 'is any of',
  not_in: 'is none of',
  eq: 'is',
  neq: 'is not',
  gte: '≥',
  lte: '≤',
  between: 'between',
  after: 'on or after',
  before: 'on or before',
  contains: 'contains',
  is_null: 'is empty',
  not_null: 'is set',
}

// Registry fields grouped for the picker, in presentation order.
const FIELD_GROUPS: { label: string; fields: string[] }[] = [
  { label: 'Pipeline', fields: ['status', 'ai_qualification', 'stage_id', 'engagement_temperature', 'closing_temperature', 'is_existing_patient'] },
  { label: 'Scores & value', fields: ['ai_score', 'engagement_score', 'treatment_value'] },
  { label: 'Demographics', fields: ['age', 'preferred_language'] },
  { label: 'Location', fields: ['city', 'state', 'zip_code', 'distance_to_practice_miles'] },
  { label: 'Treatment', fields: ['service_line'] },
  { label: 'Conversation', fields: ['conversation_intent', 'conversation_sentiment', 'primary_objection', 'conversation_activity'] },
  { label: 'Source', fields: ['source_type'] },
  { label: 'Dates', fields: ['created_at', 'last_contacted_at', 'last_responded_at', 'consultation_date'] },
]

const FIELD_LABEL_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(FILTER_FIELDS).map(([k, d]) => [k, d.label])
)

// ── Public API ────────────────────────────────────────────────────────────────

export interface AdvancedFilterBuilderProps {
  value: FilterNode | null
  onChange: (next: FilterNode | null) => void
  stages?: PipelineStage[]
}

/** Default operator + empty value for a freshly-picked field. */
function defaultConditionFor(field: string): FilterCondition {
  const def = FILTER_FIELDS[field]
  const operator = def.operators[0]
  return { type: 'condition', field, operator, value: emptyValueFor(def, operator) }
}

function emptyValueFor(def: FilterFieldDef, operator: FilterOperator): unknown {
  if (operator === 'is_null' || operator === 'not_null') return undefined
  if (operator === 'in' || operator === 'not_in') return []
  if (operator === 'between') return def.kind === 'number' ? [0, 0] : ['', '']
  if (def.kind === 'number') return 0
  return ''
}

export function AdvancedFilterBuilder({ value, onChange, stages = [] }: AdvancedFilterBuilderProps) {
  if (!value || value.type !== 'group') {
    return (
      <button
        type="button"
        onClick={() => onChange({ type: 'group', op: 'and', children: [defaultConditionFor('status')] })}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-aurea-border-strong bg-aurea-surface px-3 py-2 text-[13px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2"
      >
        <Plus className="h-[15px] w-[15px]" strokeWidth={1.75} />
        Add advanced filter (AND / OR)
      </button>
    )
  }

  return (
    <GroupEditor
      group={value}
      stages={stages}
      onChange={(g) => onChange(g)}
      onRemove={() => onChange(null)}
      depth={0}
    />
  )
}

// ── Group editor (recursive) ──────────────────────────────────────────────────

function GroupEditor({
  group, stages, onChange, onRemove, depth,
}: {
  group: FilterGroup
  stages: PipelineStage[]
  onChange: (g: FilterGroup) => void
  onRemove: () => void
  depth: number
}) {
  const setChild = (i: number, child: FilterNode) => {
    const children = group.children.slice()
    children[i] = child
    onChange({ ...group, children })
  }
  const removeChild = (i: number) => {
    const children = group.children.filter((_, idx) => idx !== i)
    // Removing the last child of a nested group removes the group itself.
    if (children.length === 0 && depth > 0) { onRemove(); return }
    onChange({ ...group, children })
  }
  const addCondition = () =>
    onChange({ ...group, children: [...group.children, defaultConditionFor('status')] })
  const addGroup = () =>
    onChange({
      ...group,
      children: [...group.children, { type: 'group', op: 'or', children: [defaultConditionFor('status')] }],
    })

  return (
    <div
      className={cn(
        'space-y-2 rounded-xl border p-3',
        depth === 0 ? 'border-aurea-border bg-aurea-surface' : 'border-aurea-border-strong bg-aurea-surface-2'
      )}
    >
      {/* Group header: match toggle + negate + remove */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-aurea-ink-3">Match</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
          {(['and', 'or'] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ ...group, op })}
              className={cn(
                'px-2.5 py-1 text-[12px] font-semibold uppercase transition-colors',
                group.op === op
                  ? 'bg-aurea-primary/10 text-aurea-primary'
                  : 'bg-transparent text-aurea-ink-3 hover:bg-aurea-surface-2'
              )}
            >
              {op}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-aurea-ink-3">of the following</span>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-aurea-ink-3">
            <Switch checked={group.negate ?? false} onCheckedChange={(v) => onChange({ ...group, negate: v })} />
            NOT
          </label>
          {depth > 0 && (
            <button
              type="button"
              onClick={onRemove}
              className="text-aurea-ink-3 transition-colors hover:text-aurea-rose"
              aria-label="Remove group"
            >
              <Trash2 className="h-[15px] w-[15px]" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Children */}
      <div className="space-y-2">
        {group.children.map((child, i) => (
          <div key={i}>
            {child.type === 'group' ? (
              <GroupEditor
                group={child}
                stages={stages}
                onChange={(g) => setChild(i, g)}
                onRemove={() => removeChild(i)}
                depth={depth + 1}
              />
            ) : (
              <ConditionEditor
                condition={child}
                stages={stages}
                onChange={(c) => setChild(i, c)}
                onRemove={() => removeChild(i)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Add controls */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={addCondition}
          className="inline-flex items-center gap-1 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2"
        >
          <Plus className="h-[13px] w-[13px]" strokeWidth={1.75} /> Condition
        </button>
        {depth < 3 && (
          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-1 rounded-md border border-aurea-border bg-aurea-surface px-2 py-1 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2"
          >
            <FolderPlus className="h-[13px] w-[13px]" strokeWidth={1.75} /> Group
          </button>
        )}
      </div>
    </div>
  )
}

// ── Condition editor ──────────────────────────────────────────────────────────

function ConditionEditor({
  condition, stages, onChange, onRemove,
}: {
  condition: FilterCondition
  stages: PipelineStage[]
  onChange: (c: FilterCondition) => void
  onRemove: () => void
}) {
  const def = FILTER_FIELDS[condition.field]
  const operatorItems = useMemo(
    () => Object.fromEntries(def.operators.map((op) => [op, OPERATOR_LABELS[op]])),
    [def]
  )

  const pickField = (field: string | null) => {
    if (field && FILTER_FIELDS[field]) onChange(defaultConditionFor(field))
  }
  const pickOperator = (operator: string | null) => {
    if (!operator) return
    const op = operator as FilterOperator
    onChange({ ...condition, operator: op, value: emptyValueFor(def, op) })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface px-2.5 py-2">
      {/* Field */}
      <Select items={FIELD_LABEL_MAP} value={condition.field} onValueChange={pickField}>
        <SelectTrigger className="h-8 min-w-[160px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {FIELD_GROUPS.map((grp) => (
            <div key={grp.label}>
              <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-aurea-ink-3">
                {grp.label}
              </div>
              {grp.fields.map((f) => (
                <SelectItem key={f} value={f}>{FILTER_FIELDS[f].label}</SelectItem>
              ))}
            </div>
          ))}
        </SelectContent>
      </Select>

      {/* Operator */}
      <Select items={operatorItems} value={condition.operator} onValueChange={pickOperator}>
        <SelectTrigger className="h-8 min-w-[110px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          {def.operators.map((op) => (
            <SelectItem key={op} value={op}>{OPERATOR_LABELS[op]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value */}
      <div className="min-w-[180px] flex-1">
        <ValueEditor
          def={def}
          condition={condition}
          stages={stages}
          onChange={(value) => onChange({ ...condition, value })}
        />
      </div>

      <button
        type="button"
        onClick={onRemove}
        className="text-aurea-ink-3 transition-colors hover:text-aurea-rose"
        aria-label="Remove condition"
      >
        <Trash2 className="h-[15px] w-[15px]" strokeWidth={1.75} />
      </button>
    </div>
  )
}

// ── Value editors (per kind + operator) ───────────────────────────────────────

function ValueEditor({
  def, condition, stages, onChange,
}: {
  def: FilterFieldDef
  condition: FilterCondition
  stages: PipelineStage[]
  onChange: (value: unknown) => void
}) {
  const { operator, value, field } = condition

  if (operator === 'is_null' || operator === 'not_null') return null

  // Multi-select (in / not_in)
  if (operator === 'in' || operator === 'not_in') {
    const selected = Array.isArray(value) ? (value as string[]) : []
    // stage_id → chips from live stages; enum fields → known options; else freeform.
    if (field === 'stage_id') {
      return (
        <ChipMultiSelect
          options={stages.map((s) => ({ value: s.id, label: s.name, color: s.color }))}
          selected={selected}
          onChange={onChange}
        />
      )
    }
    const options = FIELD_OPTIONS[field]
    if (options) {
      return (
        <ChipMultiSelect
          options={options.map((o) => ({ value: o, label: o.replace(/_/g, ' ') }))}
          selected={selected}
          onChange={onChange}
        />
      )
    }
    return <TokenInput values={selected} onChange={onChange} placeholder="Type value, Enter" />
  }

  // service_line is single-select eq
  if (field === 'service_line') {
    const items = Object.fromEntries(SERVICE_LINES.map((s) => [s.key, s.label]))
    return (
      <Select items={items} value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full"><SelectValue placeholder="Pick a treatment" /></SelectTrigger>
        <SelectContent>
          {SERVICE_LINES.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
        </SelectContent>
      </Select>
    )
  }

  // enum single-value eq/neq
  if ((operator === 'eq' || operator === 'neq') && FIELD_OPTIONS[field]) {
    const opts = FIELD_OPTIONS[field]
    const items = Object.fromEntries(opts.map((o) => [o, o.replace(/_/g, ' ')]))
    return (
      <Select items={items} value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full"><SelectValue placeholder="Pick a value" /></SelectTrigger>
        <SelectContent>
          {opts.map((o) => <SelectItem key={o} value={o}>{o.replace(/_/g, ' ')}</SelectItem>)}
        </SelectContent>
      </Select>
    )
  }

  const isDate = def.kind === 'date' || field === 'conversation_activity'
  const inputType = isDate ? 'date' : def.kind === 'number' ? 'number' : 'text'
  const coerce = (raw: string): unknown => (def.kind === 'number' ? Number(raw) : raw)

  // between → two inputs
  if (operator === 'between') {
    const pair = Array.isArray(value) ? (value as [unknown, unknown]) : ['', '']
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type={inputType}
          value={String(pair[0] ?? '')}
          onChange={(e) => onChange([coerce(e.target.value), pair[1]])}
          className="h-8"
        />
        <span className="text-[12px] text-aurea-ink-3">to</span>
        <Input
          type={inputType}
          value={String(pair[1] ?? '')}
          onChange={(e) => onChange([pair[0], coerce(e.target.value)])}
          className="h-8"
        />
      </div>
    )
  }

  // scalar (eq/neq/gte/lte/after/before/contains)
  return (
    <Input
      type={inputType}
      value={String(value ?? '')}
      onChange={(e) => onChange(coerce(e.target.value))}
      placeholder={operator === 'contains' ? 'contains…' : ''}
      className="h-8"
    />
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────

function ChipMultiSelect({
  options, selected, onChange,
}: {
  options: { value: string; label: string; color?: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = selected.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors',
              active
                ? 'border-aurea-primary/30 bg-aurea-primary/10 text-aurea-primary'
                : 'border-aurea-border bg-aurea-surface text-aurea-ink-3 hover:bg-aurea-surface-2'
            )}
          >
            {o.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: o.color }} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function TokenInput({
  values, onChange, placeholder,
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(values.filter((x) => x !== v))}
          className="inline-flex items-center gap-1 rounded-full border border-aurea-primary/30 bg-aurea-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-aurea-primary"
        >
          {v} <span aria-hidden>×</span>
        </button>
      ))}
      <Input
        defaultValue=""
        onKeyDown={(e) => {
          const el = e.currentTarget
          if (e.key === 'Enter' && el.value.trim()) {
            e.preventDefault()
            const t = el.value.trim()
            if (!values.includes(t)) onChange([...values, t])
            el.value = ''
          }
        }}
        placeholder={placeholder}
        className="h-8 w-36"
      />
    </div>
  )
}
