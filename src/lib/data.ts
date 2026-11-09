import {
	buildPublicClientUrl,
	buildPublicUrl,
	decryptText,
	encryptText,
	nowIso,
	randomId,
	randomToken,
	sha256Base64Url,
	hashPassword,
	verifyPassword,
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
	DatabaseClient,
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
	db: DatabaseClient,
	username: string,
): Promise<UserRow | null> {
	return db.queryRow<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
}

export async function findUserByEmail(
	db: DatabaseClient,
	email: string,
): Promise<UserRow | null> {
	return db.queryRow<UserRow>("SELECT * FROM users WHERE email = ?", [email]);
}

export async function updateUserEmail(
	db: DatabaseClient,
	userId: string,
	email: string | null,
): Promise<void> {
	await db.execute(
		"UPDATE users SET email = ?, updated_at = ? WHERE id = ?",
		[email, nowIso(), userId],
	);
}

export async function findUserById(
	db: DatabaseClient,
	userId: string,
): Promise<UserRow | null> {
	return db.queryRow<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
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

	await db.execute(
		"INSERT INTO users (id, username, email, password_hash, password_salt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
		[
			userId,
			input.username,
			input.email,
			input.passwordHash,
			input.passwordSalt,
			timestamp,
			timestamp,
		],
	);

	await db.execute(
		"INSERT INTO user_settings (user_id, public_token, dedupe_enabled, prefix_source_name, source_prefix_template, keep_unnamed, sort_mode, clash_template_id, clash_group_order, cache_version, created_at, updated_at) VALUES (?, ?, 1, 1, '[{{source}}] ', 1, 'source-priority', 'fixed-full', NULL, 1, ?, ?)",
		[userId, randomToken(24), timestamp, timestamp],
	);

	return {
		id: userId,
		username: input.username,
		email: input.email,
		emailVerified: false,
	};
}

export async function createSession(
	db: DatabaseClient,
	userId: string,
	ttlSeconds: number,
): Promise<string> {
	const token = randomToken(32);
	const tokenHashValue = await sha256Base64Url(token);
	const createdAt = nowIso();
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

	await db.execute(
		"INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
		[randomId(), userId, tokenHashValue, expiresAt, createdAt, createdAt],
	);

	return token;
}

export async function findSessionUser(
	db: DatabaseClient,
	tokenHash: string,
): Promise<SessionUserRow | null> {
	return db.queryRow<SessionUserRow>(
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
		[tokenHash],
	);
}

export async function touchSession(
	db: DatabaseClient,
	sessionId: string,
): Promise<void> {
	await db.execute(
		"UPDATE sessions SET last_seen_at = ? WHERE id = ?",
		[nowIso(), sessionId],
	);
}

export async function deleteSessionByHash(
	db: DatabaseClient,
	tokenHash: string,
): Promise<void> {
	await db.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

export async function listSources(
	db: DatabaseClient,
	userId: string,
): Promise<SourceRow[]> {
	return db.query<SourceRow>(
		"SELECT * FROM sources WHERE user_id = ? ORDER BY priority ASC, name ASC",
		[userId],
	);
}

export async function listRenameRules(
	db: DatabaseClient,
	userId: string,
): Promise<RenameRuleRow[]> {
	return db.query<RenameRuleRow>(
		"SELECT * FROM rename_rules WHERE user_id = ? ORDER BY rule_order ASC, id ASC",
		[userId],
	);
}

export async function listAliases(
	db: DatabaseClient,
	userId: string,
): Promise<Map<string, string>> {
	const rows = await db.query<NodeAliasRow>(
		"SELECT * FROM node_aliases WHERE user_id = ?",
		[userId],
	);
	return new Map(rows.map((entry) => [entry.fingerprint, entry.alias]));
}

export async function getSettings(
	db: DatabaseClient,
	userId: string,
): Promise<UserSettingsRow | null> {
	return db.queryRow<UserSettingsRow>(
		"SELECT * FROM user_settings WHERE user_id = ?",
		[userId],
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
		sourceRows.map(async (source) => {
			const v2rayDecrypted = source.v2ray_url_encrypted
				? await decryptText(source.v2ray_url_encrypted, env)
				: "";
			const clashDecrypted = source.clash_url_encrypted
				? await decryptText(source.clash_url_encrypted, env)
				: "";
			const unifiedUrl = v2rayDecrypted || clashDecrypted;
			return {
				id: source.id,
				name: source.name,
				url: unifiedUrl,
				v2rayUrl: unifiedUrl,
				clashUrl: "",
				enabled: Boolean(source.enabled),
				priority: source.priority,
				notes: source.notes ?? "",
			} satisfies SourceConfig;
		}),
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

	await db.execute(
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
		[
			payload.settings.dedupeEnabled ? 1 : 0,
			payload.settings.prefixSourceName ? 1 : 0,
			payload.settings.sourcePrefixTemplate,
			payload.settings.keepUnnamed ? 1 : 0,
			payload.settings.sortMode,
			clashTemplateId,
			serializeClashGroupOrder(payload.settings.clashGroupOrder, clashTemplateId),
			timestamp,
			userId,
		],
	);

	await db.execute("DELETE FROM sources WHERE user_id = ?", [userId]);
	for (const source of payload.sources) {
		const targetUrl = (source.url || source.v2rayUrl || source.clashUrl || "").trim();
		await db.execute(
			`INSERT INTO sources
			 (id, user_id, type, name, v2ray_url_encrypted, clash_url_encrypted, enabled, priority, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				source.id,
				userId,
				source.type === "yaml" || source.type === "nodes" ? source.type : "url",
				source.name,
				targetUrl ? await encryptText(targetUrl, env) : null,
				null,
				source.enabled ? 1 : 0,
				source.priority,
				source.notes,
				timestamp,
				timestamp,
			],
		);
	}

	await db.execute("DELETE FROM rename_rules WHERE user_id = ?", [userId]);
	for (const rule of payload.renameRules) {
		await db.execute(
			`INSERT INTO rename_rules
			 (id, user_id, type, enabled, match_text, replace_text, value_text, rule_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
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
			],
		);
	}
}

export async function saveAlias(
	db: DatabaseClient,
	userId: string,
	fingerprint: string,
	alias: string,
): Promise<void> {
	if (!alias) {
		await db.execute(
			"DELETE FROM node_aliases WHERE user_id = ? AND fingerprint = ?",
			[userId, fingerprint],
		);
		return;
	}

	await db.execute(
		`INSERT INTO node_aliases (user_id, fingerprint, alias, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE alias = VALUES(alias), updated_at = VALUES(updated_at)`,
		[userId, fingerprint, alias, nowIso()],
	);
}

export async function saveAliasesBatch(
	db: DatabaseClient,
	userId: string,
	updates: Array<{ fingerprint: string; alias: string }>,
): Promise<void> {
	if (updates.length === 0) {
		return;
	}

	const now = nowIso();
	for (const { fingerprint, alias } of updates) {
		if (alias) {
			await db.execute(
				`INSERT INTO node_aliases (user_id, fingerprint, alias, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE alias = VALUES(alias), updated_at = VALUES(updated_at)`,
				[userId, fingerprint, alias, now],
			);
		} else {
			await db.execute(
				"DELETE FROM node_aliases WHERE user_id = ? AND fingerprint = ?",
				[userId, fingerprint],
			);
		}
	}
}

export async function bumpCacheVersion(
	db: DatabaseClient,
	userId: string,
): Promise<UserSettingsRow> {
	await db.execute(
		"UPDATE user_settings SET cache_version = cache_version + 1, updated_at = ? WHERE user_id = ?",
		[nowIso(), userId],
	);
	return getSettingsOrThrow(db, userId);
}

export async function rotatePublicToken(
	db: DatabaseClient,
	userId: string,
): Promise<UserSettingsRow> {
	await db.execute(
		`UPDATE user_settings
		 SET public_token = ?, cache_version = cache_version + 1, updated_at = ?
		 WHERE user_id = ?`,
		[randomToken(24), nowIso(), userId],
	);
	return getSettingsOrThrow(db, userId);
}

export async function getPublicSubscriptionContext(
	db: DatabaseClient,
	token: string,
): Promise<PublicSubscriptionContext | null> {
	const settings = await db.queryRow<UserSettingsRow>(
		"SELECT * FROM user_settings WHERE public_token = ?",
		[token],
	);

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
	db: DatabaseClient,
	userId: string,
): Promise<UserSettingsRow> {
	const settings = await getSettings(db, userId);
	if (!settings) {
		throw new Error("User settings missing");
	}
	return settings;
}

export async function initDefaultAdmin(env: AppEnv): Promise<void> {
	const username = (env.ADMIN_USERNAME || "").trim();
	const password = env.ADMIN_PASSWORD || "";
	if (!username || !password) {
		return;
	}

	if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
		console.warn(`[FluxGate] ADMIN_USERNAME "${username}" 不合法（需为 3-32 位字母、数字、下划线、点或短横线）`);
		return;
	}

	if (password.length < 8 || password.length > 128) {
		console.warn("[FluxGate] ADMIN_PASSWORD 长度需在 8 到 128 位之间");
		return;
	}

	const db = env.DB;
	const existingUser = await findUserByUsername(db, username);

	if (existingUser) {
		const matches = await verifyPassword(
			password,
			existingUser.password_hash,
			existingUser.password_salt,
		);
		if (!matches) {
			const { hash, salt } = await hashPassword(password);
			await db.execute(
				"UPDATE users SET password_hash = ?, password_salt = ?, status = 'active', email_verified = 1, updated_at = ? WHERE id = ?",
				[hash, salt, nowIso(), existingUser.id],
			);
			console.log(`[FluxGate] 默认超级管理员 "${username}" 密码已更新为 .env 配置。`);
		} else if (existingUser.status !== "active" || !existingUser.email_verified) {
			await db.execute(
				"UPDATE users SET status = 'active', email_verified = 1, updated_at = ? WHERE id = ?",
				[nowIso(), existingUser.id],
			);
		}
		return;
	}

	let email = (env.ADMIN_EMAIL || "").trim() || null;
	if (email) {
		const existingEmail = await findUserByEmail(db, email);
		if (existingEmail) {
			console.warn(`[FluxGate] ADMIN_EMAIL "${email}" 已被占用，管理员账号将不绑定该邮箱`);
			email = null;
		}
	}

	const { hash, salt } = await hashPassword(password);
	const userId = randomId();
	const createdAt = "2000-01-01T00:00:00.000Z";
	const timestamp = nowIso();

	await db.execute(
		"INSERT INTO users (id, username, email, email_verified, password_hash, password_salt, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 'active', ?, ?)",
		[userId, username, email, hash, salt, createdAt, timestamp],
	);

	await db.execute(
		"INSERT INTO user_settings (user_id, public_token, dedupe_enabled, prefix_source_name, source_prefix_template, keep_unnamed, sort_mode, clash_template_id, clash_group_order, cache_version, created_at, updated_at) VALUES (?, ?, 1, 1, '[{{source}}] ', 1, 'source-priority', 'fixed-full', NULL, 1, ?, ?)",
		[userId, randomToken(24), createdAt, timestamp],
	);

	console.log(`[FluxGate] 默认超级管理员 "${username}" 初始化成功。`);
}

export async function isAdmin(
	envOrDb: AppEnv | DatabaseClient,
	userId: string,
): Promise<boolean> {
	const db = "DB" in envOrDb ? envOrDb.DB : envOrDb;
	const adminUsername = "DB" in envOrDb ? envOrDb.ADMIN_USERNAME?.trim() : undefined;

	if (adminUsername) {
		const adminUser = await db.queryRow<{ id: string }>(
			"SELECT id FROM users WHERE username = ?",
			[adminUsername],
		);
		if (adminUser) {
			return adminUser.id === userId;
		}
	}

	const firstUser = await db.queryRow<{ id: string }>(
		"SELECT id FROM users ORDER BY created_at ASC LIMIT 1",
	);
	return firstUser ? firstUser.id === userId : false;
}

export async function listAllUsers(
	envOrDb: AppEnv | DatabaseClient,
): Promise<AdminUserListItem[]> {
	const db = "DB" in envOrDb ? envOrDb.DB : envOrDb;
	const adminUsername = "DB" in envOrDb ? envOrDb.ADMIN_USERNAME?.trim() : undefined;

	const rows = await db.query<AdminUserListItem>(
		"SELECT id, username, email, status, created_at, updated_at FROM users ORDER BY created_at ASC",
	);
	const hasConfiguredAdmin = Boolean(
		adminUsername && rows.some((u) => u.username === adminUsername),
	);
	return rows.map((user, index) => ({
		...user,
		isAdmin: hasConfiguredAdmin ? user.username === adminUsername : index === 0,
	}));
}

export async function updateUserStatus(
	db: DatabaseClient,
	userId: string,
	status: "active" | "disabled",
): Promise<void> {
	await db.execute(
		"UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
		[status, nowIso(), userId],
	);
}

export async function deleteUserAndData(db: DatabaseClient, userId: string): Promise<void> {
	await db.execute("DELETE FROM users WHERE id = ?", [userId]);
}

export async function createVerificationCode(
	db: DatabaseClient,
	input: { email: string; code: string; purpose: string; ttlMinutes: number },
): Promise<void> {
	const createdAt = nowIso();
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000).toISOString();
	await db.execute(
		`INSERT INTO verification_codes (id, email, code, purpose, used, expires_at, created_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		[randomId(), input.email, input.code, input.purpose, expiresAt, createdAt],
	);
}

export async function findLatestVerificationCode(
	db: DatabaseClient,
	email: string,
	purpose: string,
): Promise<{ id: string; code: string; used: number; expires_at: string } | null> {
	return db.queryRow<{ id: string; code: string; used: number; expires_at: string }>(
		`SELECT id, code, used, expires_at FROM verification_codes
		 WHERE email = ? AND purpose = ?
		 ORDER BY created_at DESC LIMIT 1`,
		[email, purpose],
	);
}

export async function markVerificationCodeUsed(db: DatabaseClient, id: string): Promise<void> {
	await db.execute("UPDATE verification_codes SET used = 1 WHERE id = ?", [id]);
}

export async function updateUserEmailVerified(
	db: DatabaseClient,
	userId: string,
	verified: boolean,
): Promise<void> {
	await db.execute(
		"UPDATE users SET email_verified = ?, updated_at = ? WHERE id = ?",
		[verified ? 1 : 0, nowIso(), userId],
	);
}
