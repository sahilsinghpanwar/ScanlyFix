-- Migration: add runtime secret rotation grace columns to projects
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "runtime_ingest_secret_prev" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "runtime_secret_rotated_at" timestamp with time zone;
