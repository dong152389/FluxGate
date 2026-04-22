import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateSourceConfigs, buildClashSubscription } from "../src/lib/subscription";
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

	it("builds clash yaml and skips unsupported protocols", () => {
		const result = buildClashSubscription([
			{
				fingerprint: "1",
				protocol: "vless",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "HK 01",
				finalName: "HK 01",
				alias: "",
				rawUri: "vless://uuid-1@hk.example.com:443?encryption=none&security=tls&type=ws&host=hk.example.com&path=%2Fws#HK%2001",
				finalUri: "vless://uuid-1@hk.example.com:443?encryption=none&security=tls&type=ws&host=hk.example.com&path=%2Fws#HK%2001",
			},
			{
				fingerprint: "2",
				protocol: "trojan",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "JP 01",
				finalName: "JP 01",
				alias: "",
				rawUri: "trojan://pwd-1@jp.example.com:443?sni=jp.example.com#JP%2001",
				finalUri: "trojan://pwd-1@jp.example.com:443?sni=jp.example.com#JP%2001",
			},
			{
				fingerprint: "3",
				protocol: "ss",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "SG 01",
				finalName: "SG 01",
				alias: "",
				rawUri: "ss://YWVzLTEyOC1nY206cGFzczEyMw==@sg.example.com:8388#SG%2001",
				finalUri: "ss://YWVzLTEyOC1nY206cGFzczEyMw==@sg.example.com:8388#SG%2001",
			},
			{
				fingerprint: "4",
				protocol: "hysteria2",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "HY2 01",
				finalName: "HY2 01",
				alias: "",
				rawUri: "hysteria2://hy2-pass@hy.example.com:443?sni=hy.example.com&insecure=1#HY2%2001",
				finalUri: "hysteria2://hy2-pass@hy.example.com:443?sni=hy.example.com&insecure=1#HY2%2001",
			},
			{
				fingerprint: "5",
				protocol: "tuic",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "TUIC 01",
				finalName: "TUIC 01",
				alias: "",
				rawUri: "tuic://11111111-2222-4333-8444-555555555555:tuic-pass@tuic.example.com:443?alpn=h3,hq-29&sni=tuic.example.com#TUIC%2001",
				finalUri: "tuic://11111111-2222-4333-8444-555555555555:tuic-pass@tuic.example.com:443?alpn=h3,hq-29&sni=tuic.example.com#TUIC%2001",
			},
			{
				fingerprint: "6",
				protocol: "hysteria",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "Unsupported",
				finalName: "Unsupported",
				alias: "",
				rawUri: "hysteria://token@old.example.com:443#Unsupported",
				finalUri: "hysteria://token@old.example.com:443#Unsupported",
			},
			{
				fingerprint: "7",
				protocol: "anytls",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "AnyTLS 01",
				finalName: "AnyTLS 01",
				alias: "",
				rawUri: "anytls://anypass@anytls.example.com:443?sni=anytls.example.com&alpn=h2,h3&insecure=0#AnyTLS%2001",
				finalUri: "anytls://anypass@anytls.example.com:443?sni=anytls.example.com&alpn=h2,h3&insecure=0#AnyTLS%2001",
			},
		]);

		expect(result.proxyCount).toBe(6);
		expect(result.skippedCount).toBe(1);
		expect(result.yamlText).toContain("proxies:");
		expect(result.yamlText).toContain("type: vless");
		expect(result.yamlText).toContain("type: trojan");
		expect(result.yamlText).toContain("type: ss");
		expect(result.yamlText).toContain("type: hysteria2");
		expect(result.yamlText).toContain("type: tuic");
		expect(result.yamlText).toContain("type: anytls");
		expect(result.yamlText).toContain("proxy-groups:");
		expect(result.yamlText).toContain("rules:");
		expect(result.yamlText).toContain("🛑 广告拦截");
		expect(result.yamlText).toContain("🚀 节点选择");
		expect(result.yamlText).toContain("RULE-SET,openai,🤖 AI 服务");
	});

	it("ensures duplicate proxy names are uniquified in template output", () => {
		const result = buildClashSubscription([
			{
				fingerprint: "1",
				protocol: "vless",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "Node",
				finalName: "Same Name",
				alias: "",
				rawUri: "vless://uuid-1@hk.example.com:443?encryption=none#Same%20Name",
				finalUri: "vless://uuid-1@hk.example.com:443?encryption=none#Same%20Name",
			},
			{
				fingerprint: "2",
				protocol: "vless",
				sourceId: "src-a",
				sourceName: "机场 A",
				originalName: "Node",
				finalName: "Same Name",
				alias: "",
				rawUri: "vless://uuid-2@jp.example.com:443?encryption=none#Same%20Name",
				finalUri: "vless://uuid-2@jp.example.com:443?encryption=none#Same%20Name",
			},
		]);

		expect(result.proxyCount).toBe(2);
		expect(result.yamlText).toContain("name: 'Same Name'");
		expect(result.yamlText).toContain("name: 'Same Name (2)'");
	});
});
