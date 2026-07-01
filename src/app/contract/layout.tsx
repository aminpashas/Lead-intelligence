import { aureaFontVars } from '@/lib/fonts'

// Patient-facing contract e-signing — Aurea editorial scope so the agreement
// reads as a calm, premium, trustworthy document. Tokens flip light ⇄ dark.
export default function ContractLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`aurea aurea-floor min-h-screen ${aureaFontVars}`}>
      {children}
    </div>
  )
}
