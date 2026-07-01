import { Inter, Manrope, Instrument_Serif } from 'next/font/google'

// Aurea Health's real type system — shared by the agency console and the
// practice dashboard. Instrument Serif for editorial display, Inter + Manrope
// for UI text. Applied as CSS variables on the `.aurea`-scoped shell roots.
export const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
export const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' })
export const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-instrument-serif',
  display: 'swap',
})

export const aureaFontVars = `${inter.variable} ${manrope.variable} ${instrumentSerif.variable}`
