/**
 * Environment values that are safe in a browser bundle.
 *
 * Separate from lib/env.ts on purpose: that module carries `server-only`, so a
 * client component importing it fails the build. These are NEXT_PUBLIC_,
 * meaning Next inlines them into the bundle at build time — they are public by
 * definition, and a Supabase project URL is an address, not a secret.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    // NEXT_PUBLIC_ vars are read at BUILD time, so a deploy that has not set
    // this in its environment fails the build here rather than at runtime. On a
    // host the value comes from the project's environment variables; locally it
    // comes from the root .env. See .env.example for the full list.
    throw new Error(
      `Missing ${name}. Set it in your deployment's environment variables ` +
        '(or the root .env when running locally); see .env.example.',
    )
  }
  return value
}

export const publicEnv = {
  /** The Supabase project URL, e.g. https://mxjrcpkfechlylaiaape.supabase.co */
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
  /** The Supabase publishable/anon key. Public by definition; sent to the browser. */
  supabaseAnonKey: () =>
    required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  /**
   * The deployment's public URL, e.g. https://scanlyfix.com. Used by the login
   * form to build the post-OAuth redirect. Required: a localhost fallback here
   * is the silent failure mode that makes sign-in appear to work in dev and
   * break in production.
   */
  appUrl: () => {
    const val =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.NEXT_PUBLIC_VERCEL_URL ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` : '') ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')

    if (!val) {
      if (process.env.NODE_ENV === 'test') {
        return required('NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL)
      }
      return 'https://scanlyfix.com'
    }
    return val.replace(/\/+$/, '')
  },
  /*
   * There is deliberately no `redirectAllowlist` here. One existed and read
   * `SUPABASE_REDIRECT_ALLOWLIST`, which has no NEXT_PUBLIC_ prefix — so Next
   * never inlined it into the browser bundle and every client-side read got
   * `undefined`. The allowlist is server configuration and is read where it
   * exists, in `serverEnv`; see proxy.ts for the boot-time check.
   */
} as const
