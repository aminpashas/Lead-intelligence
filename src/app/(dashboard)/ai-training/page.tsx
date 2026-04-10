import { AITrainingCenter } from '@/components/ai-training/training-center'

export default function AITrainingPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">AI Training Center</h1>
        <p className="text-muted-foreground">
          Test conversations, manage training memories, and build your knowledge base
        </p>
      </div>

      <AITrainingCenter />
    </div>
  )
}
