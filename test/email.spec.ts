import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/lib/types";
import { sendSmtpEmail } from "../src/lib/email";

function createEnv(): AppEnv {
	return {
		DB: {} as D1Database,
		ASSETS: {} as Fetcher,
		SMTP_HOST: "smtp.qq.com",
		SMTP_PORT: "465",
		SMTP_USER: "1042855203@qq.com",
		SMTP_PASS: "smtp-app-password",
		SMTP_FROM: "1042855203@qq.com",
	};
}

function createSocketTranscript(responses: string[]) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writes: Uint8Array[] = [];

	const socket = {
		readable: new ReadableStream<Uint8Array>({
			start(controller) {
				for (const response of responses) {
					controller.enqueue(encoder.encode(response));
				}
				controller.close();
			},
		}),
		writable: new WritableStream<Uint8Array>({
			write(chunk) {
				writes.push(chunk);
			},
		}),
		close: vi.fn().mockResolvedValue(undefined),
	};

	return {
		socket,
		getWrittenText() {
			return writes.map((chunk) => decoder.decode(chunk)).join("");
		},
	};
}

describe("smtp email delivery", () => {
	it("sends verification email through smtp over tls when host is not an http endpoint", async () => {
		const transcript = createSocketTranscript([
			"220 smtp.qq.com ESMTP ready\r\n",
			"250-smtp.qq.com\r\n250 AUTH LOGIN PLAIN\r\n",
			"334 VXNlcm5hbWU6\r\n",
			"334 UGFzc3dvcmQ6\r\n",
			"235 Authentication successful\r\n",
			"250 OK\r\n",
			"250 Accepted\r\n",
			"354 End data with <CR><LF>.<CR><LF>\r\n",
			"250 Queued\r\n",
			"221 Bye\r\n",
		]);

		await sendSmtpEmail(
			createEnv(),
			{
				to: "verify@example.com",
				subject: "【FluxGate】验证码",
				text: "您的验证码是：123456",
			},
			{
				connect: vi.fn().mockReturnValue(transcript.socket),
			},
		);

		const written = transcript.getWrittenText();

		expect(written).toContain("EHLO ");
		expect(written).toContain("AUTH LOGIN\r\n");
		expect(written).toContain(`${btoa("1042855203@qq.com")}\r\n`);
		expect(written).toContain(`${btoa("smtp-app-password")}\r\n`);
		expect(written).toContain("MAIL FROM:<1042855203@qq.com>\r\n");
		expect(written).toContain("RCPT TO:<verify@example.com>\r\n");
		expect(written).toContain("DATA\r\n");
		expect(written).toContain("Subject: =?UTF-8?B?");
		expect(written).toContain("QUIT\r\n");
	});
});
