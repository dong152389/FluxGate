const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUtf8(input: string): Uint8Array {
	return encoder.encode(input);
}

export function decodeUtf8(input: Uint8Array): string {
	return decoder.decode(input);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const value of bytes) {
		binary += String.fromCharCode(value);
	}
	return btoa(binary);
}

export function base64ToBytes(input: string): Uint8Array {
	const normalized = normalizeBase64(input);
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
	return base64ToBytes(input);
}

export function utf8ToBase64(input: string): string {
	return bytesToBase64(encodeUtf8(input));
}

export function base64ToUtf8(input: string): string {
	return decodeUtf8(base64ToBytes(input));
}

export function normalizeBase64(input: string): string {
	const compact = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
	const remainder = compact.length % 4;
	if (remainder === 0) {
		return compact;
	}
	return compact + "=".repeat(4 - remainder);
}

export function tryDecodeBase64Text(input: string): string | null {
	try {
		return base64ToUtf8(input);
	} catch {
		return null;
	}
}
