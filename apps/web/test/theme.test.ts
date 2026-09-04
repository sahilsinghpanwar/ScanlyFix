/**
 * The theme resolution, locked down.
 *
 * Two layers are tested here. The pure rule (resolveTheme) covers every
 * combination of preference and OS setting, because a wrong priority there
 * means a user's explicit choice silently loses to their operating system.
 * The inline init script is EXECUTED, because it duplicates that rule in
 * plain JS (an inline script cannot import a module) — running it is the only
 * way to prove the copy has not drifted, the classes land on <html>, and a
 * stale class from a previous choice is removed rather than left to fight
 * the new one.
 *
 * ## Why the script runs in a vm sandbox
 *
 * The init script reads the BARE `localStorage` identifier. Recent Node ships
 * its own experimental `localStorage` global, and on some versions that
 * built-in is an accessor that cannot be overwritten on globalThis — so a
 * test harness that reassigns `globalThis.localStorage` throws before the
 * script even runs, on some machines but not others. `vm.runInNewContext`
 * gives the script its own global object where bare identifiers resolve to
 * our stubs, sidestepping the host's globals entirely. The lib functions
 * never use the bare identifier (they go through `window.localStorage`), so
 * they are tested under plain globalThis stubs for `window` and `document`
 * only.
 */

import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  THEME_KEY,
  applyTheme,
  isThemePreference,
  readStoredPreference,
  resolveTheme,
  storePreference,
  themeInitScript,
} from '../lib/theme.ts'

/* -------------------------------------------------------------------------- */
/* The stubbed browser                                                        */
/* -------------------------------------------------------------------------- */

interface BrowserConfig {
  /** What localStorage holds under THEME_KEY: a value, or absent. */
  stored?: string
  systemDark: boolean
  /** Classes already on <html> before the code under test runs. */
  initialClasses?: string[]
}

/** What a test can read back: the storage contents and <html>'s classes. */
interface BrowserCtx {
  store: Map<string, string>
  classes: Set<string>
}

function classListStub(classes: Set<string>) {
  return {
    add: (...names: string[]) => names.forEach((n) => classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
    contains: (name: string) => classes.has(name),
  }
}

function storageStub(store: Map<string, string>) {
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

function makeBrowser(config: BrowserConfig): BrowserCtx {
  const store = new Map<string, string>(
    config.stored === undefined ? [] : [[THEME_KEY, config.stored]],
  )
  return { store, classes: new Set(config.initialClasses) }
}

/**
 * Installs the lib-side stubs — `window` and `document` only, because those
 * are the only globals lib/theme.ts names. Node has no built-ins under these
 * names in the node test environment, but the installation is defensive
 * anyway: if a future environment owns one of them immutably, plain
 * assignment is tried before giving up, and everything is restored after.
 */
function withBrowser<T>(config: BrowserConfig, run: (ctx: BrowserCtx) => T): T {
  const ctx = makeBrowser(config)
  const window = {
    localStorage: storageStub(ctx.store),
    matchMedia: () => ({ matches: config.systemDark }),
  }
  const document = { documentElement: { classList: classListStub(ctx.classes) } }

  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window, document })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    try {
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } catch {
      ;(globalThis as Record<string, unknown>)[name] = value
    }
  }

  try {
    return run(ctx)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/**
 * Runs the init script EXACTLY as shipped, in a context whose globals are our
 * stubs — see the module note on why this does not touch globalThis.
 */
function runInitScript(config: BrowserConfig): Set<string> {
  const ctx = makeBrowser(config)
  const sandbox: Record<string, unknown> = {
    localStorage: storageStub(ctx.store),
    window: {
      localStorage: storageStub(ctx.store),
      matchMedia: () => ({ matches: config.systemDark }),
    },
    document: { documentElement: { classList: classListStub(ctx.classes) } },
  }
  runInNewContext(themeInitScript, sandbox)
  return ctx.classes
}

/* -------------------------------------------------------------------------- */
/* The preference type                                                        */
/* -------------------------------------------------------------------------- */

describe('theme preference type', () => {
  it('accepts exactly the three states the toggle offers', () => {
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
  })

  it('rejects everything else, so a corrupt storage value degrades to system', () => {
    for (const bad of ['LIGHT', 'auto', '', 'dark ', 'null', 0, true, null, undefined]) {
      expect(isThemePreference(bad), String(bad)).toBe(false)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The resolution rule                                                        */
/* -------------------------------------------------------------------------- */

describe('resolveTheme', () => {
  it('an explicit choice wins over the OS in both directions', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  it('system and no-choice follow the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
  })
})

/* -------------------------------------------------------------------------- */
/* The stored preference                                                      */
/* -------------------------------------------------------------------------- */

describe('readStoredPreference', () => {
  it('reads a valid stored choice', () => {
    withBrowser({ stored: 'dark', systemDark: false }, () => {
      expect(readStoredPreference()).toBe('dark')
    })
  })

  it('degrades to system when nothing is stored or the value is corrupt', () => {
    withBrowser({ systemDark: false }, () => {
      expect(readStoredPreference()).toBe('system')
    })
    withBrowser({ stored: 'purple', systemDark: false }, () => {
      expect(readStoredPreference()).toBe('system')
    })
  })
})

describe('storePreference', () => {
  it('writes the choice under the one key the init script reads', () => {
    withBrowser({ systemDark: false }, ({ store }) => {
      storePreference('dark')
      expect(store.get(THEME_KEY)).toBe('dark')
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Applying to <html>                                                         */
/* -------------------------------------------------------------------------- */

describe('applyTheme', () => {
  it('puts exactly one theme class on <html>, never both', () => {
    withBrowser({ systemDark: false, initialClasses: ['dark'] }, ({ classes }) => {
      applyTheme('light')
      expect(classes.has('light')).toBe(true)
      expect(classes.has('dark')).toBe(false)
    })
  })

  it('resolves system against the OS at the moment it is applied', () => {
    withBrowser({ systemDark: true }, ({ classes }) => {
      applyTheme('system')
      expect(classes.has('dark')).toBe(true)
      expect(classes.has('light')).toBe(false)
    })
    withBrowser({ systemDark: false }, ({ classes }) => {
      applyTheme('system')
      expect(classes.has('light')).toBe(true)
    })
  })

  it('an explicit dark beats a light OS', () => {
    withBrowser({ systemDark: false }, ({ classes }) => {
      applyTheme('dark')
      expect(classes.has('dark')).toBe(true)
    })
  })
})

/* -------------------------------------------------------------------------- */
/* The inline init script                                                     */
/* -------------------------------------------------------------------------- */

describe('themeInitScript', () => {
  it('reads the same key the app writes, so the two cannot drift', () => {
    expect(themeInitScript).toContain(THEME_KEY)
    expect(themeInitScript).toContain('prefers-color-scheme: dark')
  })

  it('dark stored choice is on <html> before paint, even on a light OS', () => {
    const classes = runInitScript({ stored: 'dark', systemDark: false })
    expect(classes.has('dark')).toBe(true)
    expect(classes.has('light')).toBe(false)
  })

  it('light stored choice survives a dark OS', () => {
    const classes = runInitScript({ stored: 'light', systemDark: true })
    expect(classes.has('light')).toBe(true)
    expect(classes.has('dark')).toBe(false)
  })

  it('system mode follows the OS at first paint', () => {
    expect(runInitScript({ stored: 'system', systemDark: true }).has('dark')).toBe(true)
    expect(runInitScript({ stored: 'system', systemDark: false }).has('light')).toBe(true)
  })

  it('no stored value behaves as system', () => {
    expect(runInitScript({ systemDark: true }).has('dark')).toBe(true)
  })

  it('a corrupt stored value behaves as system, not as a crash', () => {
    expect(runInitScript({ stored: 'shiny', systemDark: false }).has('light')).toBe(true)
  })

  it('removes a stale class instead of leaving both on <html>', () => {
    const classes = runInitScript({
      stored: 'dark',
      systemDark: false,
      initialClasses: ['light'],
    })
    expect(classes.has('dark')).toBe(true)
    expect(classes.has('light')).toBe(false)
  })

  it('a throwing localStorage leaves the page on its current theme', () => {
    // Private mode or a blocked partition: reads refuse. The script's own
    // try/catch must swallow that and change nothing.
    const classes = new Set(['light'])
    const document = { documentElement: { classList: classListStub(classes) } }
    const window = {
      matchMedia: () => ({ matches: true }),
    }
    expect(() =>
      runInNewContext(themeInitScript, {
        localStorage: { getItem: () => {
          throw new Error('blocked')
        } },
        window,
        document,
      }),
    ).not.toThrow()
    expect(classes.has('light')).toBe(true)
    expect(classes.has('dark')).toBe(false)
  })
})
