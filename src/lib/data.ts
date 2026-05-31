import {
	buildPublicClientUrl,
	buildPublicUrl,
	decryptText,
	encryptText,
	nowIso,
	randomId,
	randomToken,
} from "./security";
import {
	listClashTemplatePresets,
	parseClashGroupOrder,
	resolveClashTemplateId,
	serializeClashGroupOrder,
} from "./mihomo-template-presets";
import type {
	AdminUserListItem,
	AppEnv,
	AggregationConfigResponse,
	NodeAliasRow,
	PublicSubscriptionContext,
	RenameRuleConfig,
	RenameRuleRow,
	SaveConfigPayload,
	SessionUserRow,
	SourceConfig,
	SourceRow,
	UserProfile,
	UserRow,
	UserSettingsConfig,
	UserSettingsRow,
} from "./types";

export async function findUserByUsername(
	db: D1Database,
	username: string,
): Promise<UserRow | null> {
	return (
		(await db
			.prepare("SELECT * FROM users WHERE username = ?")
			.bind(username)
			.first<UserRow>()) ?? null
	);
}

export async function findUserByEmail(
	db: D1Database,
	email: string,
): Promise<UserRow | null> {
	return (
		(await db
			.prepare("SELECT * FROM users WHERE email = ?")
			.bind(email)
			.first<UserRow>()) ?? null
	);
}

export async function updateUserEmail(
	db: D1Database,
	userId: string,
	email: string | null,
): Promise<void> {
	await db
		.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?")
		.bind(email, nowIso(), userId)
		.run();
}

export async function findUserById(
	db: D1Database,
	userId: string,
): Promise<UserRow | null> {
	return (
		(await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>()) ?? null
	);
}

export async function createUser(
	env: AppEnv,
	input: {
		username: string;
		email: string | null;
		passwordHash: string;
		passwordSalt: string;
	},
): Promise<UserProfile> {
	const db = env.DB;
	const userId = randomId();
	const timestamp = nowIso();

	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, password_salt, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
		)
		.bind(
			userId,
			input.username,
			input.email,
			input.passwordHash,
			input.passwordSalt,
			timestamp,
			timestamp,
		)
		.run();

	await db
		.prepare(
			`INSERT INTO user_settings
			 (user_id, public_token, dedupe_enabled, prefix_source_name, source_prefix_template, keep_unnamed, sort_mode, cache_version, created_at, updated_at)
			 VALUES (?, ?, 1, 1, '[{{source}}] ', 1, 'source-priority', 1, ?, ?)`,
		)
		.bind(userId, randomToken(24), timestamp, timestamp)
		.run();

	return {
		id: userId,
		username: input.username,
		email: input.email,
		emailVerified: false,
	};
}

export async function createSession(
	db: D1Database,
	userId: string,
	ttlSeconds: number,
): Promise<string> {
	const token = randomToken(32);
	const tokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const tokenHashValue = btoa(String.fromCharCode(...new Uint8Array(tokenHash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");

	const createdAt = nowIso();
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

	await db
		.prepare(
			`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(randomId(), userId, tokenHashValue, expiresAt, createdAt, createdAt)
		.run();

	return token;
}

export async function findSessionUser(
	db: D1Database,
	tokenHash: string,
): Promise<SessionUserRow | null> {
	return (
		(await db
			.prepare(
				`SELECT
				 sessions.id AS session_id,
				 sessions.expires_at,
				 sessions.last_seen_at,
				 users.id AS user_id,
				 users.username,
				 users.email,
				 users.email_verified,
				 users.status
				 FROM sessions
				 JOIN users ON users.id = sessions.user_id
				 WHERE sessions.token_hash = ?`,
			)
			.bind(tokenHash)
			.first<SessionUserRow>()) ?? null
	);
}

export async function touchSession(
	db: D1Database,
	sessionId: string,
): Promise<void> {
	await db
		.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
		.bind(nowIso(), sessionId)
		.run();
}

export async function deleteSessionByHash(
	db: D1Database,
	tokenHash: string,
): Promise<void> {
	await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function listSources(
	db: D1Database,
	userId: string,
): Promise<SourceRow[]> {
	const result = await db
		.prepare("SELECT * FROM sources WHERE user_id = ? ORDER BY priority ASC, name ASC")
		.bind(userId)
		.all<SourceRow>();
	return result.results ?? [];
}

export async function listRenameRules(
	db: D1Database,
	userId: string,
): Promise<RenameRuleRow[]> {
	const result = await db
		.prepare("SELECT * FROM rename_rules WHERE user_id = ? ORDER BY rule_order ASC, id ASC")
		.bind(userId)
		.all<RenameRuleRow>();
	return result.results ?? [];
}

export async function listAliases(
	db: D1Database,
	userId: string,
): Promise<Map<string, string>> {
	const result = await db
		.prepare("SELECT * FROM node_aliases WHERE user_id = ?")
		.bind(userId)
		.all<NodeAliasRow>();
	return new Map((result.results ?? []).map((entry) => [entry.fingerprint, entry.alias]));
}

export async function getSettings(
	db: D1Database,
	userId: string,
): Promise<UserSettingsRow | null> {
	return (
		(await db
			.prepare("SELECT * FROM user_settings WHERE user_id = ?")
			.bind(userId)
			.first<UserSettingsRow>()) ?? null
	);
}

export async function getConfigResponse(
	request: Request,
	env: AppEnv,
	user: UserProfile,
): Promise<AggregationConfigResponse> {
	const settings = await getSettingsOrThrow(env.DB, user.id);
	const sourceRows = await listSources(env.DB, user.id);
	const renameRuleRows = await listRenameRules(env.DB, user.id);

	const sources = await Promise.all(
		sourceRows.map(async (source) => ({
			id: source.id,
			name: source.name,
			v2rayUrl: source.v2ray_url_encrypted
				? await decryptText(source.v2ray_url_encrypted, env)
				: "",
			clashUrl: source.clash_url_encrypted
				? await decryptText(source.clash_url_encrypted, env)
				: "",
			enabled: Boolean(source.enabled),
			priority: source.priority,
			notes: source.notes ?? "",
		} satisfies SourceConfig)),
	);

	const renameRules = renameRuleRows.map(
		(rule) =>
			({
				id: rule.id,
				type: rule.type,
				enabled: Boolean(rule.enabled),
				match: rule.match_text ?? "",
				replace: rule.replace_text ?? "",
				value: rule.value_text ?? "",
				order: rule.rule_order,
			}) satisfies RenameRuleConfig,
	);

	const selectedTemplateId = resolveClashTemplateId(settings.clash_template_id);
	const clashTemplates = listClashTemplatePresets().map((preset) => ({
		id: preset.id,
		label: preset.label,
		shortLabel: preset.shortLabel,
		category: preset.category,
		description: preset.description,
		policyGroups: preset.policyGroups,
		includeAutoSelect: preset.includeAutoSelect,
		groupOrder: preset.groupOrder,
		url: buildPublicClientUrl(request, env, settings.public_token, "clash", preset.id),
		isDefault: preset.id === selectedTemplateId,
	}));

	return {
		user,
		publicToken: settings.public_token,
		publicUrl: buildPublicUrl(request, env, settings.public_token),
		publicUrls: {
			v2ray: buildPublicUrl(request, env, settings.public_token),
			clash: buildPublicClientUrl(request, env, settings.public_token, "clash"),
			raw: buildPublicClientUrl(request, env, settings.public_token, "raw"),
		},
		clashTemplates,
		settings: settingsRowToConfig(settings),
		sources,
		renameRules,
	};
}

export function settingsRowToConfig(settings: UserSettingsRow): UserSettingsConfig {
	const clashTemplateId = resolveClashTemplateId(settings.clash_template_id);
	return {
		dedupeEnabled: Boolean(settings.dedupe_enabled),
		prefixSourceName: Boolean(settings.prefix_source_name),
		sourcePrefixTemplate: settings.source_prefix_template,
		keepUnnamed: Boolean(settings.keep_unnamed),
		sortMode: settings.sort_mode,
		clashTemplateId,
		clashGroupOrder: parseClashGroupOrder(settings.clash_group_order, clashTemplateId),
	};
}

export async function saveConfig(
	env: AppEnv,
	userId: string,
	payload: SaveConfigPayload,
): Promise<void> {
	const db = env.DB;
	const timestamp = nowIso();
	const clashTemplateId = resolveClashTemplateId(payload.settings.clashTemplateId);

	await db
		.prepare(
			`UPDATE user_settings
			 SET dedupe_enabled = ?,
			     prefix_source_name = ?,
			     source_prefix_template = ?,
			     keep_unnamed = ?,
			     sort_mode = ?,
			     clash_template_id = ?,
			     clash_group_order = ?,
			     cache_version = cache_version + 1,
			     updated_at = ?
			 WHERE user_id = ?`,
		)
		.bind(
			payload.settings.dedupeEnabled ? 1 : 0,
			payload.settings.prefixSourceName ? 1 : 0,
			payload.settings.sourcePrefixTemplate,
			payload.settings.keepUnnamed ? 1 : 0,
			payload.settings.sortMode,
			clashTemplateId,
			serializeClashGroupOrder(payload.settings.clashGroupOrder, clashTemplateId),
			timestamp,
			userId,
		)
		.run();

	await db.prepare("DELETE FROM sources WHERE user_id = ?").bind(userId).run();
	for (const source of payload.sources) {
		await db
			.prepare(
				`INSERT INTO sources
				 (id, user_id, name, v2ray_url_encrypted, clash_url_encrypted, enabled, priority, notes, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				source.id,
				userId,
				source.name,
				source.v2rayUrl ? await encryptText(source.v2rayUrl, env) : null,
				source.clashUrl ? await encryptText(source.clashUrl, env) : null,
				source.enabled ? 1 : 0,
				source.priority,
				source.notes,
				timestamp,
				timestamp,
			)
			.run();
	}

	await db.prepare("DELETE FROM rename_rules WHERE user_id = ?").bind(userId).run();
	for (const rule of payload.renameRules) {
		await db
			.prepare(
				`INSERT INTO rename_rules
				 (id, user_id, type, enabled, match_text, replace_text, value_text, rule_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				rule.id,
				userId,
				rule.type,
				rule.enabled ? 1 : 0,
				rule.match,
				rule.replace,
				rule.value,
				rule.order,
				timestamp,
				timestamp,
			)
			.run();
	}
}

export async function saveAlias(
	db: D1Database,
	userId: string,
	fingerprint: string,
	alias: string,
): Promise<void> {
	if (!alias) {
		await db
			.prepare("DELETE FROM node_aliases WHERE user_id = ? AND fingerprint = ?")
			.bind(userId, fingerprint)
			.run();
		return;
	}

	await db
		.prepare(
			`INSERT INTO node_aliases (user_id, fingerprint, alias, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, fingerprint) DO UPDATE
			 SET alias = excluded.alias,
			     updated_at = excluded.updated_at`,
		)
		.bind(userId, fingerprint, alias, nowIso())
		.run();
}

export async function saveAliasesBatch(
	db: D1Database,
	userId: string,
	updates: Array<{ fingerprint: string; alias: string }>,
): Promise<void> {
	if (updates.length === 0) {
		return;
	}

	const now = nowIso();
	const statements = updates.map(({ fingerprint, alias }) =>
		alias
			? db
					.prepare(
						`INSERT INTO node_aliases (user_id, fingerprint, alias, updated_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(user_id, fingerprint) DO UPDATE
						 SET alias = excluded.alias,
						     updated_at = excluded.updated_at`,
					)
					.bind(userId, fingerprint, alias, now)
			: db
					.prepare("DELETE FROM node_aliases WHERE user_id = ? AND fingerprint = ?")
					.bind(userId, fingerprint),
	);

	await db.batch(statements);
}

export async function bumpCacheVersion(
	db: D1Database,
	userId: string,
): Promise<UserSettingsRow> {
	await db
		.prepare(
			"UPDATE user_settings SET cache_version = cache_version + 1, updated_at = ? WHERE user_id = ?",
		)
		.bind(nowIso(), userId)
		.run();
	return getSettingsOrThrow(db, userId);
}

export async function rotatePublicToken(
	db: D1Database,
	userId: string,
): Promise<UserSettingsRow> {
	await db
		.prepare(
			`UPDATE user_settings
			 SET public_token = ?, cache_version = cache_version + 1, updated_at = ?
			 WHERE user_id = ?`,
		)
		.bind(randomToken(24), nowIso(), userId)
		.run();
	return getSettingsOrThrow(db, userId);
}

export async function getPublicSubscriptionContext(
	db: D1Database,
	token: string,
): Promise<PublicSubscriptionContext | null> {
	const settings =
		(await db
			.prepare("SELECT * FROM user_settings WHERE public_token = ?")
			.bind(token)
			.first<UserSettingsRow>()) ?? null;

	if (!settings) {
		return null;
	}

	const user = await findUserById(db, settings.user_id);
	if (!user || user.status !== "active") {
		return null;
	}

	return {
		user: {
			id: user.id,
			username: user.username,
			email: user.email,
			emailVerified: Boolean(user.email_verified),
		},
		settings,
		sources: await listSources(db, user.id),
		renameRules: await listRenameRules(db, user.id),
		aliases: await listAliases(db, user.id),
	};
}

export async function getSettingsOrThrow(
	db: D1Database,
	userId: string,
): Promise<UserSettingsRow> {
	const settings = await getSettings(db, userId);
	if (!settings) {
		throw new Error("User settings missing");
	}
	return settings;
}

export async function isAdmin(db: D1Database, userId: string): Promise<boolean> {
	const firstUser = await db
		.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
		.first<{ id: string }>();
	return firstUser ? firstUser.id === userId : false;
}

export async function listAllUsers(db: D1Database): Promise<AdminUserListItem[]> {
	const result = await db
		.prepare("SELECT id, username, email, status, created_at, updated_at FROM users ORDER BY created_at ASC")
		.all<AdminUserListItem>();
	const rows = result.results ?? [];
	return rows.map((user, index) => ({ ...user, isAdmin: index === 0 }));
}

export async function updateUserStatus(
	db: D1Database,
	userId: string,
	status: "active" | "disabled",
): Promise<void> {
	await db
		.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
		.bind(status, nowIso(), userId)
		.run();
}

export async function deleteUserAndData(db: D1Database, userId: string): Promise<void> {
	await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

export async function createVerificationCode(
	db: D1Database,
	input: { email: string; code: string; purpose: string; ttlMinutes: number },
): Promise<void> {
	const createdAt = nowIso();
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000).toISOString();
	await db
		.prepare(
			`INSERT INTO verification_codes (id, email, code, purpose, used, expires_at, created_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		)
		.bind(randomId(), input.email, input.code, input.purpose, expiresAt, createdAt)
		.run();
}

export async function findLatestVerificationCode(
	db: D1Database,
	email: string,
	purpose: string,
): Promise<{ id: string; code: string; used: number; expires_at: string } | null> {
	return (
		(await db
			.prepare(
				`SELECT id, code, used, expires_at FROM verification_codes
				 WHERE email = ? AND purpose = ?
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(email, purpose)
			.first<{ id: string; code: string; used: number; expires_at: string }>()) ?? null
	);
}

export async function markVerificationCodeUsed(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE verification_codes SET used = 1 WHERE id = ?").bind(id).run();
}

export async function updateUserEmailVerified(
	db: D1Database,
	userId: string,
	verified: boolean,
): Promise<void> {
	await db
		.prepare("UPDATE users SET email_verified = ?, updated_at = ? WHERE id = ?")
		.bind(verified ? 1 : 0, nowIso(), userId)
		.run();
}
