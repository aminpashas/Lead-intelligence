import type { MetadataRoute } from 'next'

/**
 * Minimal web app manifest (Workstream D5).
 *
 * Present primarily so browsers treat the app as installable and so web push
 * notifications carry proper app identity. Served at /manifest.webmanifest.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lead Intelligence',
    short_name: 'Lead Intelligence',
    description: 'AI-native CRM and lead lifecycle platform',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      {
        // Served from src/app/favicon.ico by the App Router.
        src: '/favicon.ico',
        sizes: 'any',
        type: 'image/x-icon',
      },
    ],
  }
}
