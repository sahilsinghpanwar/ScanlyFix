import { Section, SectionHeading } from './section.tsx'
import { TOTAL_CHECKS } from '@/lib/pillars.ts'

/**
 * The FAQ, and the page's own answer-engine test.
 *
 * This product ships a check called `aeo.faq-howto-schema`, so a landing page
 * with a plain <details> list and no FAQPage markup would fail its own audit.
 * The JSON-LD below is generated from the same array that renders the visible
 * copy — two hand-maintained copies is how structured data ends up describing
 * a page that no longer exists.
 */

const QA: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Do I need an account?',
    a: 'To scan, yes \u2014 but a free one: a code to your email, no password to create. Sharing the result asks nothing more, though. A finished report lives at a public URL where anyone can see the score, the pillar breakdown and every finding\u2019s title and severity without signing in. Reading the findings themselves is what the account opens: each finding with the evidence behind it and the fix prompt that closes it.',
  },
  {
    q: 'Will this attack my site?',
    a: 'No. A scan is a read: it requests pages the way a browser and a crawler would, never logs in, never submits a form, and never changes state. The two checks that touch a backend run only on a domain you have verified you own.',
  },
  {
    q: 'How is this different from Lighthouse or an SEO audit?',
    a: `Lighthouse measures one page in a browser; an SEO tool reads the markup. This reads the response — headers, TLS, cookies, DNS, robots — across ${TOTAL_CHECKS} checks in six pillars, shows the raw value behind every claim, and ends in a prompt an AI coding agent can execute.`,
  },
  {
    q: 'What is the AI answer engines pillar?',
    a: 'Eight checks on whether an answer engine can read, resolve and cite your page: whether the text survives without JavaScript, whether AI crawlers are allowed, whether there is schema tying the page to a real entity, and whether anything dates the content. Search Console reports none of this.',
  },
  {
    q: 'Is there a free plan?',
    a: 'Yes. While we run end-to-end testing the free plan runs every check, opens every finding in full, and serves the prompt that fixes them. No credit card, no trial period.',
  },
  {
    q: 'Can I run it in CI or from my editor?',
    a: 'Yes. There is a CLI with JSON output, and ScanlyFix is an MCP server — point Claude Code or Cursor at it and the agent runs the scan and applies the fixes itself.',
  },
  {
    q: 'Why did my score change when I did not change anything?',
    a: 'It should not, and the engine is built so it cannot happen silently. Every scan records the engine version it was measured with, and no feature compares two scans across a change in it. If checks were added, coverage moved — and you are told so rather than emailed that your site got worse.',
  },
  {
    q: 'What happens if a check fails?',
    a: 'It is recorded as our error, not your finding, and the pillar it belongs to is marked provisional. A partly broken instrument is never presented as a measurement.',
  },
  {
    q: 'What do you store about me?',
    a: 'Almost nothing. Your email, the pillars you chose, and an opaque auth identifier. No name, no password, no phone number, no payment details \u2014 Razorpay holds those. Scans store the URL, scores, and findings. See the full list on the privacy page.',
  },
  {
    q: 'Do you share my data?',
    a: 'Only what each processor needs to do its job: Supabase stores it, Resend sends your alerts, Inngest runs scans, Razorpay handles billing. We do not sell data, run advertising, or place tracking cookies.',
  },
  {
    q: 'Can I delete my account?',
    a: 'Email us from the address on your account and everything is deleted within 30 days \u2014 account, scans, findings, monitors. You can also request a copy of what we hold.',
  },
]

/** Escaped so the payload can never close its own script tag. */
function jsonLd(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: QA.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  }).replace(/</g, '\\u003c')
}

export function Faq() {
  return (
    <Section id="faq">
      <SectionHeading index={8} eyebrow="Questions" title="Before you paste your domain" />

      <div className="mt-10 border-t border-line">
        {QA.map(({ q, a }) => (
          <details key={q} className="group border-b border-line">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-lg font-semibold tracking-tight">
              {q}
              <Chevron />
            </summary>
            <p className="max-w-[70ch] pb-5 text-[15px] leading-relaxed text-ink/70 text-pretty">{a}</p>
          </details>
        ))}
      </div>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd() }} />
    </Section>
  )
}

function Chevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0 text-muted transition-transform group-open:rotate-180"
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
