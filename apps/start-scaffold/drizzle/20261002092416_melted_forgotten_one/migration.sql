CREATE TABLE "public_counter" (
	"id" integer PRIMARY KEY,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_event" (
	"stream" text,
	"revision" integer,
	"executionId" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "sync_event_pkey" PRIMARY KEY("stream","revision")
);
--> statement-breakpoint
CREATE TABLE "sync_execution" (
	"id" text PRIMARY KEY,
	"stream" text NOT NULL,
	"notification" jsonb,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "sync_stream" (
	"id" text PRIMARY KEY,
	"revision" integer DEFAULT 0 NOT NULL
);
