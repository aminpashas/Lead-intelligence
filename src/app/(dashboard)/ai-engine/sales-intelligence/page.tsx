import { SalesIntelligenceDashboard } from '@/components/crm/sales-intelligence-dashboard'

export default function SalesIntelligencePage() {
  return (
    <div className="animate-in fade-in-0 duration-500">
      <header className="border-b border-aurea-border pb-8">
        <p className="aurea-eyebrow mb-3">AI Engine</p>
        <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Sales Intelligence</h1>
        <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
          Track which sales techniques the AI uses, their effectiveness, and how it adapts per lead.
        </p>
      </header>

      <div className="mt-10">
        <SalesIntelligenceDashboard />
      </div>
    </div>
  )
}
