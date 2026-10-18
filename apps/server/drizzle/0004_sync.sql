CREATE TABLE "sync_changes" (
	"revision" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb,
	"client_updated_at" timestamp with time zone NOT NULL,
	"server_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"client_updated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "client_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "client_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD COLUMN "client_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_changes_user_revision_idx" ON "sync_changes" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "sync_changes_created_idx" ON "sync_changes" USING btree ("created_at");