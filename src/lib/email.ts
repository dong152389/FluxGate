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

	const url = host.startsWith("http") ? host : `https://${host}`;
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
