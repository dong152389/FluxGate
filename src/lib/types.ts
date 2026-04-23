export interface AppEnv {
	DB: D1Database;
	CACHE?: KVNamespace;
	ASSETS: Fetcher;
	APP_SECRET?: string;
	APP_NAME?: string;
	PUBLIC_BASE_URL?: string;
	SESSION_TTL_DAYS?: string;
	CACHE_TTL_SECONDS?: string;
	SMTP_HOST?: string;
	SMTP_PORT?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	SMTP_FROM?: string;
	EMAIL_WHITELIST?: string;
}

export type UserStatus = "active" | "disabled";
export type RenameRuleKind = "prefix" | "suffix" | "replace" | "regex";
export type SortMode = "source-priority" | "name";

export interface UserRow {
	id: string;
	username: string;
	email: string | null;
	email_verified: number;
	password_hash: string;
	password_salt: string;
	status: UserStatus;
	created_at: string;
	updated_at: string;
}

export interface UserSettingsRow {
	user_id: string;
	public_token: string;
	dedupe_enabled: number;
	prefix_source_name: number;
	source_prefix_template: string;
	keep_unnamed: number;
	sort_mode: SortMode;
	cache_version: number;
	created_at: string;
	updated_at: string;
}

export interface SourceRow {
	id: string;
	user_id: string;
	name: string;
	url_encrypted: string;
	enabled: number;
	priority: number;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface RenameRuleRow {
	id: string;
	user_id: string;
	type: RenameRuleKind;
	enabled: number;
	match_text: string | null;
	replace_text: string | null;
	value_text: string | null;
	rule_order: number;
	created_at: string;
	updated_at: string;
}

export interface NodeAliasRow {
	user_id: string;
	fingerprint: string;
	alias: string;
	updated_at: string;
}

export interface SessionRow {
	id: string;
	user_id: string;
	token_hash: string;
	expires_at: string;
	created_at: string;
	last_seen_at: string;
}

export interface SessionUserRow {
	session_id: string;
	expires_at: string;
	last_seen_at: string;
	user_id: string;
	username: string;
	email: string | null;
	email_verified: number;
	status: UserStatus;
}

export interface VerificationCodeRow {
	id: string;
	email: string;
	code: string;
	purpose: string;
	used: number;
	expires_at: string;
	created_at: string;
}

export interface UserProfile {
	id: string;
	username: string;
	email: string | null;
	emailVerified: boolean;
	isAdmin?: boolean;
}

export interface AdminUserListItem {
	id: string;
	username: string;
	email: string | null;
	status: UserStatus;
	isAdmin: boolean;
	created_at: string;
	updated_at: string;
}

export interface SourceConfig {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	priority: number;
	notes: string;
}

export interface RenameRuleConfig {
	id: string;
	type: RenameRuleKind;
	enabled: boolean;
	match: string;
	replace: string;
	value: string;
	order: number;
}

export interface UserSettingsConfig {
	dedupeEnabled: boolean;
	prefixSourceName: boolean;
	sourcePrefixTemplate: string;
	keepUnnamed: boolean;
	sortMode: SortMode;
}

export interface AggregationConfigResponse {
	user: UserProfile;
	publicToken: string;
	publicUrl: string;
	publicUrls: {
		v2ray: string;
		clash: string;
		raw: string;
	};
	settings: UserSettingsConfig;
	sources: SourceConfig[];
	renameRules: RenameRuleConfig[];
}

export interface SaveConfigPayload {
	settings: UserSettingsConfig;
	sources: SourceConfig[];
	renameRules: RenameRuleConfig[];
}

export interface SourceSummary {
	sourceId: string;
	sourceName: string;
	ok: boolean;
	nodeCount: number;
	error: string | null;
}

export interface PreviewNode {
	fingerprint: string;
	protocol: string;
	sourceId: string;
	sourceName: string;
	originalName: string;
	finalName: string;
	alias: string;
	rawUri: string;
	finalUri: string;
}

export interface PreviewResponse {
	generatedAt: string;
	sourceSummaries: SourceSummary[];
	nodeCount: number;
	successfulSources: number;
	failedSources: number;
	rawText: string;
	encodedText: string;
	nodes: PreviewNode[];
}

export interface PublicSubscriptionContext {
	user: UserProfile;
	settings: UserSettingsRow;
	sources: SourceRow[];
	renameRules: RenameRuleRow[];
	aliases: Map<string, string>;
}

export interface ParsedNode {
	kind: "vmess" | "vless" | "generic";
	protocol: string;
	rawUri: string;
	originalName: string;
	fallbackName: string;
	fingerprint: string;
	sourceId: string;
	sourceName: string;
	sourcePriority: number;
	vmessPayload?: Record<string, string>;
	urlValue?: URL;
}

export interface AggregateResult {
	nodes: PreviewNode[];
	sourceSummaries: SourceSummary[];
	successfulSources: number;
	failedSources: number;
	rawText: string;
	encodedText: string;
}

export interface ClashBuildResult {
	yamlText: string;
	proxyCount: number;
	skippedCount: number;
}
