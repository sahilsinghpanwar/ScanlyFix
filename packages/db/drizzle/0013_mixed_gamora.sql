CREATE TYPE "public"."connection_provider" AS ENUM('supabase');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'revoked', 'error');--> statement-breakpoint
CREATE TABLE "connection_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"encrypted_dek" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"external_account" text NOT NULL,
	"project_url" text NOT NULL,
	"scopes" text[] DEFAULT '{"anon_read"}' NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_scan" jsonb,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credential_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"purpose" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_secrets_connection_idx" ON "connection_secrets" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_user_provider_account_idx" ON "connections" USING btree ("user_id","provider","external_account");--> statement-breakpoint
CREATE INDEX "connections_user_created_idx" ON "connections" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "credential_access_log_connection_idx" ON "credential_access_log" USING btree ("connection_id","accessed_at" desc);