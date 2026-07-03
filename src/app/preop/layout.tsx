import { aureaFontVars } from '@/lib/fonts'

// Patient-facing pre-op instructions portal — same Aurea editorial scope as
// the case and contract share-link pages.
export default function PreopLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`aurea aurea-floor min-h-screen ${aureaFontVars}`}>
      {children}
    </div>
  )
}
