-- Migration: add prober anon key columns to projects and variant/key_fingerprint to runtime_prober_findings
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "anon_key_encrypted" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "anon_key_fingerprint" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "anon_key_checked_at" timestamp with time zone;

ALTER TABLE "runtime_prober_findings" ADD COLUMN IF NOT EXISTS "variant" text;
ALTER TABLE "runtime_prober_findings" ADD COLUMN IF NOT EXISTS "key_fingerprint" text;
