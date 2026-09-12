import pg from 'pg'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function loadLocalEnv() {
  if (process.env.DATABASE_URL) return
  const path = new URL('../../../.env', import.meta.url).pathname
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] === undefined) process.env[key] = raw.trim().replace(/^["']|["']$/g, '')
  }
}
loadLocalEnv()

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const sqlText = readFileSync(new URL('../drizzle/0013_mixed_gamora.sql', import.meta.url), 'utf8')
const statements = sqlText.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)
const client = await pool.connect()
try {
  await client.query('BEGIN')
  for (const statement of statements) await client.query(statement)
  await client.query('COMMIT')
  console.log('applied', statements.length, 'statements')
} catch (e) {
  await client.query('ROLLBACK')
  console.error('apply failed:', e.message)
  process.exit(1)
} finally { client.release() }

const hash = createHash('sha256').update(sqlText).digest('hex')
const WHEN = 1789061552571
await pool.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [hash, WHEN])
console.log('journal row inserted:', hash.slice(0, 12), '@', WHEN)

const tables = await pool.query(`select table_name from information_schema.tables where table_schema='public' and table_name in ('connections','connection_secrets','credential_access_log') order by table_name`)
console.log('tables now:', tables.rows.map(r => r.table_name))
await pool.end()
