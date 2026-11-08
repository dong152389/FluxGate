import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=UTF-8",
	".htm": "text/html; charset=UTF-8",
	".css": "text/css; charset=UTF-8",
	".js": "application/javascript; charset=UTF-8",
	".mjs": "application/javascript; charset=UTF-8",
	".json": "application/json; charset=UTF-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=UTF-8",
};

export async function serveStaticFile(
	publicDir: string,
	pathname: string,
): Promise<Response | null> {
	const sanitizedPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
	let filePath = resolve(publicDir, `.${sanitizedPath}`);

	if (!filePath.startsWith(resolve(publicDir))) {
		return null;
	}

	if (!existsSync(filePath)) {
		return null;
	}

	let stat = statSync(filePath);
	if (stat.isDirectory()) {
		filePath = join(filePath, "index.html");
		if (!existsSync(filePath)) {
			return null;
		}
		stat = statSync(filePath);
	}

	const ext = extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";

	const fileHandle = await open(filePath, "r");
	const stream = fileHandle.createReadStream();
	const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

	return new Response(webStream, {
		status: 200,
		headers: {
			"content-type": contentType,
			"content-length": String(stat.size),
		},
	});
}
