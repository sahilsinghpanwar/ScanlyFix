/**
 * Alert config schema tests.
 *
 * Tests the AlertConfigSchema validation for all new fields:
 *   - keywordCheck: Response body content verification
 *   - expectedStatusCodes: Expected HTTP status codes
 *   - httpMethod: HTTP method (GET or HEAD)
 *   - customHeaders: Custom headers for HTTP requests
 *   - followRedirects: Whether to follow HTTP redirects
 *
 * Also tests:
 *   - Size validation (max 4KB)
 *   - Backward compatibility with existing fields
 *   - Edge cases and error messages
 */

import { describe, expect, it } from 'vitest'
import { AlertConfigSchema, parseAlertConfig, validateConfigSize } from '../lib/alert-threshold.ts'
import type { AlertConfig } from '../lib/alert-threshold.ts'

describe('AlertConfigSchema', () => {
  describe('existing fields (backward compatibility)', () => {
    it('accepts empty object', () => {
      const result = AlertConfigSchema.safeParse({})
      expect(result.success).toBe(true)
    })

    it('accepts failStatusCodes', () => {
      const result = AlertConfigSchema.safeParse({
        failStatusCodes: [500, 502, 503, 504],
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid failStatusCodes', () => {
      const result = AlertConfigSchema.safeParse({
        failStatusCodes: [1000], // > 599
      })
      expect(result.success).toBe(false)
    })

    it('accepts maxLatencyMs', () => {
      const result = AlertConfigSchema.safeParse({
        maxLatencyMs: 5000,
      })
      expect(result.success).toBe(true)
    })

    it('accepts null maxLatencyMs', () => {
      const result = AlertConfigSchema.safeParse({
        maxLatencyMs: null,
      })
      expect(result.success).toBe(true)
    })

    it('accepts reminderIntervalMin', () => {
      const result = AlertConfigSchema.safeParse({
        reminderIntervalMin: 30,
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid reminderIntervalMin', () => {
      const result = AlertConfigSchema.safeParse({
        reminderIntervalMin: 45, // not in [15, 30, 60, 120]
      })
      expect(result.success).toBe(false)
    })

    it('accepts null reminderIntervalMin', () => {
      const result = AlertConfigSchema.safeParse({
        reminderIntervalMin: null,
      })
      expect(result.success).toBe(true)
    })
  })

  describe('keywordCheck', () => {
    it('accepts valid keywordCheck', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'should_contain',
          value: 'Welcome',
        },
      })
      expect(result.success).toBe(true)
    })

    it('accepts keywordCheck with caseSensitive', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'should_not_contain',
          value: 'Error',
          caseSensitive: true,
        },
      })
      expect(result.success).toBe(true)
    })

    it('rejects empty keyword value', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'should_contain',
          value: '',
        },
      })
      expect(result.success).toBe(false)
    })

    it('rejects keyword value > 500 chars', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'should_contain',
          value: 'x'.repeat(501),
        },
      })
      expect(result.success).toBe(false)
    })

    it('accepts keyword value at exactly 500 chars', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'should_contain',
          value: 'x'.repeat(500),
        },
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid type', () => {
      const result = AlertConfigSchema.safeParse({
        keywordCheck: {
          type: 'invalid',
          value: 'test',
        },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('expectedStatusCodes', () => {
    it('accepts valid expectedStatusCodes', () => {
      const result = AlertConfigSchema.safeParse({
        expectedStatusCodes: [200, 201, 204],
      })
      expect(result.success).toBe(true)
    })

    it('accepts empty array', () => {
      const result = AlertConfigSchema.safeParse({
        expectedStatusCodes: [],
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid status codes', () => {
      const result = AlertConfigSchema.safeParse({
        expectedStatusCodes: [1000],
      })
      expect(result.success).toBe(false)
    })

    it('rejects > 20 status codes', () => {
      const result = AlertConfigSchema.safeParse({
        expectedStatusCodes: Array.from({ length: 21 }, (_, i) => 200 + i),
      })
      expect(result.success).toBe(false)
    })
  })

  describe('httpMethod', () => {
    it('accepts GET', () => {
      const result = AlertConfigSchema.safeParse({
        httpMethod: 'GET',
      })
      expect(result.success).toBe(true)
    })

    it('accepts HEAD', () => {
      const result = AlertConfigSchema.safeParse({
        httpMethod: 'HEAD',
      })
      expect(result.success).toBe(true)
    })

    it('rejects invalid method', () => {
      const result = AlertConfigSchema.safeParse({
        httpMethod: 'POST',
      })
      expect(result.success).toBe(false)
    })

    it('defaults to GET when not provided', () => {
      const result = AlertConfigSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.httpMethod).toBe('GET')
      }
    })
  })

  describe('customHeaders', () => {
    it('accepts valid customHeaders', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: [
          { key: 'Authorization', valueEncrypted: 'encrypted-token' },
        ],
      })
      expect(result.success).toBe(true)
    })

    it('accepts multiple headers (up to 5)', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: Array.from({ length: 5 }, (_, i) => ({
          key: `Header-${i}`,
          valueEncrypted: `value-${i}`,
        })),
      })
      expect(result.success).toBe(true)
    })

    it('rejects > 5 headers', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: Array.from({ length: 6 }, (_, i) => ({
          key: `Header-${i}`,
          valueEncrypted: `value-${i}`,
        })),
      })
      expect(result.success).toBe(false)
    })

    it('rejects empty key', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: [
          { key: '', valueEncrypted: 'value' },
        ],
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid key format (special chars)', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: [
          { key: 'Authorization Token', valueEncrypted: 'value' },
        ],
      })
      expect(result.success).toBe(false)
    })

    it('accepts key with hyphens', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: [
          { key: 'X-Custom-Header', valueEncrypted: 'value' },
        ],
      })
      expect(result.success).toBe(true)
    })

    it('rejects empty valueEncrypted', () => {
      const result = AlertConfigSchema.safeParse({
        customHeaders: [
          { key: 'Authorization', valueEncrypted: '' },
        ],
      })
      expect(result.success).toBe(false)
    })
  })

  describe('followRedirects', () => {
    it('accepts true', () => {
      const result = AlertConfigSchema.safeParse({
        followRedirects: true,
      })
      expect(result.success).toBe(true)
    })

    it('accepts false', () => {
      const result = AlertConfigSchema.safeParse({
        followRedirects: false,
      })
      expect(result.success).toBe(true)
    })

    it('defaults to true when not provided', () => {
      const result = AlertConfigSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.followRedirects).toBe(true)
      }
    })

    it('rejects non-boolean', () => {
      const result = AlertConfigSchema.safeParse({
        followRedirects: 'yes',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('combined config', () => {
    it('accepts full valid config', () => {
      const result = AlertConfigSchema.safeParse({
        failStatusCodes: [500, 502, 503],
        maxLatencyMs: 5000,
        reminderIntervalMin: 30,
        keywordCheck: {
          type: 'should_contain',
          value: 'Welcome',
          caseSensitive: false,
        },
        expectedStatusCodes: [200, 201],
        httpMethod: 'GET',
        customHeaders: [
          { key: 'Authorization', valueEncrypted: 'encrypted' },
        ],
        followRedirects: true,
      })
      expect(result.success).toBe(true)
    })
  })
})

describe('parseAlertConfig', () => {
  it('returns ok for valid config', () => {
    const result = parseAlertConfig({
      failStatusCodes: [500],
    })
    expect(result.ok).toBe(true)
  })

  it('returns error for invalid config', () => {
    const result = parseAlertConfig({
      failStatusCodes: [1000],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBeDefined()
    }
  })

  it('validates size limit', () => {
    const result = parseAlertConfig({
      keywordCheck: {
        type: 'should_contain',
        value: 'x'.repeat(500),
      },
      customHeaders: Array.from({ length: 5 }, (_, i) => ({
        key: `Header-${i}`,
        valueEncrypted: 'x'.repeat(900),
      })),
    })
    // This should exceed 4KB
    expect(result.ok).toBe(false)
  })
})

describe('validateConfigSize', () => {
  it('returns ok for small config', () => {
    const config: AlertConfig = {
      failStatusCodes: [500],
    }
    const result = validateConfigSize(config)
    expect(result.ok).toBe(true)
  })

  it('returns error for large config', () => {
    const config: AlertConfig = {
      keywordCheck: {
        type: 'should_contain',
        value: 'x'.repeat(500),
      },
      customHeaders: Array.from({ length: 5 }, (_, i) => ({
        key: `Header-${i}`,
        valueEncrypted: 'x'.repeat(900),
      })),
    }
    const result = validateConfigSize(config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('Config too large')
    }
  })
})

describe('edge cases', () => {
  it('rejects null input', () => {
    const result = AlertConfigSchema.safeParse(null)
    expect(result.success).toBe(false)
  })

  it('rejects string input', () => {
    const result = AlertConfigSchema.safeParse('invalid')
    expect(result.success).toBe(false)
  })

  it('rejects array input', () => {
    const result = AlertConfigSchema.safeParse([])
    expect(result.success).toBe(false)
  })

  it('strips unknown fields', () => {
    const result = AlertConfigSchema.safeParse({
      failStatusCodes: [500],
      unknownField: 'test',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('unknownField')
    }
  })
})

// ─── failuresBeforeAlert ─────────────────────────────────────────────────────

describe('AlertConfigSchema — failuresBeforeAlert', () => {
  it('accepts 1, 2, 3, 5', () => {
    for (const value of [1, 2, 3, 5]) {
      const result = AlertConfigSchema.safeParse({ failuresBeforeAlert: value })
      expect(result.success).toBe(true)
    }
  })

  it('rejects 0 (must be >= 1)', () => {
    const result = AlertConfigSchema.safeParse({ failuresBeforeAlert: 0 })
    expect(result.success).toBe(false)
  })

  it('accepts 4', () => {
    const result = AlertConfigSchema.safeParse({ failuresBeforeAlert: 4 })
    expect(result.success).toBe(true)
  })

  it('rejects non-integers', () => {
    const result = AlertConfigSchema.safeParse({ failuresBeforeAlert: 2.5 })
    expect(result.success).toBe(false)
  })

  it('rejects > 5', () => {
    const result = AlertConfigSchema.safeParse({ failuresBeforeAlert: 10 })
    expect(result.success).toBe(false)
  })
})

// ─── alertEmail ──────────────────────────────────────────────────────────────

describe('AlertConfigSchema — alertEmail', () => {
  it('accepts a valid email', () => {
    const result = AlertConfigSchema.safeParse({
      alertEmail: 'alerts@example.com',
    })
    expect(result.success).toBe(true)
  })

  it('accepts null', () => {
    const result = AlertConfigSchema.safeParse({ alertEmail: null })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid email', () => {
    const result = AlertConfigSchema.safeParse({ alertEmail: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('rejects empty string', () => {
    const result = AlertConfigSchema.safeParse({ alertEmail: '' })
    expect(result.success).toBe(false)
  })
})
