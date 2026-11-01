CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL
);
