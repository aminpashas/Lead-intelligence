// Sidebar collapsed preference — shared between the client sidebar and the
// server dashboard layout. Plain module (no 'use client') so the layout can
// import the inline script without pulling in a client reference.

export const SIDEBAR_COLLAPSED_KEY = 'li:sidebar-collapsed'
export const SIDEBAR_COLLAPSED_ATTR = 'data-sidebar-collapsed'

// Rendered as an inline <script> ahead of the dashboard shell so it runs
// before the sidebar's server-rendered markup paints. It stamps the collapsed
// preference on <html>; CSS in globals.css uses that attribute to clamp the
// (expanded) server markup to the rail width until React hydrates and renders
// the collapsed state for real. The markup itself is never changed, so there
// is no hydration mismatch — <html> carries suppressHydrationWarning already.
export const SIDEBAR_COLLAPSED_PREHYDRATION_SCRIPT =
  `try{if(localStorage.getItem('${SIDEBAR_COLLAPSED_KEY}')==='1')` +
  `document.documentElement.setAttribute('${SIDEBAR_COLLAPSED_ATTR}','')}catch(e){}`
