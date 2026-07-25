/**
 * =============================================================================
 * ROOT LAYOUT
 * =============================================================================
 *
 * Wraps all pages with HTML structure, fonts, and global styles.
 */

import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
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
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  )
}
