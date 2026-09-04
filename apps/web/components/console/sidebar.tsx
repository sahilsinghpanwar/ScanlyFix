'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { LogoBadge } from '@/components/brand/logo.tsx'
import { SignOutButton } from '@/components/auth/sign-out-button.tsx'
import { Icon } from './icons.tsx'
import { NAV, type NavItem } from './nav.ts'

/**
 * The console's left rail, in the Vercel style: a light surface that borders
 * itself against the page with a hairline, instead of the old dark slab.
 *
 * The rail is built ONLY from the `c-` tokens — never a raw white/15 or amber
 * against an assumed-dark ground — because it must theme with the rest of the
 * console (see lib/theme.ts). A token reads correctly in both modes by
 * construction; a hardcoded tint reads correctly in exactly one.
 *
 * A client component for one reason: `usePathname`, so the active row is
 * decided in the browser and the rail does not re-render from the server on
 * every navigation. Everything it displays is passed in as props from the
 * layout, which is where the session and the counts are read — the sidebar
 * itself queries nothing.
 *
 * On narrow screens it collapses behind a button rather than shrinking to
 * icons. A 260px rail on a 375px viewport leaves no room for the page it is
 * navigating, and icon-only navigation is unreadable for exactly the items
 * that are hardest to name.
 */
export function Sidebar({
  email,
  plan,
  sites,
  scans,
}: {
  email: string
  plan: string
  sites: number
  scans: number
}) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const counts = { sites, scans }

  const rail = (
    <div className="console flex h-full flex-col gap-6 overflow-hidden border-r border-c-line bg-c-side px-4 py-5 text-c-side-ink">
      <div className="flex items-center gap-2.5">
        <LogoBadge size={34} />
        <span className="text-[15px] font-semibold tracking-tight">ScanlyFix</span>
        <span className="ml-auto rounded-md border border-c-line bg-c-card px-2 py-0.5 text-[11px] font-medium capitalize text-c-muted">
          {plan}
        </span>
      </div>

      {/*
        The account row. It is a button rather than a select because there is
        exactly one account per session today — pressing it goes to the place
        that will grow the switcher, instead of pretending to offer a choice
        that does not exist.
      */}
      <Link
        href="/settings/billing"
        className="flex items-center gap-2.5 rounded-lg border border-c-line bg-c-card px-3 py-2.5
                   transition-colors hover:bg-c-soft"
      >
        <span
          className="grid h-6 w-6 place-items-center rounded-md bg-c-brand text-[11px] font-semibold text-c-brand-ink"
          aria-hidden="true"
        >
          {email.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {email.split('@')[0]}
        </span>
        <Icon name="settings" size={14} className="text-c-side-dim" />
      </Link>

      <nav aria-label="Console" className="flex flex-1 flex-col gap-5">
        {NAV.map((section) => (
          <div key={section.title ?? 'main'} className="flex flex-col gap-0.5">
            {section.title && (
              <h2 className="px-3 pb-1.5 text-[12px] font-medium text-c-side-dim">
                {section.title}
              </h2>
            )}
            {section.items.map((item) => (
              <Row
                key={item.label}
                item={item}
                active={item.href === pathname}
                count={item.count ? counts[item.count] : undefined}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-3">
        <Link
          href="/settings/billing"
          className="flex h-9 items-center justify-center rounded-lg bg-c-brand px-5 text-[13px]
                     font-medium text-c-brand-ink transition-opacity hover:opacity-90"
        >
          Upgrade plan
        </Link>
        <div className="flex items-center gap-2.5 border-t border-c-line pt-3">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-c-soft text-xs font-semibold text-c-ink"
            aria-hidden="true"
          >
            {email.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-c-side-dim" title={email}>
            {email}
          </span>
          <SignOutButton className="text-[12px] text-c-side-dim underline-offset-2 hover:text-c-side-ink hover:underline" />
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile opener. Hidden from the desktop layout, which shows the rail. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="fixed left-3 top-3 z-40 grid h-10 w-10 place-items-center rounded-lg border border-c-line
                   bg-c-card text-c-ink shadow-sm lg:hidden"
      >
        <span className="sr-only">Open navigation</span>
        <span aria-hidden="true" className="text-lg leading-none">
          ☰
        </span>
      </button>

      <aside className="sticky top-0 hidden h-dvh w-[260px] shrink-0 overflow-hidden lg:block">
        {rail}
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div className="absolute inset-y-0 left-0 w-[264px] bg-c-side shadow-2xl">{rail}</div>
        </div>
      )}
    </>
  )
}

/**
 * One nav row, in one of three states.
 *
 * `soon` is deliberately NOT a disabled link. A disabled `<a>` is still
 * focusable in some browsers and still reads as a link to a screen reader; a
 * `<span>` with the badge beside it says the same thing to everybody.
 */
function Row({
  item,
  active,
  count,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  count?: number
  onNavigate: () => void
}) {
  const base =
    'flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors'

  if (item.soon) {
    return (
      <span className={`${base} cursor-default text-c-side-dim/70`}>
        <Icon name={item.icon} />
        <span className="flex-1">{item.label}</span>
        <span className="rounded-md border border-c-line px-1.5 py-px text-[10px] uppercase tracking-wide">
          Soon
        </span>
      </span>
    )
  }

  return (
    <Link
      href={item.href ?? '#'}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`${base} ${
        active
          ? 'bg-c-side-active text-c-side-ink'
          : 'text-c-side-dim hover:bg-c-soft hover:text-c-side-ink'
      }`}
    >
      <Icon name={item.icon} />
      <span className="flex-1">{item.label}</span>
      {count !== undefined && count > 0 && (
        <span className="console-num rounded-md border border-c-line bg-c-card px-1.5 py-px text-[11px] text-c-muted">
          {count}
        </span>
      )}
    </Link>
  )
}
