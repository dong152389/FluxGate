export const CREATE_TABLES_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS users (
		id VARCHAR(64) NOT NULL,
		username VARCHAR(64) NOT NULL,
		email VARCHAR(191) NULL,
		email_verified TINYINT NOT NULL DEFAULT 0,
		password_hash VARCHAR(255) NOT NULL,
		password_salt VARCHAR(255) NOT NULL,
		status VARCHAR(32) NOT NULL DEFAULT 'active',
		created_at VARCHAR(64) NOT NULL,
		updated_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY uq_users_username (username),
		UNIQUE KEY uq_users_email (email)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS user_settings (
		user_id VARCHAR(64) NOT NULL,
		public_token VARCHAR(64) NOT NULL,
		dedupe_enabled TINYINT NOT NULL DEFAULT 1,
		prefix_source_name TINYINT NOT NULL DEFAULT 1,
		source_prefix_template VARCHAR(120) NOT NULL DEFAULT '[{{source}}] ',
		keep_unnamed TINYINT NOT NULL DEFAULT 1,
		sort_mode VARCHAR(32) NOT NULL DEFAULT 'source-priority',
		clash_template_id VARCHAR(64) NOT NULL DEFAULT 'fixed-full',
		clash_group_order TEXT NULL,
		cache_version INT NOT NULL DEFAULT 1,
		created_at VARCHAR(64) NOT NULL,
		updated_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (user_id),
		UNIQUE KEY uq_user_settings_public_token (public_token),
		CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS sources (
		id VARCHAR(64) NOT NULL,
		user_id VARCHAR(64) NOT NULL,
		type VARCHAR(32) NOT NULL DEFAULT 'url',
		name VARCHAR(120) NOT NULL,
		v2ray_url_encrypted MEDIUMTEXT NULL,
		clash_url_encrypted TEXT NULL,
		enabled TINYINT NOT NULL DEFAULT 1,
		priority INT NOT NULL DEFAULT 0,
		notes VARCHAR(255) NULL,
		created_at VARCHAR(64) NOT NULL,
		updated_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (id),
		INDEX idx_sources_user_priority (user_id, priority, name),
		CONSTRAINT fk_sources_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS rename_rules (
		id VARCHAR(64) NOT NULL,
		user_id VARCHAR(64) NOT NULL,
		type VARCHAR(32) NOT NULL,
		enabled TINYINT NOT NULL DEFAULT 1,
		match_text VARCHAR(255) NULL,
		replace_text VARCHAR(255) NULL,
		value_text VARCHAR(255) NULL,
		rule_order INT NOT NULL DEFAULT 0,
		created_at VARCHAR(64) NOT NULL,
		updated_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (id),
		INDEX idx_rename_rules_user_order (user_id, rule_order, id),
		CONSTRAINT fk_rename_rules_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS node_aliases (
		user_id VARCHAR(64) NOT NULL,
		fingerprint VARCHAR(128) NOT NULL,
		alias VARCHAR(255) NOT NULL,
		updated_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (user_id, fingerprint),
		CONSTRAINT fk_node_aliases_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS sessions (
		id VARCHAR(64) NOT NULL,
		user_id VARCHAR(64) NOT NULL,
		token_hash VARCHAR(128) NOT NULL,
		expires_at VARCHAR(64) NOT NULL,
		created_at VARCHAR(64) NOT NULL,
		last_seen_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (id),
		UNIQUE KEY uq_sessions_token_hash (token_hash),
		INDEX idx_sessions_user_id (user_id, expires_at),
		CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

	`CREATE TABLE IF NOT EXISTS verification_codes (
		id VARCHAR(64) NOT NULL,
		email VARCHAR(191) NOT NULL,
		code VARCHAR(32) NOT NULL,
		purpose VARCHAR(32) NOT NULL,
		used TINYINT NOT NULL DEFAULT 0,
		expires_at VARCHAR(64) NOT NULL,
		created_at VARCHAR(64) NOT NULL,
		PRIMARY KEY (id),
		INDEX idx_verification_codes_email_purpose (email, purpose, created_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
];
