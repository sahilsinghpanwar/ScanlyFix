CREATE TABLE "runtime_ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"user_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_spend_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"spent_micro_usd" bigint NOT NULL,
	"projected_micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "runtime_spend_ceiling_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "runtime_ai_calls" ADD CONSTRAINT "runtime_ai_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_spend_alerts" ADD CONSTRAINT "runtime_spend_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_ai_calls_project_created_idx" ON "runtime_ai_calls" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_spend_alerts_uq" ON "runtime_spend_alerts" USING btree ("project_id","hour");