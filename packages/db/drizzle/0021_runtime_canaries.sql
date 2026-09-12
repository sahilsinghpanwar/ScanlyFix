-- Migration 0021: Runtime Canaries
-- Adds Supabase connection columns to projects table +
-- Creates runtime_canaries and runtime_canary_events tables.

-- Step 1: Add Supabase canary connection columns to projects
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "supabase_url" text,
  ADD COLUMN IF NOT EXISTS "supabase_service_key_enc" text,
  ADD COLUMN IF NOT EXISTS "supabase_anon_key_enc" text,
  ADD COLUMN IF NOT EXISTS "canaries_setup_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "canary_snapshot" jsonb;

-- Step 2: Canary vault rows tracker
CREATE TABLE IF NOT EXISTS "runtime_canaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'vault',
  "table_name" text NOT NULL DEFAULT 'scanlyfix_canaries',
  "marker_token" text NOT NULL,
  "honeytoken_path" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_script',
  "planted_at" timestamptz,
  "last_checked_at" timestamptz,
  "last_integrity" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_canaries_marker_uq"
  ON "runtime_canaries"("project_id", "marker_token");

-- Step 3: Canary events timeline
CREATE TABLE IF NOT EXISTS "runtime_canary_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "canary_id" uuid REFERENCES "runtime_canaries"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "detail" text NOT NULL DEFAULT '',
  "source" text NOT NULL,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "runtime_canary_events_project_idx"
  ON "runtime_canary_events"("project_id", "detected_at");
