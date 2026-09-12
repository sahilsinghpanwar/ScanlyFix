-- Migration: add source column to runtime_routes
-- Used to isolate 'sample' simulation routes from real production routes.
ALTER TABLE "runtime_routes" ADD COLUMN IF NOT EXISTS "source" text;
