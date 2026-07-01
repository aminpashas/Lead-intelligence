import Link from 'next/link'
import { GraduationCap, ArrowRight, Lock } from 'lucide-react'

export default function AiTrainingPracticePage() {
  return (
    <div className="animate-in fade-in-0 duration-500 flex flex-col items-center justify-center min-h-[60vh] text-center gap-8">
      <div className="h-16 w-16 rounded-2xl bg-aurea-surface-2 border border-aurea-border flex items-center justify-center">
        <Lock className="h-8 w-8 text-aurea-ink-3" strokeWidth={1.75} />
      </div>

      <div className="space-y-3">
        <p className="aurea-eyebrow">Access Restricted</p>
        <div className="flex items-center justify-center gap-2">
          <GraduationCap className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
          <h1 className="aurea-display text-[32px] text-aurea-ink">AI Training</h1>
        </div>
        <p className="text-aurea-ink-2 max-w-sm text-[15px] leading-relaxed">
          AI Training is managed at the agency level to protect intellectual property
          and ensure consistent quality across all practices.
        </p>
      </div>

      <div className="aurea-card max-w-sm w-full p-6 space-y-4">
        <p className="text-[13px] text-aurea-ink-2">
          To access AI Training data, roleplay sessions, and training examples,
          please log in to the Agency Control Panel.
        </p>
        <Link
          href="/login"
          className="flex items-center justify-center gap-2 w-full rounded-md bg-aurea-primary px-4 py-2 text-[13px] font-medium text-white hover:bg-aurea-primary/90 transition-colors"
        >
          Go to Agency Login <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  )
}
