CREATE TABLE "reflow_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "reflow_schema_version" integer;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "reflow_page_count" integer;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "reflow_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reflow_uploads" ADD CONSTRAINT "reflow_uploads_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflow_uploads" ADD CONSTRAINT "reflow_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reflow_uploads_status_expires_idx" ON "reflow_uploads" USING btree ("status","expires_at");