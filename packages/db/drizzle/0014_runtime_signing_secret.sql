-- Migration: add per-project Runtime SDK signing secret
-- Each project gets its own signing secret so ingest endpoint validation
-- is fully isolated between projects. Nullable — existing projects get null
-- until the owner opens the Guard setup card (auto-generates on first view).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "runtime_signing_secret" text;
