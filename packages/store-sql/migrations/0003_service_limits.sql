CREATE TABLE `usage_counters` (
	`scope` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `usage_counters_expires_idx` ON `usage_counters` (`expires_at`);--> statement-breakpoint
ALTER TABLE `pending_authorizations` ADD `client_ip_hash` text;--> statement-breakpoint
CREATE INDEX `pending_authorizations_client_ip_idx` ON `pending_authorizations` (`client_ip_hash`,`expires_at`);--> statement-breakpoint
CREATE INDEX `submission_receipts_queue_created_idx` ON `submission_receipts` (`queue_pubkey`,`created_at`);