import { aureaFontVars } from '@/lib/fonts'

export const dynamic = 'force-dynamic'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Bring the auth screens into the Aurea editorial scope: stone-white floor,
  // zinc ink, emerald accent, Instrument Serif — the same system as the app.
  return (
    <div className={`aurea aurea-floor min-h-screen ${aureaFontVars}`}>
      {children}
    </div>
  )
}
