/**
 * Grouping uptime events into days.
 *
 * Pure, and the only part of the status page worth testing without a browser —
 * a strip that renders the wrong day is a status page that lies during exactly
 * the incident it was linked for.
 *
 * Kept as a separate file from uptime-days.test.ts (the broader characterization
 * suite) so this file stays a quick smoke test for the chart's input contract.
 */

import { describe, expect, it } from 'vitest'
import { toDays } from '../components/monitors/uptime-days.ts'

const at = (iso: string, ok: boolean) => ({ ts: new Date(iso), ok })
const NOW = new Date()
const day = (offset: number) => {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

describe('toDays', () => {
  it('groups by UTC day so the strip reads the same everywhere', () => {
    // Two events either side of local midnight in most zones, one UTC day.
    const days = toDays([at(`${day(0)}T01:00:00Z`, true), at(`${day(0)}T23:00:00Z`, true)], 1)
    expect(days[0]).toMatchObject({ date: day(0), ok: 2, failed: 0, state: 'ok' })
  })

  it('counts successes and failures separately within a day', () => {
    const days = toDays(
      [
        at(`${day(0)}T01:00:00Z`, true),
        at(`${day(0)}T02:00:00Z`, false),
        at(`${day(0)}T03:00:00Z`, false),
      ],
      1,
    )
    expect(days[0]).toMatchObject({ date: day(0), ok: 1, failed: 2, state: 'down' })
  })

  it('returns days oldest-first, whatever order the events arrive in', () => {
    // The query hands them back newest-first; the strip reads left to right.
    const days = toDays(
      [at(`${day(0)}T00:00:00Z`, true), at(`${day(-2)}T00:00:00Z`, true)],
      5,
    )
    const active = days.filter((d) => d.ok + d.failed > 0).map((d) => d.date)
    expect(active).toEqual([day(-2), day(0)])
  })

  it('keeps only the most recent window', () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      at(`${day(-119 + i)}T00:00:00Z`, true),
    )
    const days = toDays(events, 90)
    expect(days).toHaveLength(90)
    expect(days.at(-1)?.date).toBe(day(0))
  })

  it('accepts a serialized timestamp, which is what an API returns', () => {
    expect(toDays([{ ts: `${day(0)}T10:00:00.000Z`, ok: true }], 1)[0]?.date).toBe(day(0))
  })

  it('returns a window of empty days when there are no events', () => {
    const days = toDays([], 30)
    expect(days).toHaveLength(30)
    expect(days.every((d) => d.state === 'empty')).toBe(true)
  })
})
