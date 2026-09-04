import { describe, expect, it } from 'vitest'
import { latestReportView } from '@/components/scan/latest-report-view.ts'

describe('latestReportView', () => {
  it('hides the section entirely when nothing has been scanned', () => {
    expect(latestReportView(null)).toBe('hidden')
  })

  it('shows the loader while the background workers own the scan', () => {
    expect(latestReportView({ status: 'queued' })).toBe('loading')
    expect(latestReportView({ status: 'running' })).toBe('loading')
  })

  it('shows the failure note when the scan could not finish', () => {
    expect(latestReportView({ status: 'failed' })).toBe('failed')
  })

  it('shows the report when the scan is done', () => {
    expect(latestReportView({ status: 'done' })).toBe('done')
  })

  it('treats an unknown status as a report rather than a perpetual loader', () => {
    // A status this code does not know means the row finished in a way newer
    // than the client — showing a loader forever would be the worse lie.
    expect(latestReportView({ status: 'something-new' })).toBe('done')
  })
})
