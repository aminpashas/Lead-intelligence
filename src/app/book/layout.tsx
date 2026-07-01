import { aureaFontVars } from '@/lib/fonts'

// Public booking page — Aurea editorial scope + fonts so the hosted booking
// experience matches the brand. (An external <script> embed on a practice's
// own site won't inherit this scope; the hosted /book route does.)
export default function BookLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`aurea aurea-floor min-h-screen ${aureaFontVars}`}>
      {children}
    </div>
  )
}
