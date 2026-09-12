import { NextResponse } from 'next/server';
import { createRuntime, type RuntimeClient } from '../runtime.ts';
import { buildRouteEvent } from './observe.ts';
import type { SessionDetectionOptions } from './session.ts';

/** Static assets / internals — excluded from route monitoring */
const DEFAULT_EXCLUDED: ReadonlyArray<RegExp> = [
  /^\/_next\//,
  /^\/_vercel\//,
  /^\/api\/inngest/,
  /\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webp|avif|txt|xml|json)$/i,
];

export type WaitUntilExecutor = (promise: Promise<unknown>) => void;

export type GuardOptions = SessionDetectionOptions & {
  /** Optional custom runtime client */
  runtime?: RuntimeClient;
  /**
   * Optional custom waitUntil executor (e.g. from Cloudflare ctx.waitUntil or a custom background runner).
   * If omitted, withGuard checks event.waitUntil, attempts to load from '@vercel/functions',
   * and falls back to void runtime.flush() on self-hosted Node.js.
   */
  waitUntil?: WaitUntilExecutor;
  /** Extra skip rule (e.g. health endpoints) */
  exclude?: (pathname: string) => boolean;
  /** Prefix skips */
  excludePrefixes?: ReadonlyArray<string>;
};

export interface NextRequestLike {
  nextUrl: { pathname: string; hostname?: string };
  method: string;
  headers: {
    get: (name: string) => string | null;
    has: (name: string) => boolean;
  };
}

export interface NextFetchEventLike {
  waitUntil?: (promise: Promise<unknown>) => void;
}

let vercelWaitUntilChecked = false;
let vercelWaitUntilFn: WaitUntilExecutor | null = null;

/**
 * Resolves the appropriate waitUntil executor across Vercel, Cloudflare, and self-hosted Node.
 * Never throws.
 */
export async function resolveWaitUntil(
  optionsWaitUntil?: WaitUntilExecutor,
  eventWaitUntil?: WaitUntilExecutor,
): Promise<WaitUntilExecutor | null> {
  // 1. Explicit option passed to withGuard (e.g. Cloudflare ctx.waitUntil)
  if (typeof optionsWaitUntil === 'function') {
    return optionsWaitUntil;
  }

  // 2. event.waitUntil from NextFetchEvent or Cloudflare execution context
  if (typeof eventWaitUntil === 'function') {
    return eventWaitUntil;
  }

  // 3. Attempt dynamic import from '@vercel/functions' if available
  if (!vercelWaitUntilChecked) {
    vercelWaitUntilChecked = true;
    try {
      const pkg = '@vercel/functions';
      const vercelMod = await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg);
      if (typeof vercelMod?.waitUntil === 'function') {
        vercelWaitUntilFn = vercelMod.waitUntil;
      }
    } catch {
      // Not in a Vercel environment or @vercel/functions not installed (e.g. self-hosted Node)
      vercelWaitUntilFn = null;
    }
  }

  return vercelWaitUntilFn;
}

export function resetWaitUntilCacheForTests(): void {
  vercelWaitUntilChecked = false;
  vercelWaitUntilFn = null;
}

let shared: RuntimeClient | null = null;

function getSharedRuntime(): RuntimeClient {
  shared ??= createRuntime({
    projectId: process.env.RUNTIME_PROJECT_ID ?? '',
    host: process.env.RUNTIME_HOST ?? '',
    signingSecret: process.env.RUNTIME_SIGNING_SECRET ?? '',
    ingestUrl: process.env.RUNTIME_INGEST_URL ?? '',
    maxBatchSize: 10,
    flushIntervalMs: 5_000,
    onError: () => {},
  });
  return shared;
}

function isOwnIngestPath(ingestUrl: string, pathname: string): boolean {
  try {
    return new URL(ingestUrl).pathname === pathname;
  } catch {
    return false;
  }
}

/**
 * Middleware wrapper for observing routes and server actions in Next.js applications:
 *
 *   export default withGuard();
 *
 * Or wrap existing middleware:
 *   export default withGuard(myAuthMiddleware);
 */
export function withGuard<
  TReq extends NextRequestLike = NextRequestLike,
  TRes = Response,
  TEvent = any,
>(
  userMiddleware?: (req: TReq, event?: TEvent) => Promise<TRes> | TRes,
  options: GuardOptions = {},
): (req: TReq, event?: TEvent) => Promise<TRes> {
  return async function guarded(req: TReq, event?: any): Promise<TRes> {
    try {
      const runtime = options.runtime ?? getSharedRuntime();
      const { pathname } = req.nextUrl;

      const excluded =
        pathname === '/' ||
        pathname.startsWith('/api/runtime/ingest') ||
        DEFAULT_EXCLUDED.some((re) => re.test(pathname)) ||
        options.excludePrefixes?.some((p) => pathname.startsWith(p)) === true ||
        options.exclude?.(pathname) === true ||
        isOwnIngestPath(runtime.config.ingestUrl, pathname);

      if (!excluded) {
        const routeEvent = buildRouteEvent(
          {
            pathname,
            method: req.method,
            cookieHeader: req.headers.get('cookie'),
            isServerAction: req.headers.has('next-action'),
          },
          options,
        );
        if (routeEvent) {
          runtime.report(routeEvent);
          // Auto-detect host from request so ScanlyFix automatically matches the project
          const reqHost =
            process.env.RUNTIME_HOST ??
            req.headers.get('x-forwarded-host') ??
            req.headers.get('host') ??
            req.nextUrl?.hostname;

          const flushPromise = runtime.flush(reqHost);
          let executed = false;
          try {
            const executor = await resolveWaitUntil(options.waitUntil, event?.waitUntil);
            if (executor) {
              executor(flushPromise);
              executed = true;
            }
          } catch {
            // Never let the executor lookup or execution throw
          }

          if (!executed) {
            // Final fallback on self-hosted Node or environments without waitUntil
            void flushPromise;
          }
        }
      }
    } catch {
      // Guard never causes user requests to fail
    }

    if (userMiddleware) {
      return await userMiddleware(req, event);
    }
    return NextResponse.next() as unknown as TRes;
  };
}