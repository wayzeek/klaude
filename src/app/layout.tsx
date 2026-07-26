/**
 * =============================================================================
 * ROOT LAYOUT
 * =============================================================================
 *
 * Wraps all pages with HTML structure, fonts, and global styles.
 */

import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { DEFAULT_THEME, themeBootScript } from '@/lib/theme'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'moltek',
  description:
    'A live coding music studio that hears itself. Strudel, driven by an agent that records its own output and fixes the mix.',
  applicationName: 'moltek',
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'moltek',
    description: 'A live coding music studio that hears itself.',
    siteName: 'moltek',
    type: 'website',
    images: ['/moltek.png'],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script below deliberately rewrites
    // data-theme before React hydrates, so server and client markup differ by
    // design. Scoped to this one element.
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint. Without it every reload
            flashes the default until hydration catches up.

            dangerouslySetInnerHTML is the only way to get a script to run this
            early, and it is safe here: themeBootScript is a build-time constant
            built from the checked-in theme list, with no user input reaching it.
            The value it reads from localStorage is validated against that list
            before use, so a hand-edited key cannot inject anything either. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  )
}
