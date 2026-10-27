CREATE TABLE `agent_keys` (
	`pubkey` text PRIMARY KEY NOT NULL,
	`encrypted_secret_key` text NOT NULL,
	`client_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`agent_pubkey` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_pubkey`) REFERENCES `agent_keys`(`pubkey`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_tokens_agent_idx` ON `oauth_tokens` (`agent_pubkey`);--> statement-breakpoint
CREATE TABLE `pairing_sessions` (
	`code` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ephemeral_pubkey` text,
	`authorization_id` text,
	`gift_wrap_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pairing_sessions_expires_idx` ON `pairing_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `queue_bindings` (
	`agent_pubkey` text PRIMARY KEY NOT NULL,
	`queue_pubkey` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_pubkey`) REFERENCES `agent_keys`(`pubkey`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `queue_bindings_queue_idx` ON `queue_bindings` (`queue_pubkey`);