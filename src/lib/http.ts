const jsonHeaders = {
	"content-type": "application/json; charset=UTF-8",
	"cache-control": "no-store",
};

export function json(data: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	for (const [key, value] of Object.entries(jsonHeaders)) {
		if (!headers.has(key)) {
			headers.set(key, value);
		}
	}

	return new Response(JSON.stringify(data), {
		...init,
		headers,
	});
}

export function apiError(
	status: number,
	message: string,
	details?: Record<string, unknown>,
): Response {
	return json(
		{
			error: {
				status,
				message,
				...(details ? { details } : {}),
			},
		},
		{ status },
	);
}

export async function readJson<T>(request: Request): Promise<T> {
	return (await request.json()) as T;
}

export function getCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) {
		return null;
	}

	for (const segment of header.split(";")) {
		const [key, ...valueParts] = segment.trim().split("=");
		if (key === name) {
			return decodeURIComponent(valueParts.join("="));
		}
	}

	return null;
}

export function makeCookie(options: {
	name: string;
	value: string;
	maxAge?: number;
	secure?: boolean;
	expires?: Date;
}): string {
	const parts = [
		`${options.name}=${encodeURIComponent(options.value)}`,
		"HttpOnly",
		"Path=/",
		"SameSite=Strict",
		"Priority=High",
	];

	if (typeof options.maxAge === "number") {
		parts.push(`Max-Age=${options.maxAge}`);
	}

	if (options.expires) {
		parts.push(`Expires=${options.expires.toUTCString()}`);
	}

	if (options.secure) {
		parts.push("Secure");
	}

	return parts.join("; ");
}

export function withCookie(response: Response, cookie: string): Response {
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", cookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
