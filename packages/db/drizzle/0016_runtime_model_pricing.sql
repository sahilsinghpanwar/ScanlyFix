-- Migration: add runtime_model_pricing table
-- Stores weekly cached LiteLLM pricing catalog for broad model coverage.
CREATE TABLE IF NOT EXISTS "runtime_model_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog" jsonb NOT NULL,
	"entry_count" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
