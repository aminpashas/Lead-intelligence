/**
 * A live task is "possibly moot" when the lead has been worked since the task
 * was created and nobody has confirmed the task since that work.
 *
 * Two conditions, both required:
 *   1. lastContactedAt > task.created_at  — the lead was contacted after the
 *      task was minted.
 *   2. task.reviewed_at is null OR reviewed_at < lastContactedAt — no human has
 *      confirmed the task since that contact.
 *
 * `lastContactedAt` is leads.last_contacted_at, which in this project means a
 * real conversation, not a dial attempt — so a task is never questioned just
 * because someone let the phone ring. Pure and render-time; nothing is stored.
 */
export function isPossiblyMoot(
  task: { created_at: string; reviewed_at: string | null },
  lastContactedAt: string | null
): boolean {
  if (!lastContactedAt) return false
  const contacted = new Date(lastContactedAt).getTime()
  if (!(contacted > new Date(task.created_at).getTime())) return false
  if (task.reviewed_at && new Date(task.reviewed_at).getTime() >= contacted) return false
  return true
}
