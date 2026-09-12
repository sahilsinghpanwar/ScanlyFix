import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Mirror next.config.ts, which loads `../../.env`: the workspace keeps ONE
// .env at the REPOSITORY root, not beside the app. Pointing at './.env' here
// loaded nothing — that file does not exist — so a `required('NEXT_PUBLIC_APP_URL')`
// at import time threw in the test process even though it would not in
// `next dev` or `next build`. The two configs must name the same file.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true })

export default defineConfig({
  test: {
    // Node environment only: what is tested here is pure logic shared by the
    // client and the API route. Component behaviour is covered by the app itself.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Components are imported for their pure helpers, so JSX must parse.

  },
  resolve: {
    alias: {
      // See test/stubs/server-only.ts — the real package throws outside an RSC
      // build, which is what makes it useful and what makes it untestable.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
      // Next resolves `@/` from tsconfig paths; vitest does not read those, so
      // a module under test that imports a sibling through the alias fails to
      // load. Mirrored here rather than rewritten to relative imports, so the
      // source keeps one import style.
      '@': fileURLToPath(new URL('.', import.meta.url)),
      '@scanlyfix/runtime-sdk': fileURLToPath(new URL('../../packages/runtime-sdk/src/index.ts', import.meta.url)),
      '@darvin/runtime-sdk': fileURLToPath(new URL('../../packages/runtime-sdk/src/index.ts', import.meta.url)),
    },
  },
})
