import { createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import {
	base64UrlToBytes,
	bytesToBase64Url,
	decodeUtf8,
	encodeUtf8,
} from "./encoding";
import type { AppEnv } from "./types";

const passwordIterations = 100_000;
const sessionCookieName = "fluxgate_session";
const keyCache = new Map<string, Promise<CryptoKey>>();

export function getSessionCookieName(): string {
	return sessionCookieName;
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function buildPublicUrl(
	request: Request,
	env: AppEnv,
	publicToken: string,
): string {
	const origin = env.PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
	return `${origin.replace(/\/$/, "")}/sub/${publicToken}`;
}

export function buildPublicClientUrl(
	request: Request,
	env: AppEnv,
	publicToken: string,
	format: "clash" | "raw",
	clashTemplateId?: string,
): string {
	const base = buildPublicUrl(request, env, publicToken);
	const target = new URL(base);
	if (format === "clash") {
		target.searchParams.set("format", "clash");
		if (clashTemplateId) {
			target.searchParams.set("template", clashTemplateId);
		}
	} else {
		target.searchParams.set("raw", "1");
	}
	return target.toString();
}

export function getSessionTtlSeconds(env: AppEnv): number {
	const ttlDays = Number(env.SESSION_TTL_DAYS ?? "30");
	return Number.isFinite(ttlDays) && ttlDays > 0 ? Math.round(ttlDays * 86400) : 30 * 86400;
}

export function getCacheTtlSeconds(env: AppEnv): number {
	const ttl = Number(env.CACHE_TTL_SECONDS ?? "600");
	return Number.isFinite(ttl) && ttl > 0 ? ttl : 600;
}

export function randomId(): string {
	return crypto.randomUUID();
}

export function randomToken(byteLength = 32): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
	const value = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
	return bytesToBase64Url(new Uint8Array(createHash("sha256").update(value).digest()));
}

export async function hashPassword(password: string, salt?: string): Promise<{
	hash: string;
	salt: string;
}> {
	const saltBytes = salt ? base64UrlToBytes(salt) : crypto.getRandomValues(new Uint8Array(16));
	const bits = pbkdf2Sync(password, saltBytes, passwordIterations, 32, "sha256");

	return {
		hash: bytesToBase64Url(new Uint8Array(bits)),
		salt: bytesToBase64Url(saltBytes),
	};
}

export async function verifyPassword(
	password: string,
	expectedHash: string,
	salt: string,
): Promise<boolean> {
	const derived = await hashPassword(password, salt);
	const left = Buffer.from(derived.hash, "utf8");
	const right = Buffer.from(expectedHash, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

export async function encryptText(value: string, env: AppEnv): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await getEncryptionKey(env);
	const cipher = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encodeUtf8(value),
	);
	const payload = new Uint8Array(iv.length + cipher.byteLength);
	payload.set(iv, 0);
	payload.set(new Uint8Array(cipher), iv.length);
	return bytesToBase64Url(payload);
}

export async function decryptText(value: string, env: AppEnv): Promise<string> {
	const payload = base64UrlToBytes(value);
	const iv = payload.slice(0, 12);
	const cipher = payload.slice(12);
	const key = await getEncryptionKey(env);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
	return decodeUtf8(new Uint8Array(plain));
}

async function getEncryptionKey(env: AppEnv): Promise<CryptoKey> {
	const secret = env.APP_SECRET?.trim() || "dev-only-secret-change-me";
	let keyPromise = keyCache.get(secret);
	if (!keyPromise) {
		keyPromise = crypto.subtle
			.digest("SHA-256", encodeUtf8(secret))
			.then((digest) =>
				crypto.subtle.importKey(
					"raw",
					digest,
					"AES-GCM",
					false,
					["encrypt", "decrypt"],
				),
			);
		keyCache.set(secret, keyPromise);
	}
	return keyPromise;
}
