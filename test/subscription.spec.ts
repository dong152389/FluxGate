import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateSourceConfigs } from "../src/lib/subscription";
import { utf8ToBase64 } from "../src/lib/encoding";
import { sha256Base64Url } from "../src/lib/security";

describe("subscription aggregation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("aggregates plain and base64 sources, dedupes, and applies aliases", async () => {
		const vmessPayload = utf8ToBase64(
			JSON.stringify({
				v: "2",
				ps: "Tokyo Alpha",
				add: "vmess.example.com",
				port: "443",
				id: "vmess-user",
				net: "ws",
				type: "none",
				host: "vmess.example.com",
				path: "/",
				tls: "tls",
			}),
		);

		const firstSource = [
			"vless://user-1@hk.example.com:443?encryption=none#Hong Kong 01",
			`vmess://${vmessPayload}`,
		].join("\n");

		const secondSourceRaw = [
			"vless://user-1@hk.example.com:443?encryption=none#Hong Kong 01",
			"vless://user-2@jp.example.com:443?encryption=none#Japan 02",
		].join("\n");

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(firstSource))
			.mockResolvedValueOnce(new Response(utf8ToBase64(secondSourceRaw)));

		vi.stubGlobal("fetch", fetchMock);

		const vmessFingerprint = await sha256Base64Url(
			"vmess|vmess.example.com|443|vmess-user",
		);

		const result = await aggregateSourceConfigs({
			sources: [
				{
					id: "src-a",
					name: "机场 A",
					url: "https://a.example.com/sub",
					enabled: true,
					priority: 1,
					notes: "",
				},
				{
					id: "src-b",
					name: "机场 B",
					url: "https://b.example.com/sub",
					enabled: true,
					priority: 2,
					notes: "",
				},
			],
			renameRules: [
				{
					id: "rule-1",
					type: "replace",
					enabled: true,
					match: "Hong Kong",
					replace: "HK",
					value: "",
					order: 0,
				},
			],
			settings: {
				dedupeEnabled: true,
				prefixSourceName: true,
				sourcePrefixTemplate: "[{{source}}] ",
				keepUnnamed: true,
				sortMode: "source-priority",
			},
			aliases: new Map([[vmessFingerprint, "东京优选"]]),
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.successfulSources).toBe(2);
		expect(result.failedSources).toBe(0);
		expect(result.nodes).toHaveLength(3);
		expect(result.nodes[0]?.finalName).toBe("[机场 A] HK 01");
		expect(result.nodes.some((node) => node.finalName === "东京优选")).toBe(true);
		expect(result.rawText).toContain("vless://user-2@jp.example.com:443?encryption=none#");
		expect(result.rawText).toContain("%E6%9C%BA%E5%9C%BA%20B");
	});
});
