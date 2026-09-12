/**
 * Characterization tests for toDays() — uptime calculation
 *
 * Purpose: Capture CURRENT behavior as a safety net before refactoring.
 * This function groups uptime events into daily buckets for the status strip.
 *
 * Coverage:
 *   - UTC day grouping
 *   - Success/failure counting
 *   - Oldest-first ordering
 *   - Windowing (days parameter)
 *   - Serialized timestamps
 *   - Empty input
 *   - Mixed sequences
 *   - Boundary conditions
 *   - 90-day window always returns exactly N entries
 *   - Empty days stay visible in the window
 *   - summarize() / formatDowntime() / formatShortDate() helpers
 */

import { describe, expect, it } from 'vitest'
import { formatDowntime, formatShortDate, summarize, toDays, type UptimeDay } from '../components/monitors/uptime-days.ts'

// ─── Helper ───────────────────────────────────────────────────────────────────

const at = (iso: string, ok: boolean) => ({ ts: new Date(iso), ok })
const NOW = new Date()
const day = (offset: number) => {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

// ─── UTC day grouping ─────────────────────────────────────────────────────────

describe('toDays — UTC day grouping', () => {
  it('groups events on the same UTC day', () => {
    const days = toDays([
      at('2026-08-24T01:00:00Z', true),
      at('2026-08-24T23:00:00Z', true),
    ])
    expect(days.filter((d) => d.ok + d.failed > 0)).toEqual([
      { date: '2026-08-24', state: 'ok', ok: 2, failed: 0, downMs: 0 },
    ])
  })

  it('separates events across UTC midnight', () => {
    const days = toDays([
      at('2026-08-24T23:00:00Z', true),
      at('2026-08-25T01:00:00Z', true),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0)
    expect(active).toHaveLength(2)
    expect(active[0]?.date).toBe('2026-08-24')
    expect(active[1]?.date).toBe('2026-08-25')
  })

  it('handles events near UTC midnight correctly', () => {
    // 23:59:59 UTC and 00:00:01 UTC are different days
    const days = toDays([
      at('2026-08-24T23:59:59Z', true),
      at('2026-08-25T00:00:01Z', true),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0)
    expect(active).toHaveLength(2)
  })
})

// ─── Success/failure counting ─────────────────────────────────────────────────

describe('toDays — success/failure counting', () => {
  it('counts successes and failures separately', () => {
    const days = toDays([
      at('2026-08-24T01:00:00Z', true),
      at('2026-08-24T02:00:00Z', false),
      at('2026-08-24T03:00:00Z', false),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0)
    expect(active[0]).toEqual({
      date: '2026-08-24',
      state: 'down',
      ok: 1,
      failed: 2,
      downMs: 2 * 60_000,
    })
  })

  it('handles all successes in a day', () => {
    const days = toDays([
      at('2026-08-24T01:00:00Z', true),
      at('2026-08-24T02:00:00Z', true),
      at('2026-08-24T03:00:00Z', true),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0)
    expect(active[0]).toEqual({
      date: '2026-08-24',
      state: 'ok',
      ok: 3,
      failed: 0,
      downMs: 0,
    })
  })

  it('handles all failures in a day', () => {
    const days = toDays([
      at('2026-08-24T01:00:00Z', false),
      at('2026-08-24T02:00:00Z', false),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0)
    expect(active[0]).toEqual({
      date: '2026-08-24',
      state: 'down',
      ok: 0,
      failed: 2,
      downMs: 2 * 60_000,
    })
  })
})

// ─── Oldest-first ordering ────────────────────────────────────────────────────

describe('toDays — oldest-first ordering', () => {
  it('returns days sorted oldest-first regardless of input order', () => {
    // Input is newest-first (as from DB query)
    const days = toDays([
      at('2026-08-24T00:00:00Z', true),
      at('2026-08-22T00:00:00Z', true),
      at('2026-08-23T00:00:00Z', true),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0).map((d) => d.date)
    expect(active).toEqual(['2026-08-22', '2026-08-23', '2026-08-24'])
  })

  it('handles reverse chronological input', () => {
    const days = toDays([
      at('2026-08-25T00:00:00Z', true),
      at('2026-08-24T00:00:00Z', true),
      at('2026-08-23T00:00:00Z', true),
    ])
    const active = days.filter((d) => d.ok + d.failed > 0).map((d) => d.date)
    expect(active).toEqual(['2026-08-23', '2026-08-24', '2026-08-25'])
  })
})

// ─── Windowing (days parameter) ───────────────────────────────────────────────

describe('toDays — windowing', () => {
  it('returns exactly 90 entries (no drop of empty days)', () => {
    const days = toDays([], 90)
    expect(days).toHaveLength(90)
    expect(days[0]?.state).toBe('empty')
    expect(days[89]?.state).toBe('empty')
  })

  it('keeps only the most recent N days', () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      at(`${day(-119 + i)}T00:00:00Z`, true),
    )
    const days = toDays(events, 90)
    expect(days).toHaveLength(90)
    expect(days.at(-1)?.date).toBe(day(0))
  })

  it('defaults to 90 days', () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      at(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), true),
    )
    const days = toDays(events)
    expect(days).toHaveLength(90)
  })

  it('handles custom window size', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      at(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), true),
    )
    const days = toDays(events, 7)
    expect(days).toHaveLength(7)
  })
})

// ─── Serialized timestamps ────────────────────────────────────────────────────

describe('toDays — serialized timestamps', () => {
  it('accepts ISO string timestamps', () => {
    const days = toDays([{ ts: `${day(0)}T10:00:00.000Z`, ok: true }], 1)
    expect(days[0]).toEqual({
      date: day(0),
      state: 'ok',
      ok: 1,
      failed: 0,
      downMs: 0,
    })
  })

  it('accepts Date objects', () => {
    const days = toDays([{ ts: new Date(`${day(0)}T10:00:00Z`), ok: true }], 1)
    expect(days[0]?.date).toBe(day(0))
  })

  it('handles mixed Date and string timestamps', () => {
    const days = toDays(
      [
        { ts: `${day(0)}T10:00:00Z`, ok: true },
        { ts: new Date(`${day(0)}T11:00:00Z`), ok: true },
      ],
      1,
    )
    expect(days).toHaveLength(1)
    expect(days[0]?.ok).toBe(2)
  })
})

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('toDays — empty input', () => {
  it('returns a window of empty days', () => {
    const days = toDays([])
    expect(days).toHaveLength(90)
    expect(days.every((d) => d.state === 'empty')).toBe(true)
  })

  it('returns windowed empty days with custom window', () => {
    const days = toDays([], 30)
    expect(days).toHaveLength(30)
    expect(days.every((d) => d.state === 'empty')).toBe(true)
  })
})

// ─── Single event ─────────────────────────────────────────────────────────────

describe('toDays — single event', () => {
  it('handles a single successful event', () => {
    const days = toDays([at(`${day(0)}T12:00:00Z`, true)], 1)
    expect(days[0]).toEqual({
      date: day(0),
      state: 'ok',
      ok: 1,
      failed: 0,
      downMs: 0,
    })
  })

  it('handles a single failed event', () => {
    const days = toDays([at(`${day(0)}T12:00:00Z`, false)], 1)
    expect(days[0]).toEqual({
      date: day(0),
      state: 'down',
      ok: 0,
      failed: 1,
      downMs: 60_000,
    })
  })
})

// ─── Multi-day sequences ──────────────────────────────────────────────────────

describe('toDays — multi-day sequences', () => {
  it('handles a week of mixed results', () => {
    const events = [
      at(`${day(-6)}T10:00:00Z`, true),
      at(`${day(-5)}T10:00:00Z`, false),
      at(`${day(-4)}T10:00:00Z`, true),
      at(`${day(-3)}T10:00:00Z`, true),
      at(`${day(-2)}T10:00:00Z`, false),
      at(`${day(-1)}T10:00:00Z`, true),
      at(`${day(0)}T10:00:00Z`, true),
    ]
    const days = toDays(events, 7)
    expect(days).toHaveLength(7)
    expect(days[0]?.date).toBe(day(-6))
    expect(days[6]?.date).toBe(day(0))
  })

  it('keeps empty days visible in the window', () => {
    const events = [
      at(`${day(-4)}T10:00:00Z`, true),
      at(`${day(0)}T10:00:00Z`, true),
    ]
    const days = toDays(events, 5)
    expect(days).toHaveLength(5)
    expect(days.map((d) => d.state)).toEqual(['ok', 'empty', 'empty', 'empty', 'ok'])
  })
})

// ─── summarize() ─────────────────────────────────────────────────────────────

describe('summarize() — legend counts', () => {
  it('counts outage days', () => {
    const days: UptimeDay[] = [
      { date: '2026-08-01', state: 'ok', ok: 100, failed: 0, downMs: 0 },
      { date: '2026-08-02', state: 'down', ok: 50, failed: 5, downMs: 300_000 },
      { date: '2026-08-03', state: 'down', ok: 0, failed: 100, downMs: 6_000_000 },
    ]
    const summary = summarize(days)
    expect(summary.outageCount).toBe(2)
    expect(summary.noChecksCount).toBe(0)
  })

  it('counts days with no events', () => {
    const days: UptimeDay[] = [
      { date: '2026-08-01', state: 'ok', ok: 100, failed: 0, downMs: 0 },
      { date: '2026-08-02', state: 'empty', ok: 0, failed: 0, downMs: 0 },
      { date: '2026-08-03', state: 'empty', ok: 0, failed: 0, downMs: 0 },
    ]
    const summary = summarize(days)
    expect(summary.noChecksCount).toBe(2)
    expect(summary.outageCount).toBe(0)
  })
})

// ─── formatDowntime() ────────────────────────────────────────────────────────

describe('formatDowntime()', () => {
  it('formats hours and minutes', () => {
    expect(formatDowntime(3_600_000 + 5 * 60_000)).toBe('1h 5m')
  })
  it('formats minutes and seconds', () => {
    expect(formatDowntime(2 * 60_000 + 30_000)).toBe('2m 30s')
  })
  it('formats seconds only', () => {
    expect(formatDowntime(45_000)).toBe('45s')
  })
  it('formats zero', () => {
    expect(formatDowntime(0)).toBe('0s')
  })
})

// ─── formatShortDate() ───────────────────────────────────────────────────────

describe('formatShortDate()', () => {
  it('formats as Mon D', () => {
    expect(formatShortDate('2026-08-08')).toBe('Aug 8')
    expect(formatShortDate('2026-09-06')).toBe('Sep 6')
  })
})
