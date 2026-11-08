import nodemailer from "nodemailer";
import type { AppEnv } from "./types";

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
): Promise<void> {
	const host = env.SMTP_HOST?.trim();
	const rawFrom = env.SMTP_FROM?.trim();
	const user = env.SMTP_USER?.trim() || "";
	const pass = env.SMTP_PASS?.trim() || "";
	if (!host || !rawFrom || !user || !pass) {
		throw new Error("SMTP 配置不完整");
	}

	const from = resolveSmtpFrom(rawFrom, host, user);
	const port = parseSmtpPort(env.SMTP_PORT);
	const secure = port === 465;

	const transporter = nodemailer.createTransport({
		host,
		port,
		secure,
		auth: {
			user,
			pass,
		},
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 15_000,
	});

	await transporter.sendMail({
		from,
		to: options.to,
		subject: options.subject,
		text: options.text,
		html: options.html,
	});
}

function resolveSmtpFrom(rawFrom: string, host: string, user: string): string {
	if (!user || !user.includes("@")) {
		return rawFrom;
	}
	// QQ 邮箱、163/126 邮箱等国内服务商要求发信邮箱必须与登录认证账号一致，否则会直接切断连接 (Connection closed unexpectedly)
	const isStrictProvider = /(?:qq.com|163.com|126.com|yeah.net|foxmail.com)/i.test(host) ||
		/(?:qq.com|163.com|126.com|yeah.net|foxmail.com)/i.test(user);

	if (isStrictProvider) {
		const match = rawFrom.match(new RegExp("^([^<>]*?)\s*<.*?>$"));
		const displayName = match ? match[1].trim() : "";
		return displayName ? `${displayName} <${user}>` : user;
	}

	return rawFrom;
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
		headers["authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
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
