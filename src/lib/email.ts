import { connect } from "cloudflare:sockets";
import { encodeUtf8, utf8ToBase64 } from "./encoding";
import type { AppEnv } from "./types";

const textDecoder = new TextDecoder();

export interface SmtpSocketLike {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): Promise<void>;
	startTls?(options?: { expectedServerHostname?: string }): SmtpSocketLike;
}

export interface SmtpTransportLike {
	connect(
		address: { hostname: string; port: number },
		options: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean },
	): SmtpSocketLike;
}

export async function sendEmail(
	env: AppEnv,
	options: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
	const host = env.SMTP_HOST?.trim();
	const from = env.SMTP_FROM?.trim();
	if (!host || !from) {
		throw new Error("邮件服务未配置");
	}

	if (host.startsWith("http://") || host.startsWith("https://")) {
		await sendWebhookEmail(env, options);
		return;
	}

	await sendSmtpEmail(env, options);
}

export async function sendSmtpEmail(
	env: AppEnv,
	options: { to: string; subject: string; text: string; html?: string },
	transport: SmtpTransportLike = {
		connect(address, socketOptions) {
			return connect(address, socketOptions);
		},
	},
): Promise<void> {
	const host = env.SMTP_HOST?.trim();
	const from = env.SMTP_FROM?.trim();
	const user = env.SMTP_USER?.trim() || "";
	const pass = env.SMTP_PASS?.trim() || "";
	if (!host || !from || !user || !pass) {
		throw new Error("SMTP 配置不完整");
	}

	const port = parseSmtpPort(env.SMTP_PORT);
	const secureTransport = port === 465 ? "on" : "off";
	const message = buildMimeMessage(from, options);
	const envelopeFrom = extractEnvelopeAddress(from);
	const envelopeTo = extractEnvelopeAddress(options.to);
	if (!envelopeFrom || !envelopeTo) {
		throw new Error("邮箱地址格式无效");
	}

	let socket = transport.connect(
		{ hostname: host, port },
		{ secureTransport, allowHalfOpen: false },
	);
	let reader = socket.readable.getReader();
	let writer = socket.writable.getWriter();
	const state = { buffer: "" };

	try {
		await expectSmtpResponse(reader, state, [220]);
		await writeCommand(writer, `EHLO ${resolveEhloName(from)}`);
		await expectSmtpResponse(reader, state, [250]);

		await writeCommand(writer, "AUTH LOGIN");
		await expectSmtpResponse(reader, state, [334]);
		await writeCommand(writer, btoa(user));
		await expectSmtpResponse(reader, state, [334]);
		await writeCommand(writer, btoa(pass));
		await expectSmtpResponse(reader, state, [235]);

		await writeCommand(writer, `MAIL FROM:<${envelopeFrom}>`);
		await expectSmtpResponse(reader, state, [250]);
		await writeCommand(writer, `RCPT TO:<${envelopeTo}>`);
		await expectSmtpResponse(reader, state, [250, 251]);
		await writeCommand(writer, "DATA");
		await expectSmtpResponse(reader, state, [354]);
		await writeRaw(writer, `${dotStuffMessage(message)}\r\n.\r\n`);
		await expectSmtpResponse(reader, state, [250]);
		await writeCommand(writer, "QUIT");
		await expectSmtpResponse(reader, state, [221]);
	} finally {
		reader.releaseLock();
		writer.releaseLock();
		await socket.close().catch(() => undefined);
	}
}

async function sendWebhookEmail(
	env: AppEnv,
	options: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
	const host = env.SMTP_HOST?.trim();
	const from = env.SMTP_FROM?.trim();
	if (!host || !from) {
		throw new Error("邮件服务未配置");
	}

	const url = host;
	const user = env.SMTP_USER?.trim() || "";
	const pass = env.SMTP_PASS?.trim() || "";

	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (user && pass) {
		headers["authorization"] = `Basic ${btoa(`${user}:${pass}`)}`;
	}

	const body = JSON.stringify({
		from,
		to: options.to,
		subject: options.subject,
		text: options.text,
		html: options.html,
	});

	const response = await fetch(url, {
		method: "POST",
		headers,
		body,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`邮件发送失败: ${response.status} ${text}`);
	}
}

function parseSmtpPort(value: string | undefined): number {
	const port = Number.parseInt(value || "465", 10);
	return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 465;
}

function resolveEhloName(from: string): string {
	const address = extractEnvelopeAddress(from);
	const domain = address?.split("@")[1]?.trim();
	return domain || "localhost";
}

function extractEnvelopeAddress(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const match = trimmed.match(/<([^<>]+)>/);
	const address = (match?.[1] || trimmed).trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
		return null;
	}
	return address;
}

function buildMimeMessage(
	from: string,
	options: { to: string; subject: string; text: string; html?: string },
): string {
	const lines = [
		`From: ${sanitizeHeaderValue(from)}`,
		`To: ${sanitizeHeaderValue(options.to)}`,
		`Subject: ${encodeMimeHeader(options.subject)}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		...chunkBase64(utf8ToBase64(options.text)),
	];

	return lines.join("\r\n");
}

function sanitizeHeaderValue(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(value: string): string {
	return `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

function chunkBase64(value: string): string[] {
	if (!value) {
		return [""];
	}

	const lines: string[] = [];
	for (let index = 0; index < value.length; index += 76) {
		lines.push(value.slice(index, index + 76));
	}
	return lines;
}

function dotStuffMessage(message: string): string {
	return message
		.replace(/\r?\n/g, "\r\n")
		.split("\r\n")
		.map((line) => (line.startsWith(".") ? `.${line}` : line))
		.join("\r\n");
}

async function writeCommand(writer: WritableStreamDefaultWriter<Uint8Array>, command: string): Promise<void> {
	await writeRaw(writer, `${command}\r\n`);
}

async function writeRaw(writer: WritableStreamDefaultWriter<Uint8Array>, value: string): Promise<void> {
	await writer.write(encodeUtf8(value));
}

async function expectSmtpResponse(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
	expectedCodes: number[],
): Promise<void> {
	const response = await readSmtpResponse(reader, state);
	if (!expectedCodes.includes(response.code)) {
		throw new Error(`SMTP 响应异常: ${response.code} ${response.message}`);
	}
}

async function readSmtpResponse(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
): Promise<{ code: number; message: string }> {
	const lines: string[] = [];

	while (true) {
		const line = await readSmtpLine(reader, state);
		if (line === null) {
			throw new Error("SMTP 连接意外关闭");
		}

		lines.push(line);
		if (!/^\d{3}[ -]/.test(line)) {
			continue;
		}

		if (line[3] === " ") {
			return {
				code: Number.parseInt(line.slice(0, 3), 10),
				message: lines.join("\n"),
			};
		}
	}
}

async function readSmtpLine(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
): Promise<string | null> {
	while (true) {
		const newlineIndex = state.buffer.indexOf("\n");
		if (newlineIndex >= 0) {
			const line = state.buffer.slice(0, newlineIndex).replace(/\r$/, "");
			state.buffer = state.buffer.slice(newlineIndex + 1);
			return line;
		}

		const { done, value } = await reader.read();
		if (done) {
			if (!state.buffer) {
				return null;
			}

			const line = state.buffer.replace(/\r$/, "");
			state.buffer = "";
			return line;
		}

		state.buffer += textDecoder.decode(value, { stream: true });
	}
}

export function checkEmailWhitelist(email: string, env: AppEnv): boolean {
	const raw = env.EMAIL_WHITELIST?.trim();
	if (!raw) {
		return true;
	}

	const whitelist = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (whitelist.length === 0) {
		return true;
	}

	const lowerEmail = email.toLowerCase();
	const domain = lowerEmail.split("@")[1] || "";

	return whitelist.some((item) => lowerEmail === item || domain === item);
}

export function generateVerificationCode(): string {
	return String(Math.floor(100000 + Math.random() * 900000));
}
