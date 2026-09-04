import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono, Inter } from 'next/font/google'
import Script from 'next/script'
import { themeInitScript } from '@/lib/theme.ts'
import './globals.css'

/**
 * Self-hosted at build time by next/font, so the page makes no request to a
 * third party for its own typeface. That matters more here than elsewhere:
 * this product's own compliance pillar flags trackers that load before
 * consent, and a landing page phoning Google for a font would fail its own
 * check.
 *
 * Three families, for three jobs. Monospace is the product's voice everywhere a
 * machine is being quoted — the hero, the report, the marketing pages. Geist
 * (and Inter behind it, should Geist ever fail to load) is scoped to the
 * signed-in console (see the `.console` block in globals.css), which is scanned
 * rather than read and needs a face built for dense UI.
 *
 * Declaring the variable here costs nothing on the pages that do not use it: a
 * browser downloads a font file only when something rendered actually asks for
 * that family, so the landing page still ships one webfont.
 */
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' })
const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' })
const sansFallback = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL(process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'),
  title: {
    default: 'ScanlyFix — everything wrong with your website, and the prompt that fixes it',
    template: '%s · ScanlyFix',
  },
  description:
    'Paste a URL and get 63 read-only checks across security, SEO, AI answer engines, performance, ' +
    'accessibility and compliance — each with the evidence observed and a fix prompt for your AI ' +
    'coding agent. Scanning is free.',
  openGraph: {
    type: 'website',
    siteName: 'ScanlyFix',
    title: 'Everything wrong with your website — and the prompt that fixes it',
    description:
      '63 read-only checks across security, SEO, AI answer engines, performance, accessibility and ' +
      'compliance. Every finding shows the evidence behind it.',
    images: [
      {
        url: '/og-image.png',
        width: 1202,
        height: 628,
        alt: 'ScanlyFix — everything wrong with your website, and the prompt that fixes it',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-image.png'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

/**
 * Deliberately reads nothing per-request — no cookies, no session, no identity.
 *
 * Convex Auth's server provider belongs BELOW this, in the (auth) and (app)
 * layouts, because it calls `cookies()` and anything under a component that
 * does is rendered dynamically. Mounted here it turned the landing page and
 * the pricing page — the two a stranger sees first, both statically
 * prerendered — into a server render on every view, to read a cookie neither
 * of them consults.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable} ${sansFallback.variable}`}>
      <head>
        {/*
         * Runs synchronously before first paint, so the resolved theme class
         * is on <html> before anything is drawn — this is the anti-FOUC
         * guarantee. It must stay a plain inline <script>: next/script's
         * strategies all defer past paint, which is exactly the flash we are
         * preventing.
         */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Script async src="https://www.googletagmanager.com/gtag/js?id=G-FWCPZRBYKE" />
        <Script id="google-analytics">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-FWCPZRBYKE');
          `}
        </Script>
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
