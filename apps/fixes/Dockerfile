# The fix tier.
#
# A plain Node image — no browser, no system libraries, one fetch call to
# OpenRouter per request. Slim where the scanner is heavy.
FROM node:22-alpine

ENV NODE_ENV=production
RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change does not reinstall the workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/fixes/package.json ./apps/fixes/

# No runtime dependencies — the workspace install is dev tooling only.
RUN pnpm install --frozen-lockfile --filter @scanlyfix/fixes...

COPY apps/fixes ./apps/fixes

# The service ships raw TypeScript; Node strips the types at load. There is no
# build step to keep in sync with the source.
WORKDIR /app/apps/fixes
EXPOSE 8082

# Runs as the image's non-root `node` user. Nothing here needs to write to disk.
USER node

# SCANLYFIX_FIXES_TOKEN and OPENROUTER_API_KEY must be supplied at run time.
# The process refuses to start without either — see src/index.ts.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
