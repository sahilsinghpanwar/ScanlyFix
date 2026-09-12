/**
 * Apply pending migrations. The step a deploy runs before it serves traffic.
 *
 * Separate from `db:migrate` (drizzle-kit) on purpose. drizzle-kit is a
 * devDependency, and a production install with `--prod` does not have it — so
 * the script that has to work on the deploy host is the one that uses only
 * `drizzle-orm` and `pg`, both of which are real dependencies because the app
 * itself needs them at runtime.
 *
 * The advisory lock is the part that matters in production. Platforms start
 * several instances of a release at once, and a plain migrate has all of them
 * racing to create the same table: the losers crash on "already exists", the
 * platform reads that as a failed boot, and it rolls back a deploy whose
 * migration actually succeeded. `pg_advisory_lock` serialises them — the first
 * instance migrates and the rest wait, then find nothing to do.
 *
 *   node scripts/migrate.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'

/**
 * An arbitrary but FIXED key. Advisory locks are namespaced by nothing but the
 * number, so every process that wants this lock has to name the same one; the
 * value itself is meaningless as long as it never changes.
 */
const LOCK_KEY = 4_607_231

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Load the root .env when one is present, so the script also works locally. */
function loadLocalEnv() {
  if (process.env.DATABASE_URL) return
  try {
    const path = fileURLToPath(new URL('../../../.env', import.meta.url))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const [, key, raw] = match
      if (process.env[key] === undefined) {
        process.env[key] = raw.trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // No .env on a deploy host is the normal case — the platform injects the
    // variables directly, and the check below is what actually enforces them.
  }
}

async function main() {
  loadLocalEnv()

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. It must be present in the deploy environment before migrations run.',
    )
  }

  const pool = new Pool({ connectionString, max: 1 })
  const db = drizzle(pool)

  let lockAcquired = false
  try {
    try {
      // Blocks until whichever instance got here first has finished.
      await db.execute(sql`select pg_advisory_lock(${LOCK_KEY})`)
      lockAcquired = true
    } catch (lockError) {
      console.warn(
        '[migrate] advisory lock not available (connection pooler / pgbouncer detected), proceeding without advisory lock:',
        lockError instanceof Error ? lockError.message : lockError,
      )
    }

    try {
      await migrate(db, { migrationsFolder })
      console.log('[migrate] schema is up to date')
    } finally {
      if (lockAcquired) {
        // Released explicitly rather than left to the connection closing
        await db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => {})
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error.cause || error)
  // Non-zero so the platform stops the release here, rather than starting an
  // app whose code expects columns the database does not have.
  process.exit(1)
})
