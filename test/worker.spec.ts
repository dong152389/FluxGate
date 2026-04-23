import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { createUser } from "../src/lib/data";
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

	it("persists config changes for the authenticated user", async () => {
		const register = await registerVerifiedUser("operator");
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
						url: "https://a.example.com/sub",
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
		expect(savedConfig.sources[0]?.name).toBe("机场 A");
		expect(savedConfig.renameRules[0]?.match).toBe("香港");
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
						url: "https://a.example.com/sub",
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
						url: "https://a.example.com/sub",
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
						url: "https://a.example.com/sub",
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
