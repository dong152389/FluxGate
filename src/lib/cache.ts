import type { CacheStore } from "./types";

interface CacheEntry {
	value: string;
	expiresAt: number;
}

export class MemoryCacheStore implements CacheStore {
	private store = new Map<string, CacheEntry>();

	async get(key: string): Promise<string | null> {
		const entry = this.store.get(key);
		if (!entry) {
			return null;
		}

		if (Date.now() > entry.expiresAt) {
			this.store.delete(key);
			return null;
		}

		return entry.value;
	}

	async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
		const ttlSeconds = options?.expirationTtl ?? 600;
		this.store.set(key, {
			value,
			expiresAt: Date.now() + ttlSeconds * 1000,
		});
	}

	clear(): void {
		this.store.clear();
	}
}
