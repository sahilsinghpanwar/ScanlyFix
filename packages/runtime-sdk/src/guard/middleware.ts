import { createRuntime, type RuntimeClient } from '../runtime.ts';
import { buildRouteEvent } from './observe.ts';
import type { SessionDetectionOptions } from './session.ts';

/** Static assets / internals — excluded from route monitoring */
const DEFAULT_EXCLUDED: ReadonlyArray<RegExp> = [
  /^\/_next\//,
  /^\/_vercel\//,
  /\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webp|avif|txt|xml|json)$/i,
];

export type GuardOptions = SessionDetectionOptions & {
  /** Optional custom runtime client */
  runtime?: RuntimeClient;
  /** Extra skip rule (e.g. health endpoints) */
  exclude?: (pathname: string) => boolean;
  /** Prefix skips */
  excludePrefixes?: ReadonlyArray<string>;
};

export interface NextRequestLike {
  nextUrl: { pathname: string };
  method: string;
  headers: {
    get: (name: string) => string | null;
    has: (name: string) => boolean;
  };
}

let shared: RuntimeClient | null = null;

function getSharedRuntime(): RuntimeClient {
  shared ??= createRuntime({
    projectId: process.env.RUNTIME_PROJECT_ID ?? '',
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
export function withGuard<TReq extends NextRequestLike = NextRequestLike, TRes = Response>(
  userMiddleware?: (req: TReq) => Promise<TRes> | TRes,
  options: GuardOptions = {},
): (req: TReq) => Promise<TRes> {
  return async function guarded(req: TReq): Promise<TRes> {
    try {
      const runtime = options.runtime ?? getSharedRuntime();
      const { pathname } = req.nextUrl;

      const excluded =
        pathname === '/' ||
        DEFAULT_EXCLUDED.some((re) => re.test(pathname)) ||
        options.excludePrefixes?.some((p) => pathname.startsWith(p)) === true ||
        options.exclude?.(pathname) === true ||
        isOwnIngestPath(runtime.config.ingestUrl, pathname);

      if (!excluded) {
        const event = buildRouteEvent(
          {
            pathname,
            method: req.method,
            cookieHeader: req.headers.get('cookie'),
            isServerAction: req.headers.has('next-action'),
          },
          options,
        );
        if (event) {
          runtime.report(event);
          void runtime.flush(); // ⭐ YE LINE WAPAS ADD KARO — middleware short-lived hota hai
        }
      }
    } catch {
      // Guard never causes user requests to fail
    }
    if (userMiddleware) return userMiddleware(req);
    return new Response(null, { status: 200 }) as unknown as TRes;
  };
}