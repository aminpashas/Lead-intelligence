import { GraduationCap } from 'lucide-react'
import { AITrainingCenter } from '@/components/ai-training/training-center'

export const metadata = {
  title: 'AI Training | Agency | Lead Intelligence',
}

export default function AgencyAiTrainingPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <GraduationCap className="h-5 w-5 text-aurea-primary" />
          <h1 className="text-2xl font-bold text-aurea-ink">AI Training</h1>
        </div>
        <p className="text-aurea-ink-2 text-sm">
          Role-play arena, chat playground, memory manager, and knowledge base — agency IP, not visible to practices.
        </p>
      </div>

      {/* Full interactive training center */}
      <AITrainingCenter />
    </div>
  )
}
