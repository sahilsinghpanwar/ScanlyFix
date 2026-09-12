-- Migration: add source column to runtime_ai_calls
-- Used to isolate 'sample' test events from production spend metrics.
ALTER TABLE "runtime_ai_calls" ADD COLUMN IF NOT EXISTS "source" text;
