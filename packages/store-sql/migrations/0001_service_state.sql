-- Replaces the 0000_init tables with the service state of spec v0.3 (8.5). 0000 reached the
-- remote D1 database on 2026-10-27, but no route wrote to it, so its tables are empty and are
-- dropped rather than altered. Children before parents, for the foreign keys.
DROP TABLE `oauth_tokens`;--> statement-breakpoint
DROP TABLE `queue_bindings`;--> statement-breakpoint
DROP TABLE `pairing_sessions`;--> statement-breakpoint
DROP TABLE `agent_keys`;--> statement-breakpoint
DROP TABLE `oauth_clients`;--> statement-breakpoint
CREATE TABLE `agent_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`pubkey` text NOT NULL,
	`encrypted_secret_key` blob,
	`key_version` integer NOT NULL,
	`client_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_keys_pubkey_idx` ON `agent_keys` (`pubkey`);--> statement-breakpoint
CREATE INDEX `agent_keys_client_idx` ON `agent_keys` (`client_id`);--> statement-breakpoint
CREATE INDEX `agent_keys_key_version_idx` ON `agent_keys` (`key_version`);--> statement-breakpoint
CREATE TABLE `bindings` (
	`agent_key_id` text PRIMARY KEY NOT NULL,
	`queue_pubkey` text NOT NULL,
	`client_label` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bindings_queue_idx` ON `bindings` (`queue_pubkey`);--> statement-breakpoint
CREATE TABLE `hosted_queues` (
	`queue_pubkey` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nip98_replays` (
	`event_id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nip98_replays_expires_idx` ON `nip98_replays` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`metadata` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`registration_source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`agent_key_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oauth_codes_agent_key_idx` ON `oauth_codes` (`agent_key_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`agent_key_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_tokens_agent_key_idx` ON `oauth_tokens` (`agent_key_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_expires_idx` ON `oauth_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pairing_sessions` (
	`code` text PRIMARY KEY NOT NULL,
	`queue_pubkey` text NOT NULL,
	`uri` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pairing_sessions_expires_idx` ON `pairing_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pending_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`status` text NOT NULL,
	`agent_key_id` text,
	`queue_pubkey` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_authorizations_user_code_idx` ON `pending_authorizations` (`user_code`);--> statement-breakpoint
CREATE INDEX `pending_authorizations_expires_idx` ON `pending_authorizations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_authorizations_agent_key_idx` ON `pending_authorizations` (`agent_key_id`);--> statement-breakpoint
CREATE TABLE `submission_receipts` (
	`gift_wrap_id` text PRIMARY KEY NOT NULL,
	`agent_key_id` text NOT NULL,
	`queue_pubkey` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`agent_key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `submission_receipts_agent_created_idx` ON `submission_receipts` (`agent_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `submission_receipts_expires_idx` ON `submission_receipts` (`expires_at`);