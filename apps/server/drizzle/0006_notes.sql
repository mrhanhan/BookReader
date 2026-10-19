CREATE TABLE "note_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"scope" jsonb NOT NULL,
	"note_count" integer NOT NULL,
	"analyzed_count" integer NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"model" text,
	"prompt_version" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_analyses" ADD CONSTRAINT "note_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_analyses_user_created_idx" ON "note_analyses" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "annotations_user_updated_idx" ON "annotations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "annotations_tags_idx" ON "annotations" USING gin ("tags");