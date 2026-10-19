CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"bytes" bigint,
	"disk_free_bytes" bigint,
	"disk_total_bytes" bigint,
	"message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_states" (
	"key" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"last_alert_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_enabled" boolean DEFAULT true NOT NULL,
	"default_timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_key_sent_idx" ON "alert_events" USING btree ("key","sent_at");--> statement-breakpoint
CREATE INDEX "backup_reports_received_idx" ON "backup_reports" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "backup_reports_source_received_idx" ON "backup_reports" USING btree ("source","received_at");