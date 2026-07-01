import { aureaFontVars } from '@/lib/fonts'

// Patient-facing case portal — bring it into the Aurea editorial scope so the
// share link matches the practice's brand (stone floor, zinc ink, emerald,
// Instrument Serif). Tokens flip light ⇄ dark automatically.
export default function CaseLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`aurea aurea-floor min-h-screen ${aureaFontVars}`}>
      {children}
    </div>
  )
}
