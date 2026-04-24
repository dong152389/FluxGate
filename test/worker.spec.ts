import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { createUser, saveConfig } from "../src/lib/data";
import { CREATE_SCHEMA_SQL, RESET_SCHEMA_SQL } from "../src/lib/db-schema";
import { hashPassword } from "../src/lib/security";

async function invoke(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function extractCookie(response: Response): string {
	const cookie = response.headers.get("Set-Cookie");
	expect(cookie).toBeTruthy();
	return cookie!.split(";")[0];
}

async function execStatements(db: D1Database, sql: string): Promise<void> {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);

	for (const statement of statements) {
		await db.prepare(`${statement};`).run();
	}
}

const LEGACY_SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  public_token TEXT NOT NULL UNIQUE,
  dedupe_enabled INTEGER NOT NULL DEFAULT 1,
  prefix_source_name INTEGER NOT NULL DEFAULT 1,
  source_prefix_template TEXT NOT NULL DEFAULT '[{{source}}] ',
  keep_unnamed INTEGER NOT NULL DEFAULT 1,
  sort_mode TEXT NOT NULL DEFAULT 'source-priority',
  cache_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sources_user_priority ON sources(user_id, priority, name);

CREATE TABLE rename_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_text TEXT,
  replace_text TEXT,
  value_text TEXT,
  rule_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

const DUAL_SOURCE_MIGRATION_SQL = `
PRAGMA foreign_keys = OFF;

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  v2ray_url_encrypted TEXT,
  clash_url_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO sources_new (
  id,
  user_id,
  name,
  v2ray_url_encrypted,
  clash_url_encrypted,
  enabled,
  priority,
  notes,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  name,
  url_encrypted,
  NULL,
  enabled,
  priority,
  notes,
  created_at,
  updated_at
FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

CREATE INDEX IF NOT EXISTS idx_sources_user_priority ON sources(user_id, priority, name);

PRAGMA foreign_keys = ON;
`;

async function seedVerificationCode(
	email: string,
	purpose: "register" | "bind" = "register",
	code = "123456",
): Promise<void> {
	const createdAt = new Date().toISOString();
	const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	await env.DB
		.prepare(
			`INSERT INTO verification_codes (id, email, code, purpose, used, expires_at, created_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		)
		.bind(`code-${email}-${purpose}`, email, code, purpose, expiresAt, createdAt)
		.run();
}

async function registerVerifiedUser(
	username: string,
	email = `${username}@example.com`,
	password = "supersecret123",
): Promise<Response> {
	await seedVerificationCode(email, "register");
	return invoke("/api/auth/register", {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			username,
			email,
			password,
			code: "123456",
		}),
	});
}

beforeEach(async () => {
	await execStatements(env.DB, RESET_SCHEMA_SQL);
	await execStatements(env.DB, CREATE_SCHEMA_SQL);
	vi.unstubAllGlobals();
	delete env.SMTP_HOST;
	delete env.SMTP_FROM;
});

describe("worker auth and config", () => {
	it("lets a legacy admin without email log in without losing the admin flag", async () => {
		const password = "supersecret123";
		const { hash, salt } = await hashPassword(password);
		await createUser(env, {
			username: "legacy_admin",
			email: null,
			passwordHash: hash,
			passwordSalt: salt,
		});

		const response = await invoke("/api/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				identifier: "legacy_admin",
				password,
			}),
		});

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.user.username).toBe("legacy_admin");
		expect(payload.user.emailVerified).toBe(false);
		expect(payload.user.isAdmin).toBe(true);
		expect(payload.config.user.isAdmin).toBe(true);
	});

	it("registers a verified user and returns the initial config", async () => {
		const response = await registerVerifiedUser("tester_01");

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.user.username).toBe("tester_01");
		expect(payload.user.emailVerified).toBe(true);
		expect(payload.config.publicUrl).toContain("/sub/");
		expect(payload.config.sources).toEqual([]);
	});

	it("creates a verification code row when sending email codes", async () => {
		env.SMTP_HOST = "https://mailer.example.com/send";
		env.SMTP_FROM = "noreply@example.com";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

		const response = await invoke("/api/auth/send-code", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "verify@example.com",
				purpose: "register",
			}),
		});

		expect(response.status).toBe(200);
		const row = await env.DB
			.prepare("SELECT email, purpose, used FROM verification_codes WHERE email = ?")
			.bind("verify@example.com")
			.first<{ email: string; purpose: string; used: number }>();
		expect(row).toEqual({
			email: "verify@example.com",
			purpose: "register",
			used: 0,
		});
	});

	it("persists separate v2ray and clash URLs for a source", async () => {
		const register = await registerVerifiedUser("operator_dual");
		const cookie = extractCookie(register);

		const save = await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: true,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "name",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "https://a.example.com/v2ray",
						clashUrl: "https://a.example.com/clash",
						enabled: true,
						priority: 1,
						notes: "主线路",
					},
				],
				renameRules: [
					{
						id: "rule-1",
						type: "replace",
						enabled: true,
						match: "香港",
						replace: "HK",
						value: "",
						order: 0,
					},
				],
			}),
		});

		expect(save.status).toBe(200);
		const savedConfig = await save.json();
		expect(savedConfig.settings.sortMode).toBe("name");
		expect(savedConfig.sources[0]).toMatchObject({
			name: "机场 A",
			v2rayUrl: "https://a.example.com/v2ray",
			clashUrl: "https://a.example.com/clash",
			enabled: true,
			priority: 1,
			notes: "主线路",
		});
		expect(savedConfig.renameRules[0]?.match).toBe("香港");
	});

	it("accepts a source when only one upstream URL is provided", async () => {
		const register = await registerVerifiedUser("operator_single_link");
		const cookie = extractCookie(register);

		const save = await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: true,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "name",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "https://a.example.com/v2ray",
						clashUrl: "",
						enabled: true,
						priority: 1,
						notes: "单链路",
					},
				],
				renameRules: [],
			}),
		});

		expect(save.status).toBe(200);
		const savedConfig = await save.json();
		expect(savedConfig.sources[0]).toMatchObject({
			v2rayUrl: "https://a.example.com/v2ray",
			clashUrl: "",
		});
	});

	it("rejects invalid upstream URL protocols", async () => {
		const register = await registerVerifiedUser("operator_invalid_link");
		const cookie = extractCookie(register);

		const response = await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: true,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "name",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "ftp://a.example.com/v2ray",
						clashUrl: "",
						enabled: true,
						priority: 1,
						notes: "",
					},
				],
				renameRules: [],
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("V2Ray 链接只支持 http/https");
	});

	it("migrates legacy sources schema before writing dual upstream URLs", async () => {
		await execStatements(env.DB, RESET_SCHEMA_SQL);
		await execStatements(env.DB, LEGACY_SCHEMA_SQL);
		await execStatements(env.DB, DUAL_SOURCE_MIGRATION_SQL);

		const now = new Date().toISOString();
		const userId = "legacy-migration-user";
		await env.DB
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, password_salt, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				userId,
				"legacy_migration_user",
				"legacy_migration_user@example.com",
				"hash",
				"salt",
				"active",
				now,
				now,
			)
			.run();

		await env.DB
			.prepare(
				`INSERT INTO user_settings
				 (user_id, public_token, dedupe_enabled, prefix_source_name, source_prefix_template, keep_unnamed, sort_mode, cache_version, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				userId,
				"legacy-public-token",
				1,
				1,
				"[{{source}}] ",
				1,
				"source-priority",
				1,
				now,
				now,
			)
			.run();

		await saveConfig(env, userId, {
			settings: {
				dedupeEnabled: true,
				prefixSourceName: true,
				sourcePrefixTemplate: "[{{source}}] ",
				keepUnnamed: true,
				sortMode: "source-priority",
			},
			sources: [
				{
					id: "source-legacy",
					name: "机场 A",
					v2rayUrl: "https://a.example.com/v2ray",
					clashUrl: "https://a.example.com/clash",
					enabled: true,
					priority: 1,
					notes: "",
				},
			],
			renameRules: [],
		});

		const source = await env.DB
			.prepare(
				`SELECT v2ray_url_encrypted, clash_url_encrypted
				 FROM sources
				 WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ v2ray_url_encrypted: string | null; clash_url_encrypted: string | null }>();

		expect(source?.v2ray_url_encrypted).toBeTruthy();
		expect(source?.clash_url_encrypted).toBeTruthy();

		const columns = await env.DB.prepare("PRAGMA table_info(sources)").all<{ name: string }>();
		expect((columns.results || []).some((column) => column.name === "url_encrypted")).toBe(false);
	});

	it("serves a public aggregated subscription", async () => {
		const register = await registerVerifiedUser("publisher");
		const registerPayload = await register.json();
		const cookie = extractCookie(register);
		const publicToken = registerPayload.config.publicToken;

		await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: true,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "source-priority",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "https://a.example.com/sub",
						clashUrl: "",
						enabled: true,
						priority: 1,
						notes: "",
					},
				],
				renameRules: [],
			}),
		});

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					"vless://user-1@hk.example.com:443?encryption=none#Hong Kong 01",
				),
			),
		);

		const response = await invoke(`/sub/${publicToken}?raw=1`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(
			"#%5B%E6%9C%BA%E5%9C%BA%20A%5D%20Hong%20Kong%2001",
		);
	});

	it("serves clash yaml format for mihomo/clash clients", async () => {
		const register = await registerVerifiedUser("clash_user");
		const registerPayload = await register.json();
		const cookie = extractCookie(register);
		const publicToken = registerPayload.config.publicToken;

		await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: false,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "source-priority",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "https://a.example.com/sub",
						clashUrl: "",
						enabled: true,
						priority: 1,
						notes: "",
					},
				],
				renameRules: [],
			}),
		});

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					[
						"vless://uuid-1@hk.example.com:443?encryption=none&security=tls&type=ws&host=hk.example.com&path=%2Fws#HK%2001",
						"trojan://pwd-1@jp.example.com:443?sni=jp.example.com#JP%2001",
					].join("\n"),
				),
			),
		);

		const response = await invoke(`/sub/${publicToken}?format=clash`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/yaml");
		expect(response.headers.get("x-subscription-format")).toBe("clash");
		expect(response.headers.get("profile-title")).toContain("FluxGate-");
		expect(response.headers.get("content-disposition")).toContain(".yaml");
		const text = await response.text();
		expect(text).toContain("proxies:");
		expect(text).toContain("type: vless");
		expect(text).toContain("type: trojan");
		expect(text).toContain("proxy-groups:");
		expect(text).toContain("rules:");
	});

	it("detects clash format by user agent", async () => {
		const register = await registerVerifiedUser("meta_user");
		const registerPayload = await register.json();
		const cookie = extractCookie(register);
		const publicToken = registerPayload.config.publicToken;

		await invoke("/api/config", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				Cookie: cookie,
			},
			body: JSON.stringify({
				settings: {
					dedupeEnabled: true,
					prefixSourceName: false,
					sourcePrefixTemplate: "[{{source}}] ",
					keepUnnamed: true,
					sortMode: "source-priority",
				},
				sources: [
					{
						id: "source-1",
						name: "机场 A",
						v2rayUrl: "https://a.example.com/sub",
						clashUrl: "",
						enabled: true,
						priority: 1,
						notes: "",
					},
				],
				renameRules: [],
			}),
		});

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("vless://uuid-1@hk.example.com:443?encryption=none#HK%2001"),
			),
		);

		const request = new Request(`http://example.com/sub/${publicToken}`, {
			headers: {
				"user-agent": "clash.meta/1.0",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-subscription-format")).toBe("clash");
		expect(response.headers.get("profile-title")).toContain("FluxGate-");
		expect(await response.text()).toContain("proxies:");
	});
});
