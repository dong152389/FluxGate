import {
	bumpCacheVersion,
	createSession,
	createUser,
	deleteSessionByHash,
	findSessionUser,
	findUserByEmail,
	findUserByUsername,
	getConfigResponse,
	getPublicSubscriptionContext,
	listAliases,
	rotatePublicToken,
	saveAlias,
	saveAliasesBatch,
	saveConfig,
	touchSession,
	updateUserEmail,
} from "./lib/data";
import { apiError, getCookie, json, makeCookie, readJson } from "./lib/http";
import {
	buildPublicUrl,
	decryptText,
	getCacheTtlSeconds,
	getSessionCookieName,
	getSessionTtlSeconds,
	hashPassword,
	sha256Base64Url,
	verifyPassword,
} from "./lib/security";
import { aggregateSourceConfigs, aggregateSourceRows, testSingleSource } from "./lib/subscription";
import type {
	AppEnv,
	SaveConfigPayload,
	SourceConfig,
	UserProfile,
} from "./lib/types";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await routeRequest(request, env, ctx);
		} catch (error) {
			if (error instanceof HttpError) {
				return apiError(error.status, error.message);
			}
			const message = error instanceof Error ? error.message : "服务器内部错误";
			const isApi = new URL(request.url).pathname.startsWith("/api/");
			return isApi ? apiError(500, message) : new Response(message, { status: 500 });
		}
	},
} satisfies ExportedHandler<AppEnv>;

async function routeRequest(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "POST" && url.pathname === "/api/auth/register") {
		return handleRegister(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/auth/login") {
		return handleLogin(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/auth/logout") {
		return handleLogout(request, env);
	}

	if (request.method === "GET" && url.pathname === "/api/auth/me") {
		const user = await requireUser(request, env);
		return json({ user });
	}

	if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
		return handleChangePassword(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/auth/email") {
		return handleUpdateEmail(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/auth/reset-public-token") {
		return handleResetPublicToken(request, env);
	}

	if (request.method === "GET" && url.pathname === "/api/config") {
		const user = await requireUser(request, env);
		const config = await getConfigResponse(request, env, user);
		return json(config);
	}

	if (request.method === "PUT" && url.pathname === "/api/config") {
		return handleSaveConfig(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/test-source") {
		return handleTestSource(request, env);
	}

	if (request.method === "GET" && url.pathname === "/api/preview") {
		return handlePreview(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/rename-node") {
		return handleRenameNode(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/rename-nodes") {
		return handleRenameNodes(request, env);
	}

	if (request.method === "POST" && url.pathname === "/api/refresh") {
		return handleRefresh(request, env);
	}

	if (request.method === "GET" && url.pathname.startsWith("/sub/")) {
		return handlePublicSubscription(request, env, ctx);
	}

	if (url.pathname.startsWith("/api/")) {
		return apiError(404, "接口不存在");
	}

	return env.ASSETS.fetch(request);
}

async function handleRegister(request: Request, env: AppEnv): Promise<Response> {
	const body = await readJson<{ username?: string; email?: string; password?: string }>(request);
	const username = normalizeUsername(body.username);
	const email = normalizeOptionalEmail(body.email);
	const password = normalizePassword(body.password);

	const existingUser = await findUserByUsername(env.DB, username);
	if (existingUser) {
		return apiError(409, "用户名已存在");
	}

	const { hash, salt } = await hashPassword(password);
	const user = await createUser(env, {
		username,
		email,
		passwordHash: hash,
		passwordSalt: salt,
	});

	return makeSessionResponse(request, env, user);
}

async function handleLogin(request: Request, env: AppEnv): Promise<Response> {
	const body = await readJson<{ identifier?: string; username?: string; password?: string }>(request);
	const identifier = normalizeLoginIdentifier(body.identifier ?? body.username);
	const password = normalizePassword(body.password);

	const user = identifier.kind === "email"
		? await findUserByEmail(env.DB, identifier.value)
		: await findUserByUsername(env.DB, identifier.value);

	if (!user || user.status !== "active") {
		return apiError(401, "账号或密码错误");
	}

	const matches = await verifyPassword(password, user.password_hash, user.password_salt);
	if (!matches) {
		return apiError(401, "账号或密码错误");
	}

	return makeSessionResponse(request, env, {
		id: user.id,
		username: user.username,
		email: user.email,
	});
}

async function handleLogout(request: Request, env: AppEnv): Promise<Response> {
	const secure = new URL(request.url).protocol === "https:";
	const token = getCookie(request, getSessionCookieName());
	if (token) {
		const tokenHash = await sha256Base64Url(token);
		await deleteSessionByHash(env.DB, tokenHash);
	}

	return json(
		{ ok: true },
		{
			headers: {
				"Set-Cookie": makeCookie({
					name: getSessionCookieName(),
					value: "",
					maxAge: 0,
					expires: new Date(0),
					secure,
				}),
			},
		},
	);
}

async function handleChangePassword(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const body = await readJson<{
		currentPassword?: string;
		newPassword?: string;
	}>(request);
	const currentPassword = normalizePassword(body.currentPassword);
	const newPassword = normalizePassword(body.newPassword);

	const user = await findUserByUsername(env.DB, auth.user.username);
	if (!user) {
		return apiError(404, "用户不存在");
	}

	const matches = await verifyPassword(
		currentPassword,
		user.password_hash,
		user.password_salt,
	);
	if (!matches) {
		return apiError(401, "当前密码不正确");
	}

	const next = await hashPassword(newPassword);
	await env.DB
		.prepare(
			"UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?",
		)
		.bind(next.hash, next.salt, new Date().toISOString(), auth.user.id)
		.run();

	return json({ ok: true });
}

async function handleUpdateEmail(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const body = await readJson<{ email?: string; currentPassword?: string }>(request);
	const rawEmail = (body.email ?? "").trim();
	const email = rawEmail ? normalizeEmail(rawEmail) : null;
	const currentPassword = normalizePassword(body.currentPassword);

	const user = await findUserByUsername(env.DB, auth.user.username);
	if (!user) {
		return apiError(404, "用户不存在");
	}

	const matches = await verifyPassword(
		currentPassword,
		user.password_hash,
		user.password_salt,
	);
	if (!matches) {
		return apiError(401, "当前密码不正确");
	}

	if (email) {
		const existing = await findUserByEmail(env.DB, email);
		if (existing && existing.id !== user.id) {
			return apiError(409, "该邮箱已被其他账号绑定");
		}
	}

	await updateUserEmail(env.DB, user.id, email);

	return json({
		ok: true,
		user: {
			id: user.id,
			username: user.username,
			email,
		},
	});
}

async function handleResetPublicToken(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const settings = await rotatePublicToken(env.DB, auth.user.id);
	return json({
		ok: true,
		publicToken: settings.public_token,
		publicUrl: buildPublicUrl(request, env, settings.public_token),
	});
}

async function handleSaveConfig(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const body = await readJson<SaveConfigPayload>(request);
	const payload = sanitizeConfigPayload(body);
	await saveConfig(env, auth.user.id, payload);
	const config = await getConfigResponse(request, env, auth.user);
	return json(config);
}

async function handleTestSource(request: Request, env: AppEnv): Promise<Response> {
	await requireUser(request, env);
	const body = await readJson<Partial<SourceConfig>>(request);
	const source = sanitizeSource({
		id: body.id ?? crypto.randomUUID(),
		name: body.name ?? "未命名来源",
		url: body.url ?? "",
		enabled: body.enabled ?? true,
		priority: body.priority ?? 0,
		notes: body.notes ?? "",
	});

	const result = await testSingleSource(source);
	return json(result);
}

async function handlePreview(request: Request, env: AppEnv): Promise<Response> {
	const user = await requireUser(request, env);
	const config = await getConfigResponse(request, env, user);
	const aliases = await listAliases(env.DB, user.id);
	const aggregate = await aggregateSourceConfigs({
		sources: config.sources,
		renameRules: config.renameRules,
		settings: config.settings,
		aliases,
	});

	return json({
		generatedAt: new Date().toISOString(),
		...aggregate,
		nodeCount: aggregate.nodes.length,
	});
}

async function handleRenameNode(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const body = await readJson<{ fingerprint?: string; alias?: string }>(request);
	const fingerprint = body.fingerprint?.trim();
	const alias = (body.alias ?? "").trim();

	if (!fingerprint) {
		return apiError(400, "节点指纹不能为空");
	}

	if (alias.length > 120) {
		return apiError(400, "别名长度不能超过 120 个字符");
	}

	await saveAlias(env.DB, auth.user.id, fingerprint, alias);
	await bumpCacheVersion(env.DB, auth.user.id);
	return json({ ok: true });
}

async function handleRenameNodes(request: Request, env: AppEnv): Promise<Response> {
	const auth = await requireAuthRecord(request, env);
	const body = await readJson<{ updates?: Array<{ fingerprint?: string; alias?: string }> }>(request);
	const rawUpdates = Array.isArray(body.updates) ? body.updates : [];

	if (rawUpdates.length > 2000) {
		return apiError(400, "批量保存条目过多");
	}

	const seen = new Set<string>();
	const normalized: Array<{ fingerprint: string; alias: string }> = [];
	for (const entry of rawUpdates) {
		const fingerprint = entry?.fingerprint?.trim();
		if (!fingerprint) {
			return apiError(400, "节点指纹不能为空");
		}
		if (seen.has(fingerprint)) {
			continue;
		}
		seen.add(fingerprint);

		const alias = (entry?.alias ?? "").trim();
		if (alias.length > 120) {
			return apiError(400, "别名长度不能超过 120 个字符");
		}
		normalized.push({ fingerprint, alias });
	}

	if (normalized.length === 0) {
		return json({ ok: true, count: 0 });
	}

	await saveAliasesBatch(env.DB, auth.user.id, normalized);
	await bumpCacheVersion(env.DB, auth.user.id);
	return json({ ok: true, count: normalized.length });
}

async function handleRefresh(request: Request, env: AppEnv): Promise<Response> {
	const user = await requireUser(request, env);
	const settings = await bumpCacheVersion(env.DB, user.id);
	return json({
		ok: true,
		cacheVersion: settings.cache_version,
		publicUrl: buildPublicUrl(request, env, settings.public_token),
	});
}

async function handlePublicSubscription(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const token = url.pathname.slice("/sub/".length).trim();
	if (!token) {
		return new Response("Missing token", { status: 404 });
	}

	const context = await getPublicSubscriptionContext(env.DB, token);
	if (!context) {
		return new Response("Subscription not found", { status: 404 });
	}

	const formatRaw = url.searchParams.get("raw") === "1";
	const cacheKey = `subscription:${context.user.id}:${context.settings.cache_version}:${formatRaw ? "raw" : "b64"}`;

	if (env.CACHE) {
		const cached = await env.CACHE.get(cacheKey);
		if (cached !== null) {
			return new Response(cached, {
				headers: subscriptionHeaders(formatRaw),
			});
		}
	}

	const aggregate = await aggregateSourceRows({
		sources: await Promise.all(
			context.sources.map(async (source) => ({
				...source,
				url: await decryptText(source.url_encrypted, env),
			})),
		),
		renameRules: context.renameRules,
		settings: context.settings,
		aliases: context.aliases,
	});

	if (aggregate.successfulSources === 0 && context.sources.some((source) => Boolean(source.enabled))) {
		return new Response("No upstream subscription available", { status: 502 });
	}

	const payload = formatRaw ? aggregate.rawText : aggregate.encodedText;
	if (env.CACHE) {
		ctx.waitUntil(env.CACHE.put(cacheKey, payload, { expirationTtl: getCacheTtlSeconds(env) }));
	}

	return new Response(payload, {
		headers: subscriptionHeaders(formatRaw),
	});
}

async function requireUser(request: Request, env: AppEnv): Promise<UserProfile> {
	const auth = await requireAuthRecord(request, env);
	return auth.user;
}

async function requireAuthRecord(
	request: Request,
	env: AppEnv,
): Promise<{ user: UserProfile; sessionId: string }> {
	const token = getCookie(request, getSessionCookieName());
	if (!token) {
		throw new HttpError(401, "请先登录");
	}

	const tokenHash = await sha256Base64Url(token);
	const row = await findSessionUser(env.DB, tokenHash);
	if (!row) {
		throw new HttpError(401, "会话已失效");
	}

	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await deleteSessionByHash(env.DB, tokenHash);
		throw new HttpError(401, "会话已过期");
	}

	await touchSession(env.DB, row.session_id);

	return {
		sessionId: row.session_id,
		user: {
			id: row.user_id,
			username: row.username,
			email: row.email,
		},
	};
}

async function makeSessionResponse(
	request: Request,
	env: AppEnv,
	user: UserProfile,
): Promise<Response> {
	const ttlSeconds = getSessionTtlSeconds(env);
	const token = await createSession(env.DB, user.id, ttlSeconds);
	const secure = new URL(request.url).protocol === "https:";
	const config = await getConfigResponse(request, env, user);

	return json(
		{
			user,
			config,
		},
		{
			headers: {
				"Set-Cookie": makeCookie({
					name: getSessionCookieName(),
					value: token,
					maxAge: ttlSeconds,
					secure,
				}),
			},
		},
	);
}

function sanitizeConfigPayload(input: SaveConfigPayload): SaveConfigPayload {
	const settings = input?.settings;
	if (!settings) {
		throw new HttpError(400, "配置缺少 settings");
	}

	const prefixTemplateRaw =
		typeof settings.sourcePrefixTemplate === "string"
			? settings.sourcePrefixTemplate.slice(0, 80)
			: "[{{source}}] ";
	const prefixTemplate = prefixTemplateRaw.trim()
		? prefixTemplateRaw
		: "[{{source}}] ";

	const sources = Array.isArray(input.sources) ? input.sources.map(sanitizeSource) : [];
	if (sources.length > 50) {
		throw new HttpError(400, "订阅源数量不能超过 50");
	}

	const renameRules = Array.isArray(input.renameRules)
		? input.renameRules.map((rule, index) => sanitizeRule(rule, index))
		: [];

	return {
		settings: {
			dedupeEnabled: Boolean(settings.dedupeEnabled),
			prefixSourceName: Boolean(settings.prefixSourceName),
			sourcePrefixTemplate: prefixTemplate,
			keepUnnamed: Boolean(settings.keepUnnamed),
			sortMode: settings.sortMode === "name" ? "name" : "source-priority",
		},
		sources,
		renameRules,
	};
}

function sanitizeSource(source: SourceConfig): SourceConfig {
	const name = (source.name || "").trim().slice(0, 80);
	if (!name) {
		throw new HttpError(400, "订阅源名称不能为空");
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL((source.url || "").trim());
	} catch {
		throw new HttpError(400, `订阅源 ${name} 的链接无效`);
	}

	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		throw new HttpError(400, `订阅源 ${name} 只支持 http/https 链接`);
	}

	return {
		id: source.id?.trim() || crypto.randomUUID(),
		name,
		url: parsedUrl.toString(),
		enabled: Boolean(source.enabled),
		priority: clampInteger(source.priority, 0, 999),
		notes: (source.notes || "").trim().slice(0, 160),
	};
}

function sanitizeRule(rule: SaveConfigPayload["renameRules"][number], index: number) {
	const type = ["prefix", "suffix", "replace", "regex"].includes(rule?.type)
		? rule.type
		: "replace";
	return {
		id: rule?.id?.trim() || crypto.randomUUID(),
		type,
		enabled: Boolean(rule?.enabled),
		match: (rule?.match || "").slice(0, 120),
		replace: (rule?.replace || "").slice(0, 120),
		value: (rule?.value || "").slice(0, 120),
		order: clampInteger(rule?.order ?? index, 0, 999),
	};
}

function normalizeUsername(value: string | undefined): string {
	const username = (value || "").trim();
	if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
		throw new HttpError(400, "用户名需为 3-32 位字母、数字、下划线、点或短横线");
	}
	return username;
}

function normalizeOptionalEmail(value: string | undefined): string | null {
	const email = (value || "").trim();
	if (!email) {
		return null;
	}

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new HttpError(400, "邮箱格式不正确");
	}
	return email.slice(0, 120);
}

function normalizeEmail(value: string | undefined): string {
	const email = (value || "").trim();
	if (!email) {
		throw new HttpError(400, "邮箱不能为空");
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new HttpError(400, "邮箱格式不正确");
	}
	return email.slice(0, 120);
}

function normalizeLoginIdentifier(
	value: string | undefined,
): { kind: "email"; value: string } | { kind: "username"; value: string } {
	const raw = (value || "").trim();
	if (!raw) {
		throw new HttpError(400, "请输入账号");
	}
	if (raw.includes("@")) {
		return { kind: "email", value: normalizeEmail(raw) };
	}
	return { kind: "username", value: normalizeUsername(raw) };
}

function normalizePassword(value: string | undefined): string {
	const password = value ?? "";
	if (password.length < 8 || password.length > 128) {
		throw new HttpError(400, "密码长度需在 8 到 128 位之间");
	}
	return password;
}

function clampInteger(value: unknown, min: number, max: number): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return min;
	}
	return Math.max(min, Math.min(max, Math.round(number)));
}

function subscriptionHeaders(raw: boolean): HeadersInit {
	return {
		"content-type": "text/plain; charset=UTF-8",
		"cache-control": "no-store",
		"x-subscription-format": raw ? "raw" : "base64",
	};
}

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
