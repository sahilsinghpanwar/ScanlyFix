# ScanlyFix

ScanlyFix is an application scanner — paste a URL, get 100+ read-only checks across security, SEO, AEO, performance, accessibility, and compliance, each with severity, evidence, remediation, and a copy-paste fix prompt.

Monorepo (Turborepo + pnpm, Node ≥22).

## Quick Start

```sh
pnpm install
pnpm scan https://example.com          # human-readable report
pnpm scan example.com --json           # machine-readable output
```

## Development

```sh
pnpm typecheck                          # strict tsc across packages
pnpm test                               # network-free unit tests (vitest)
cd packages/checks && SCANLYFIX_LIVE=1 pnpm test   # + live end-to-end smoke
```

### Web App

```sh
cd apps/web
pnpm dev                                # Next.js dev server
pnpm build                              # production build
pnpm test                               # vitest tests
```



## Packages

| Package | Description |
|---|---|
| `packages/checks` | Website health-check engine — 9 categories (accessibility, AEO, compliance, context, domain, email, performance, security, SEO) with 80+ individual checks |
| `packages/db` | Drizzle ORM schema, migrations, and query modules |
| `packages/mcp-server` | MCP tool server exposing scan/project tools |
| `packages/repo-checks` | GitHub repo checks — CI/CD, governance, and supply-chain auditing |
| `packages/config` | Shared config (placeholder) |
| `packages/types` | Shared types (placeholder) |

## Apps

| App | Description |
|---|---|
| `apps/web` | Next.js 16 web app — dashboard, scan reports, marketing site, API routes |
| `apps/cli` | CLI runner — `buildContext → runChecks → computeScores → print` |
| `apps/scanner` | Headless browser scanner (Dockerized) — screenshots, PDF, rendered content, axe audit |

## Key Files

- `packages/checks/src/types.ts` — `Check` / `CheckContext` / `Finding` contract
- `packages/checks/src/context/ssrf-guard.ts` — SSRF protection; every socket resolves through it
- `packages/checks/src/registry.ts` — register new checks here
- `apps/web/lib/` — shared utilities (auth, billing, email, rate limiting, env validation)
- `apps/web/inngest/functions/` — background job definitions (scans, reports, monitoring)

## Docs

- [Deployment](./DEPLOY.md)
- [Supabase Setup](./SUPABASE_SETUP.md)
- [Status page](./docs/status-page.md) — public `/status/[slug]`, branding, robots policy
- [Monitoring audit](./docs/monitoring-audit.md)
- [Progress](./progress.md)
- [Requirements](./requirement.md)
