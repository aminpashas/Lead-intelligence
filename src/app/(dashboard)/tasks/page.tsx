import { ListTodo } from 'lucide-react'
import { TasksList } from './tasks-list'

export const metadata = {
  title: 'Tasks | Lead Intelligence',
}

/**
 * Human task lane (Workstream D2) — work the allocation policies routed to
 * humans instead of the AI: inbound replies, first touches, recommendations.
 */
export default function TasksPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <ListTodo className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
          <h1 className="text-2xl font-bold text-aurea-ink">Tasks</h1>
        </div>
        <p className="text-sm text-aurea-ink-2">
          Work allocated to your team by automation policy — replies, first touches, and
          recommendations the AI stood down on.
        </p>
      </div>

      <TasksList />
    </div>
  )
}
