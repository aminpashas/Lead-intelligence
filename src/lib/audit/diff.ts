type Row = Record<string, unknown> | null | undefined

export function computeChangedFields(before: Row, after: Row): string[] {
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) changed.push(key)
  }
  return changed
}
