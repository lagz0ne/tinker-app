CREATE TABLE "issue" (
	"id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'backlog' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"assignee_id" text,
	"creator_id" text NOT NULL,
	"rank" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_state" CHECK ("state" in ('backlog', 'todo', 'in_progress', 'done', 'canceled')),
	CONSTRAINT "issue_priority" CHECK ("priority" between 0 and 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_team_number" ON "issue" ("team_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_team_external_id" ON "issue" ("team_id","external_id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_assignee_id_user_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_creator_id_user_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "user"("id");