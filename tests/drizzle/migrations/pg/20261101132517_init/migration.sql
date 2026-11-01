CREATE TABLE "notes" (
	"id" serial PRIMARY KEY,
	"title" text NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL
);
