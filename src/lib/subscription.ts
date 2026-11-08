import YAML from "yaml";
import { tryDecodeBase64Text, utf8ToBase64 } from "./encoding";
import {
	MIHOMO_TEMPLATE_GROUPS_PLACEHOLDER,
	MIHOMO_TEMPLATE_PROXY_PLACEHOLDER,
} from "./mihomo-template";
import {
	CLASH_AUTO_GROUP_NAME,
	CLASH_SELECT_GROUP_NAME,
	getClashTemplatePreset,
	parseClashGroupOrder,
	resolveClashGroupOrder,
	resolveClashTemplateId,
} from "./mihomo-template-presets";
import { sha256Base64Url } from "./security";
import type {
	AggregateResult,
	ClashBuildResult,
	ParsedNode,
	PreviewNode,
	RenameRuleConfig,
	RenameRuleRow,
	SourceConfig,
	SourceRow,
	SourceSummary,
	UserSettingsConfig,
	UserSettingsRow,
} from "./types";

export async function testSingleSource(source: SourceConfig): Promise<{
	nodeCount: number;
	nodeNames: string[];
}> {
	const url = source.v2rayUrl || source.clashUrl;
	const payload = await fetchSourcePayload(url);
	const nodes = await parseSubscriptionPayload(payload, source);
	return {
		nodeCount: nodes.length,
		nodeNames: nodes.slice(0, 10).map((node) => node.originalName || node.fallbackName),
	};
}

export async function aggregateSourceConfigs(input: {
	sources: SourceConfig[];
	renameRules: RenameRuleConfig[];
	settings: UserSettingsConfig;
	aliases: Map<string, string>;
}): Promise<AggregateResult> {
	return aggregateInternal({
		sources: input.sources.filter((source) => source.enabled).sort(compareSources),
		renameRules: input.renameRules.filter((rule) => rule.enabled).sort(compareRules),
		settings: input.settings,
		aliases: input.aliases,
	});
}

export async function aggregateSourceRows(input: {
	sources: Array<SourceRow & { v2rayUrl: string; clashUrl: string }>;
	renameRules: RenameRuleRow[];
	settings: UserSettingsRow;
	aliases: Map<string, string>;
}): Promise<AggregateResult> {
	return aggregateInternal({
		sources: input.sources
			.filter((source) => Boolean(source.enabled))
			.map(
				(source) =>
					({
						id: source.id,
						name: source.name,
						v2rayUrl: source.v2rayUrl,
						clashUrl: source.clashUrl,
						enabled: Boolean(source.enabled),
						priority: source.priority,
						notes: source.notes ?? "",
					}) satisfies SourceConfig,
			)
			.sort(compareSources),
		renameRules: input.renameRules
			.filter((rule) => Boolean(rule.enabled))
			.map(
				(rule) =>
					({
						id: rule.id,
						type: rule.type,
						enabled: Boolean(rule.enabled),
						match: rule.match_text ?? "",
						replace: rule.replace_text ?? "",
						value: rule.value_text ?? "",
						order: rule.rule_order,
					}) satisfies RenameRuleConfig,
			)
			.sort(compareRules),
		settings: {
			dedupeEnabled: Boolean(input.settings.dedupe_enabled),
			prefixSourceName: Boolean(input.settings.prefix_source_name),
			sourcePrefixTemplate: input.settings.source_prefix_template,
			keepUnnamed: Boolean(input.settings.keep_unnamed),
			sortMode: input.settings.sort_mode,
			clashTemplateId: resolveClashTemplateId(input.settings.clash_template_id),
			clashGroupOrder: parseClashGroupOrder(input.settings.clash_group_order, input.settings.clash_template_id),
		},
		aliases: input.aliases,
	});
}

async function aggregateInternal(input: {
	sources: SourceConfig[];
	renameRules: RenameRuleConfig[];
	settings: UserSettingsConfig;
	aliases: Map<string, string>;
}): Promise<AggregateResult> {
	const sourceSummaries: SourceSummary[] = [];
	const parsedNodes: ParsedNode[] = [];

	for (const source of input.sources) {
		try {
			const payload = await fetchSourcePayload(source.v2rayUrl || source.clashUrl);
			const nodes = await parseSubscriptionPayload(payload, source);
			parsedNodes.push(...nodes);
			sourceSummaries.push({
				sourceId: source.id,
				sourceName: source.name,
				ok: true,
				nodeCount: nodes.length,
				error: null,
			});
		} catch (error) {
			sourceSummaries.push({
				sourceId: source.id,
				sourceName: source.name,
				ok: false,
				nodeCount: 0,
				error: error instanceof Error ? error.message : "拉取失败",
			});
		}
	}

	const seen = new Set<string>();
	const nodes: PreviewNode[] = [];

	for (const parsed of parsedNodes) {
		const originalName = parsed.originalName || parsed.fallbackName;
		let finalName = originalName;

		if (input.settings.prefixSourceName) {
			const prefix = input.settings.sourcePrefixTemplate
				.replace(/{{source}}/g, parsed.sourceName)
				.replace(/{{name}}/g, finalName);
			finalName = `${prefix}${finalName}`.trim();
		}

		for (const rule of input.renameRules) {
			finalName = applyRenameRule(finalName, rule);
		}

		const alias = input.aliases.get(parsed.fingerprint)?.trim() ?? "";
		if (alias) {
			finalName = alias;
		}

		if (!finalName && !input.settings.keepUnnamed) {
			continue;
		}

		if (input.settings.dedupeEnabled) {
			if (seen.has(parsed.fingerprint)) {
				continue;
			}
			seen.add(parsed.fingerprint);
		}

		nodes.push({
			fingerprint: parsed.fingerprint,
			protocol: parsed.protocol,
			sourceId: parsed.sourceId,
			sourceName: parsed.sourceName,
			sourcePriority: parsed.sourcePriority,
			originalName,
			finalName,
			alias,
			rawUri: parsed.rawUri,
			finalUri: serializeNode(parsed, finalName),
		});
	}

	if (input.settings.sortMode === "name") {
		nodes.sort((left, right) => left.finalName.localeCompare(right.finalName, "zh-Hans-CN"));
	} else {
		nodes.sort((left, right) => left.sourcePriority - right.sourcePriority || left.sourceName.localeCompare(right.sourceName, "zh-Hans-CN"));
	}

	const rawText = nodes.map((node) => node.finalUri).join("\n");
	const encodedText = utf8ToBase64(rawText);

	return {
		nodes,
		sourceSummaries,
		successfulSources: sourceSummaries.filter((source) => source.ok).length,
		failedSources: sourceSummaries.filter((source) => !source.ok).length,
		rawText,
		encodedText,
	};
}

function compareSources(left: SourceConfig, right: SourceConfig): number {
	return left.priority - right.priority || left.name.localeCompare(right.name, "zh-Hans-CN");
}

function compareRules(left: RenameRuleConfig, right: RenameRuleConfig): number {
	return left.order - right.order || left.id.localeCompare(right.id);
}

async function fetchSourcePayload(url: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort("timeout"), 10_000);

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "text/plain, application/json, text/yaml, application/x-yaml, */*",
				"user-agent": "FluxGate/1.0",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`上游返回 ${response.status}`);
		}

		return await response.text();
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchAndParseSource(source: SourceConfig): Promise<ParsedNode[]> {
	const urls = [source.v2rayUrl, source.clashUrl].filter((u): u is string => Boolean(u && u.trim()));
	if (urls.length === 0) {
		return [];
	}

	let lastError: Error | null = null;
	for (const url of urls) {
		try {
			const payload = await fetchSourcePayload(url);
			const nodes = await parseSubscriptionPayload(payload, source);
			if (nodes.length > 0) {
				return nodes;
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error("拉取失败");
		}
	}

	if (lastError && urls.length === 1) {
		throw lastError;
	}
	return [];
}

const SUPPORTED_NODE_SCHEMES = new Set([
	"vmess",
	"vless",
	"ss",
	"ssr",
	"trojan",
	"hysteria",
	"hysteria2",
	"hy2",
	"tuic",
	"anytls",
]);

async function parseSubscriptionPayload(
	payload: string,
	source: SourceConfig,
): Promise<ParsedNode[]> {
	const nodeUris = extractNodeUrisFromPayload(payload);
	const nodes: ParsedNode[] = [];

	for (const uri of nodeUris) {
		const parsed = await parseNodeLine(uri, source);
		if (parsed) {
			nodes.push(parsed);
		}
	}

	return nodes;
}

function extractNodeUrisFromPayload(payload: string): string[] {
	const text = (payload || "").trim();
	if (!text) {
		return [];
	}

	// 1. Sing-box JSON 格式 (outbounds 列表)
	if (text.startsWith("{") && text.endsWith("}")) {
		try {
			const obj = JSON.parse(text) as { outbounds?: Array<Record<string, unknown>> };
			if (Array.isArray(obj.outbounds) && obj.outbounds.length > 0) {
				const uris: string[] = [];
				for (const outbound of obj.outbounds) {
					const outboundType = String(outbound.type || "").toLowerCase();
					if (["direct", "block", "dns", "selector", "urltest"].includes(outboundType)) {
						continue;
					}
					const uri = singboxOutboundToUri(outbound);
					if (uri) {
						uris.push(uri);
					}
				}
				if (uris.length > 0) {
					return uris;
				}
			}
		} catch {
			// 解析 JSON 失败，回落到其他格式识别
		}
	}

	// 2. Clash / Mihomo YAML 格式 (proxies 列表)
	if (text.includes("proxies:") || (text.includes("port:") && text.includes("mode:"))) {
		try {
			const doc = YAML.parse(text) as { proxies?: Array<Record<string, unknown>> };
			if (doc && Array.isArray(doc.proxies) && doc.proxies.length > 0) {
				const uris: string[] = [];
				for (const proxy of doc.proxies) {
					const uri = clashProxyToUri(proxy);
					if (uri) {
						uris.push(uri);
					}
				}
				if (uris.length > 0) {
					return uris;
				}
			}
		} catch {
			// 解析 YAML 失败，回落到其他格式识别
		}
	}

	// 3. 尝试 Base64 解密
	const decoded = tryDecodeBase64Text(text);
	const sourceText = decoded && decoded.includes("://") ? decoded : text;

	// 4. 明文多行节点链接解析（过滤非节点行和注释行，严格限制协议类型）
	const rawLines = sourceText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("//") && !line.startsWith("#"));

	const uris: string[] = [];
	for (const line of rawLines) {
		const schemeIndex = line.indexOf("://");
		if (schemeIndex <= 0) {
			continue;
		}
		const scheme = line.slice(0, schemeIndex).toLowerCase();
		if (SUPPORTED_NODE_SCHEMES.has(scheme)) {
			uris.push(line);
		}
	}

	return uris;
}

function clashProxyToUri(proxy: Record<string, unknown>): string | null {
	if (!proxy || typeof proxy !== "object") {
		return null;
	}
	const type = String(proxy.type || "").toLowerCase();
	const name = String(proxy.name || "");
	const server = String(proxy.server || "").trim();
	const port = Number(proxy.port);
	if (!server || !port || Number.isNaN(port)) {
		return null;
	}

	if (type === "vmess") {
		const wsOpts = (typeof proxy["ws-opts"] === "object" && proxy["ws-opts"] ? proxy["ws-opts"] : {}) as Record<string, unknown>;
		const wsHeaders = (typeof wsOpts.headers === "object" && wsOpts.headers ? wsOpts.headers : {}) as Record<string, unknown>;
		const host = String(wsHeaders.Host || wsHeaders.host || proxy.servername || "");
		const path = String(wsOpts.path || "");
		const skipCertVerify = Boolean(proxy["skip-cert-verify"] || proxy.skipCertVerify || proxy.insecure);
		const payload: Record<string, unknown> = {
			v: "2",
			ps: name,
			add: server,
			port: String(port),
			id: String(proxy.uuid || ""),
			aid: String(proxy.alterId ?? 0),
			scy: String(proxy.cipher || "auto"),
			net: String(proxy.network || "tcp"),
			type: "none",
			host,
			path,
			tls: proxy.tls ? "tls" : "",
			sni: String(proxy.servername || proxy.sni || host),
			alpn: Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn || ""),
		};
		if (skipCertVerify) {
			payload["skip-cert-verify"] = "true";
		}
		if (proxy.udp !== undefined) {
			payload.udp = String(Boolean(proxy.udp));
		}
		return `vmess://${utf8ToBase64(JSON.stringify(payload))}`;
	}

	if (type === "vless") {
		const uuid = String(proxy.uuid || "");
		const params = new URLSearchParams();
		params.set("type", String(proxy.network || "tcp"));
		if (proxy["skip-cert-verify"] || proxy.skipCertVerify || proxy.insecure) {
			params.set("insecure", "1");
		}
		if (proxy.udp !== undefined) {
			params.set("udp", String(Boolean(proxy.udp)));
		}
		if (proxy.tls) {
			const realityOpts = (typeof proxy["reality-opts"] === "object" && proxy["reality-opts"] ? proxy["reality-opts"] : {}) as Record<string, unknown>;
			if (realityOpts["public-key"] || realityOpts.publicKey) {
				params.set("security", "reality");
				if (realityOpts["public-key"] || realityOpts.publicKey) {
					params.set("pbk", String(realityOpts["public-key"] || realityOpts.publicKey));
				}
				if (realityOpts["short-id"] || realityOpts.shortId) {
					params.set("sid", String(realityOpts["short-id"] || realityOpts.shortId));
				}
			} else {
				params.set("security", "tls");
			}
		} else {
			params.set("security", "none");
		}

		if (proxy.flow) params.set("flow", String(proxy.flow));
		if (proxy.servername || proxy.sni) params.set("sni", String(proxy.servername || proxy.sni));
		if (proxy["client-fingerprint"]) params.set("fp", String(proxy["client-fingerprint"]));
		if (proxy.alpn) params.set("alpn", Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn));
		const wsOpts = (typeof proxy["ws-opts"] === "object" && proxy["ws-opts"] ? proxy["ws-opts"] : {}) as Record<string, unknown>;
		const wsHeaders = (typeof wsOpts.headers === "object" && wsOpts.headers ? wsOpts.headers : {}) as Record<string, unknown>;
		if (wsOpts.path) params.set("path", String(wsOpts.path));
		const host = wsHeaders.Host || wsHeaders.host;
		if (host) params.set("host", String(host));

		return `vless://${encodeURIComponent(uuid)}@${server}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
	}

	if (type === "hysteria2" || type === "hy2") {
		const password = String(proxy.password || "");
		const params = new URLSearchParams();
		if (proxy.sni) params.set("sni", String(proxy.sni));
		if (proxy["skip-cert-verify"] || proxy.insecure) params.set("insecure", "1");
		if (proxy.alpn) params.set("alpn", Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn));
		if (proxy.obfs) params.set("obfs", String(proxy.obfs));
		if (proxy["obfs-password"]) params.set("obfs-password", String(proxy["obfs-password"]));
		if (proxy.ports) params.set("ports", String(proxy.ports));
		return `hysteria2://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
	}

	if (type === "tuic") {
		const uuid = String(proxy.uuid || "");
		const password = String(proxy.password || "");
		const userinfo = password ? `${encodeURIComponent(uuid)}:${encodeURIComponent(password)}` : encodeURIComponent(uuid);
		const params = new URLSearchParams();
		if (proxy.sni) params.set("sni", String(proxy.sni));
		if (proxy["skip-cert-verify"] || proxy.insecure) params.set("allowInsecure", "1");
		if (proxy.alpn) params.set("alpn", Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn));
		if (proxy["congestion-controller"]) params.set("congestion_control", String(proxy["congestion-controller"]));
		if (proxy["udp-relay-mode"]) params.set("udp_relay_mode", String(proxy["udp-relay-mode"]));
		return `tuic://${userinfo}@${server}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
	}

	if (type === "anytls") {
		const password = String(proxy.password || "");
		const params = new URLSearchParams();
		if (proxy.sni) params.set("sni", String(proxy.sni));
		if (proxy["skip-cert-verify"] || proxy.insecure) params.set("allowInsecure", "1");
		if (proxy["client-fingerprint"]) params.set("client-fingerprint", String(proxy["client-fingerprint"]));
		if (proxy.alpn) params.set("alpn", Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn));
		return `anytls://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
	}

	if (type === "ss") {
		const cipher = String(proxy.cipher || "");
		const password = String(proxy.password || "");
		const userinfo = utf8ToBase64(`${cipher}:${password}`);
		return `ss://${userinfo}@${server}:${port}#${encodeURIComponent(name)}`;
	}

	if (type === "trojan") {
		const password = String(proxy.password || "");
		const params = new URLSearchParams();
		if (proxy.sni) params.set("sni", String(proxy.sni));
		if (proxy["skip-cert-verify"] || proxy.skipCertVerify || proxy.insecure) params.set("allowInsecure", "1");
		if (proxy.udp !== undefined) params.set("udp", String(Boolean(proxy.udp)));
		if (proxy.alpn) params.set("alpn", Array.isArray(proxy.alpn) ? proxy.alpn.join(",") : String(proxy.alpn));
		return `trojan://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
	}

	return null;
}

function singboxOutboundToUri(outbound: Record<string, unknown>): string | null {
	if (!outbound || typeof outbound !== "object") {
		return null;
	}
	const type = String(outbound.type || "").toLowerCase();
	const tag = String(outbound.tag || "");
	const server = String(outbound.server || "").trim();
	const port = Number(outbound.server_port || outbound.port);
	if (!server || !port || Number.isNaN(port)) {
		return null;
	}

	const tls = (typeof outbound.tls === "object" && outbound.tls ? outbound.tls : {}) as Record<string, unknown>;
	const transport = (typeof outbound.transport === "object" && outbound.transport ? outbound.transport : {}) as Record<string, unknown>;

	if (type === "vmess") {
		const wsHeaders = (typeof transport.headers === "object" && transport.headers ? transport.headers : {}) as Record<string, unknown>;
		const hostArr = wsHeaders.Host || wsHeaders.host || [];
		const host = Array.isArray(hostArr) ? String(hostArr[0]) : (hostArr ? String(hostArr) : String(tls.server_name || ""));
		const path = String(transport.path || "");
		const payload: Record<string, unknown> = {
			v: "2",
			ps: tag,
			add: server,
			port: String(port),
			id: String(outbound.uuid || ""),
			aid: String(outbound.alter_id ?? 0),
			scy: String(outbound.security || "auto"),
			net: String(transport.type || "tcp"),
			type: "none",
			host,
			path,
			tls: tls.enabled ? "tls" : "",
			sni: String(tls.server_name || host),
			alpn: Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn || ""),
		};
		if (tls.insecure) {
			payload["skip-cert-verify"] = "true";
		}
		return `vmess://${utf8ToBase64(JSON.stringify(payload))}`;
	}

	if (type === "vless") {
		const uuid = String(outbound.uuid || "");
		const params = new URLSearchParams();
		params.set("type", String(transport.type || "tcp"));
		if (tls.enabled) {
			const reality = (typeof tls.reality === "object" && tls.reality ? tls.reality : {}) as Record<string, unknown>;
			if (reality.enabled || reality.public_key) {
				params.set("security", "reality");
				if (reality.public_key) params.set("pbk", String(reality.public_key));
				if (reality.short_id) params.set("sid", String(reality.short_id));
			} else {
				params.set("security", "tls");
			}
		} else {
			params.set("security", "none");
		}

		if (outbound.flow) params.set("flow", String(outbound.flow));
		if (tls.server_name) params.set("sni", String(tls.server_name));
		const utls = (typeof tls.utls === "object" && tls.utls ? tls.utls : {}) as Record<string, unknown>;
		if (utls.fingerprint) params.set("fp", String(utls.fingerprint));
		if (tls.alpn) params.set("alpn", Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn));
		if (transport.path) params.set("path", String(transport.path));
		const wsHeaders = (typeof transport.headers === "object" && transport.headers ? transport.headers : {}) as Record<string, unknown>;
		const hostArr = wsHeaders.Host || wsHeaders.host || [];
		const host = Array.isArray(hostArr) ? hostArr[0] : hostArr;
		if (host) params.set("host", String(host));

		return `vless://${encodeURIComponent(uuid)}@${server}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
	}

	if (type === "hysteria2") {
		const password = String(outbound.password || "");
		const params = new URLSearchParams();
		if (tls.server_name) params.set("sni", String(tls.server_name));
		if (tls.insecure) params.set("insecure", "1");
		if (tls.alpn) params.set("alpn", Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn));
		const obfs = (typeof outbound.obfs === "object" && outbound.obfs ? outbound.obfs : {}) as Record<string, unknown>;
		if (obfs.password) {
			params.set("obfs", String(obfs.type || "salamander"));
			params.set("obfs-password", String(obfs.password));
		}
		return `hysteria2://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
	}

	if (type === "tuic") {
		const uuid = String(outbound.uuid || "");
		const password = String(outbound.password || "");
		const userinfo = password ? `${encodeURIComponent(uuid)}:${encodeURIComponent(password)}` : encodeURIComponent(uuid);
		const params = new URLSearchParams();
		if (tls.server_name) params.set("sni", String(tls.server_name));
		if (tls.insecure) params.set("allowInsecure", "1");
		if (tls.alpn) params.set("alpn", Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn));
		if (outbound.congestion_control) params.set("congestion_control", String(outbound.congestion_control));
		if (outbound.udp_relay_mode) params.set("udp_relay_mode", String(outbound.udp_relay_mode));
		return `tuic://${userinfo}@${server}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
	}

	if (type === "anytls") {
		const password = String(outbound.password || "");
		const params = new URLSearchParams();
		if (tls.server_name) params.set("sni", String(tls.server_name));
		if (tls.insecure) params.set("allowInsecure", "1");
		if (tls.alpn) params.set("alpn", Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn));
		return `anytls://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
	}

	if (type === "shadowsocks") {
		const method = String(outbound.method || "");
		const password = String(outbound.password || "");
		const userinfo = utf8ToBase64(`${method}:${password}`);
		return `ss://${userinfo}@${server}:${port}#${encodeURIComponent(tag)}`;
	}

	if (type === "trojan") {
		const password = String(outbound.password || "");
		const params = new URLSearchParams();
		if (tls.server_name) params.set("sni", String(tls.server_name));
		if (tls.insecure) params.set("allowInsecure", "1");
		if (tls.alpn) params.set("alpn", Array.isArray(tls.alpn) ? tls.alpn.join(",") : String(tls.alpn));
		return `trojan://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
	}

	return null;
}

async function parseNodeLine(
	line: string,
	source: SourceConfig,
): Promise<ParsedNode | null> {
	const schemeIndex = line.indexOf("://");
	if (schemeIndex <= 0) {
		return null;
	}

	const protocol = line.slice(0, schemeIndex).toLowerCase();
	if (!protocol || !SUPPORTED_NODE_SCHEMES.has(protocol)) {
		return null;
	}

	if (protocol === "vmess") {
		return parseVmessNode(line, source);
	}

	if (protocol === "vless") {
		return parseVlessNode(line, source);
	}

	return parseGenericNode(line, source);
}

async function parseVlessNode(
	line: string,
	source: SourceConfig,
): Promise<ParsedNode> {
	const urlValue = new URL(line);
	const userPart = urlValue.username || line.slice("vless://".length).split("@")[0] || "unknown";
	const port = urlValue.port || "443";
	const originalName = decodeHashName(urlValue.hash);
	const fallbackName = `${source.name} ${urlValue.hostname || "节点"}`.trim();
	return {
		kind: "vless",
		protocol: "vless",
		rawUri: line,
		originalName,
		fallbackName,
		fingerprint: await sha256Base64Url(
			`vless|${urlValue.hostname}|${port}|${userPart}`,
		),
		sourceId: source.id,
		sourceName: source.name,
		sourcePriority: source.priority,
		urlValue,
	};
}

async function parseVmessNode(
	line: string,
	source: SourceConfig,
): Promise<ParsedNode> {
	const encoded = line.slice("vmess://".length);
	const decoded = tryDecodeBase64Text(encoded);
	if (!decoded) {
		throw new Error("vmess 节点解码失败");
	}

	let payload: Record<string, string>;
	try {
		payload = JSON.parse(decoded) as Record<string, string>;
	} catch (error) {
		throw new Error(
			error instanceof Error ? `vmess JSON 无法解析: ${error.message}` : "vmess JSON 无法解析",
		);
	}

	const host = payload.add ?? "unknown";
	const port = payload.port ?? "443";
	const identifier = payload.id ?? payload.uuid ?? "unknown";

	return {
		kind: "vmess",
		protocol: "vmess",
		rawUri: line,
		originalName: payload.ps ?? "",
		fallbackName: `${source.name} ${host}`.trim(),
		fingerprint: await sha256Base64Url(`vmess|${host}|${port}|${identifier}`),
		sourceId: source.id,
		sourceName: source.name,
		sourcePriority: source.priority,
		vmessPayload: payload,
	};
}

async function parseGenericNode(
	line: string,
	source: SourceConfig,
): Promise<ParsedNode> {
	try {
		const urlValue = new URL(line);
		const fallbackName = `${source.name} ${urlValue.hostname || "节点"}`.trim();
		const scheme = urlValue.protocol.replace(":", "").toLowerCase();
		const originalName = decodeHashName(urlValue.hash);
		const port = urlValue.port || (["hysteria2", "hy2", "tuic", "anytls", "trojan"].includes(scheme) ? "443" : "80");
		const userOrPass = urlValue.username || urlValue.password || "default";

		return {
			kind: "generic",
			protocol: scheme,
			rawUri: line,
			originalName,
			fallbackName,
			fingerprint: await sha256Base64Url(`${scheme}|${urlValue.hostname}|${port}|${userOrPass}`),
			sourceId: source.id,
			sourceName: source.name,
			sourcePriority: source.priority,
			urlValue,
		};
	} catch {
		return {
			kind: "generic",
			protocol: source.name.toLowerCase(),
			rawUri: line,
			originalName: "",
			fallbackName: `${source.name} 节点`,
			fingerprint: await sha256Base64Url(line.trim()),
			sourceId: source.id,
			sourceName: source.name,
			sourcePriority: source.priority,
		};
	}
}

function applyRenameRule(name: string, rule: RenameRuleConfig): string {
	switch (rule.type) {
		case "prefix":
			return `${rule.value}${name}`.trim();
		case "suffix":
			return `${name}${rule.value}`.trim();
		case "replace":
			return rule.match ? name.replaceAll(rule.match, rule.replace) : name;
		case "regex":
			if (!rule.match) {
				return name;
			}
			try {
				return name.replace(new RegExp(rule.match, "g"), rule.replace);
			} catch {
				return name;
			}
		default:
			return name;
	}
}

function serializeNode(node: ParsedNode, name: string): string {
	if (node.kind === "vmess" && node.vmessPayload) {
		const payload = {
			...node.vmessPayload,
			ps: name,
		};
		return `vmess://${utf8ToBase64(JSON.stringify(payload))}`;
	}

	if (node.urlValue) {
		const rewritten = new URL(node.urlValue.toString());
		rewritten.hash = name ? `#${encodeURIComponent(name)}` : "";
		return rewritten.toString();
	}

	if (node.rawUri) {
		const hashIndex = node.rawUri.indexOf("#");
		const base = hashIndex >= 0 ? node.rawUri.slice(0, hashIndex) : node.rawUri;
		return name ? `${base}#${encodeURIComponent(name)}` : base;
	}

	return node.rawUri;
}

function decodeHashName(hash: string): string {
	if (!hash) {
		return "";
	}
	try {
		return decodeURIComponent(hash.slice(1));
	} catch {
		return hash.slice(1);
	}
}

type ClashProxy = Record<string, string | number | boolean>;

export function buildClashSubscription(
	nodes: PreviewNode[],
	options: { templateId?: string | null; groupOrder?: string[] | null } = {},
): ClashBuildResult {
	const preset = getClashTemplatePreset(options.templateId);
	const proxies: ClashProxy[] = [];
	for (const node of nodes) {
		const parsed = parseClashProxy(node);
		if (parsed) {
			proxies.push(parsed);
		}
	}

	ensureUniqueClashProxyNames(proxies);
	const names = proxies
		.map((proxy) => String(proxy.name))
		.filter((value) => value.length > 0);
	const proxySection = renderClashProxySection(proxies);
	const groupOrder = resolveClashGroupOrder(options.groupOrder, preset.id);
	const proxyGroupsSection = renderClashProxyGroups(names, groupOrder, preset.includeAutoSelect);
	const yamlText = preset.yamlTemplate
		.replace(MIHOMO_TEMPLATE_PROXY_PLACEHOLDER, proxySection)
		.replace(MIHOMO_TEMPLATE_GROUPS_PLACEHOLDER, proxyGroupsSection);

	return {
		yamlText,
		proxyCount: proxies.length,
		skippedCount: Math.max(nodes.length - proxies.length, 0),
	};
}

function renderClashProxySection(proxies: ClashProxy[]): string {
	if (proxies.length === 0) {
		return "  []";
	}

	const lines: string[] = [];
	for (const proxy of proxies) {
		lines.push(`  - name: '${escapeYamlSingleQuoted(String(proxy.name))}'`);
		lines.push(`    type: ${proxy.type}`);
		lines.push(`    server: '${escapeYamlSingleQuoted(String(proxy.server))}'`);
		lines.push(`    port: ${Number(proxy.port)}`);
		for (const [key, value] of Object.entries(proxy)) {
			if (["name", "type", "server", "port"].includes(key)) {
				continue;
			}
			lines.push(`    ${key}: ${toYamlScalar(value)}`);
		}
	}
	return lines.join("\n");
}

function renderClashProxyGroups(
	proxyNames: string[],
	groupOrder: string[],
	includeAutoSelect: boolean,
): string {
	const normalizedNames = proxyNames.length > 0 ? proxyNames : ["DIRECT"];
	const lines: string[] = [];

	for (const name of groupOrder) {
		if (name === CLASH_AUTO_GROUP_NAME) {
			if (includeAutoSelect) {
				lines.push(...renderAutoProxyGroup(normalizedNames));
			}
			continue;
		}

		lines.push(...renderPolicyProxyGroup(name, normalizedNames, includeAutoSelect));
	}

	return lines.join("\n");
}

function renderPolicyProxyGroup(
	name: string,
	proxyNames: string[],
	includeAutoSelect: boolean,
): string[] {
	if (name === CLASH_SELECT_GROUP_NAME) {
		return renderProxyGroup(
			name,
			includeAutoSelect
				? [CLASH_AUTO_GROUP_NAME, "DIRECT", "REJECT", ...proxyNames]
				: ["DIRECT", ...proxyNames],
		);
	}

	if (name === "🛑 广告拦截") {
		return renderProxyGroup(name, ["REJECT", "DIRECT", CLASH_SELECT_GROUP_NAME]);
	}

	if (name === "🏠 私有网络" || name === "🔒 国内服务") {
		return renderProxyGroup(
			name,
			includeAutoSelect
				? ["DIRECT", "REJECT", CLASH_SELECT_GROUP_NAME, CLASH_AUTO_GROUP_NAME, ...proxyNames]
				: ["DIRECT", CLASH_SELECT_GROUP_NAME],
		);
	}

	return renderProxyGroup(
		name,
		includeAutoSelect
			? [CLASH_SELECT_GROUP_NAME, CLASH_AUTO_GROUP_NAME, "DIRECT", "REJECT", ...proxyNames]
			: [CLASH_SELECT_GROUP_NAME, "DIRECT"],
	);
}

function renderAutoProxyGroup(proxyNames: string[]): string[] {
	const deduped = Array.from(new Set(proxyNames.filter((value) => value.trim().length > 0)));
	return [
		`  - name: '${escapeYamlSingleQuoted(CLASH_AUTO_GROUP_NAME)}'`,
		"    type: url-test",
		"    proxies:",
		...deduped.map((value) => `      - '${escapeYamlSingleQuoted(value)}'`),
		"    url: 'https://www.gstatic.com/generate_204'",
		"    interval: 300",
		"    lazy: false",
	];
}

function renderProxyGroup(name: string, options: string[]): string[] {
	const deduped = Array.from(new Set(options.filter((value) => value.trim().length > 0)));
	return [
		`  - name: '${escapeYamlSingleQuoted(name)}'`,
		"    type: select",
		"    proxies:",
		...deduped.map((value) => `      - '${escapeYamlSingleQuoted(value)}'`),
	];
}

function ensureUniqueClashProxyNames(proxies: ClashProxy[]): void {
	const seen = new Map<string, number>();

	for (const proxy of proxies) {
		const rawName = String(proxy.name || "").trim();
		const baseName = rawName || "Unnamed";
		const current = seen.get(baseName) ?? 0;
		if (current === 0) {
			seen.set(baseName, 1);
			proxy.name = baseName;
			continue;
		}

		let suffix = current + 1;
		let candidate = `${baseName} (${suffix})`;
		while (seen.has(candidate)) {
			suffix += 1;
			candidate = `${baseName} (${suffix})`;
		}
		seen.set(baseName, suffix);
		seen.set(candidate, 1);
		proxy.name = candidate;
	}
}

function parseClashProxy(node: PreviewNode): ClashProxy | null {
	const schemeIndex = node.finalUri.indexOf("://");
	if (schemeIndex <= 0) {
		return null;
	}

	const protocol = node.finalUri.slice(0, schemeIndex).toLowerCase();
	if (protocol === "vmess") {
		return parseVmessToClash(node);
	}
	if (protocol === "vless") {
		return parseVlessToClash(node);
	}
	if (protocol === "trojan") {
		return parseTrojanToClash(node);
	}
	if (protocol === "ss") {
		return parseShadowsocksToClash(node);
	}
	if (protocol === "hysteria2" || protocol === "hy2") {
		return parseHysteria2ToClash(node);
	}
	if (protocol === "tuic") {
		return parseTuicToClash(node);
	}
	if (protocol === "anytls") {
		return parseAnyTlsToClash(node);
	}
	return null;
}

function parseVmessToClash(node: PreviewNode): ClashProxy | null {
	const encoded = node.finalUri.slice("vmess://".length).trim();
	const decoded = tryDecodeBase64Text(encoded);
	if (!decoded) {
		return null;
	}

	let payload: Record<string, string>;
	try {
		payload = JSON.parse(decoded) as Record<string, string>;
	} catch {
		return null;
	}

	const server = payload.add?.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(payload.port);
	const uuid = payload.id?.trim();
	if (!uuid) {
		return null;
	}

	const network = (payload.net || "tcp").toLowerCase();
	const proxy: ClashProxy = {
		name: node.finalName || payload.ps || server,
		type: "vmess",
		server,
		port,
		uuid,
		alterId: Number.parseInt(payload.aid || "0", 10) || 0,
		cipher: payload.scy || "auto",
		tls: isTruthy(payload.tls),
		udp: payload.udp !== undefined ? parseBooleanLike(String(payload.udp)) ?? true : true,
		network: ["tcp", "ws", "grpc", "http", "h2"].includes(network) ? network : "tcp",
	};

	const skipCertVerify = parseBooleanLike(
		String(payload["skip-cert-verify"] ?? payload["skip_cert_verify"] ?? payload.insecure ?? payload.allowInsecure ?? ""),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const wsPath = payload.path?.trim() || "";
	const wsHost = payload.host?.trim() || "";
	if (network === "ws") {
		if (wsPath) {
			proxy["ws-opts"] = `{ path: '${escapeYamlSingleQuoted(wsPath)}'${wsHost ? `, headers: { Host: '${escapeYamlSingleQuoted(wsHost)}' }` : ""} }`;
		} else if (wsHost) {
			proxy["ws-opts"] = `{ headers: { Host: '${escapeYamlSingleQuoted(wsHost)}' } }`;
		}
	}

	if (network === "grpc") {
		const serviceName = payload.path?.trim() || "";
		if (serviceName) {
			proxy["grpc-opts"] = `{ grpc-service-name: '${escapeYamlSingleQuoted(serviceName)}' }`;
		}
	}

	if (proxy.tls) {
		const sni = payload.sni?.trim() || payload.host?.trim() || "";
		if (sni) {
			proxy.servername = sni;
		}
	}

	return proxy;
}

function parseVlessToClash(node: PreviewNode): ClashProxy | null {
	let urlValue: URL;
	try {
		urlValue = new URL(node.finalUri);
	} catch {
		return null;
	}

	const server = urlValue.hostname.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(urlValue.port);
	const uuid = decodeURIComponent(urlValue.username || "").trim();
	if (!uuid) {
		return null;
	}

	const security = (firstQuery(urlValue, ["security"]) || "").toLowerCase();
	const network = (firstQuery(urlValue, ["type", "network"]) || "tcp").toLowerCase();
	const tlsEnabled =
		security === "tls" ||
		security === "reality" ||
		(network === "ws" && security === "tls");

	const vlessUdp = parseBooleanLike(firstQuery(urlValue, ["udp"]));
	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "vless",
		server,
		port,
		uuid,
		udp: vlessUdp !== null ? vlessUdp : true,
		tls: tlsEnabled,
		network: ["tcp", "ws", "grpc", "http", "h2"].includes(network) ? network : "tcp",
	};

	const skipCertVerify = parseBooleanLike(
		firstQuery(urlValue, ["skip-cert-verify", "skip_cert_verify", "insecure", "allowinsecure"]),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const flow = firstQuery(urlValue, ["flow"]) || "";
	if (flow) {
		proxy.flow = flow;
	}

	const clientFingerprint = firstQuery(urlValue, ["fp", "fingerprint"]) || "";
	if (clientFingerprint) {
		proxy["client-fingerprint"] = clientFingerprint;
	}

	const sni = firstQuery(urlValue, ["sni", "servername", "peer"]) || "";
	if (sni) {
		proxy.servername = sni;
	}

	const alpn = parseCsvList(firstQuery(urlValue, ["alpn"]));
	if (alpn.length > 0) {
		proxy.alpn = formatYamlInlineArray(alpn);
	}

	if (security === "reality") {
		const publicKey = firstQuery(urlValue, [
			"pbk",
			"public-key",
			"public_key",
			"publicKey",
			"pk",
		]);
		const shortId = firstQuery(urlValue, [
			"sid",
			"short-id",
			"short_id",
			"shortid",
			"shortId",
		]);

		if (publicKey && shortId) {
			proxy["reality-opts"] =
				`{ public-key: '${escapeYamlSingleQuoted(publicKey)}', short-id: '${escapeYamlSingleQuoted(shortId)}' }`;
		} else if (publicKey) {
			proxy["reality-opts"] = `{ public-key: '${escapeYamlSingleQuoted(publicKey)}' }`;
		} else if (shortId) {
			proxy["reality-opts"] = `{ short-id: '${escapeYamlSingleQuoted(shortId)}' }`;
		}
	}

	if (network === "ws") {
		const path = firstQuery(urlValue, ["path"]) || "";
		const host = firstQuery(urlValue, ["host"]) || "";
		if (path) {
			proxy["ws-opts"] = `{ path: '${escapeYamlSingleQuoted(path)}'${host ? `, headers: { Host: '${escapeYamlSingleQuoted(host)}' }` : ""} }`;
		} else if (host) {
			proxy["ws-opts"] = `{ headers: { Host: '${escapeYamlSingleQuoted(host)}' } }`;
		}
	}

	if (network === "grpc") {
		const serviceName = firstQuery(urlValue, ["serviceName", "service_name"]) || "";
		if (serviceName) {
			proxy["grpc-opts"] = `{ grpc-service-name: '${escapeYamlSingleQuoted(serviceName)}' }`;
		}
	}

	return proxy;
}

function parseTrojanToClash(node: PreviewNode): ClashProxy | null {
	let urlValue: URL;
	try {
		urlValue = new URL(node.finalUri);
	} catch {
		return null;
	}

	const server = urlValue.hostname.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(urlValue.port || "443");
	const password = decodeURIComponent(urlValue.username || "").trim();
	if (!password) {
		return null;
	}

	const network = (urlValue.searchParams.get("type") || "tcp").toLowerCase();
	const trojanUdp = parseBooleanLike(firstQuery(urlValue, ["udp"]));
	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "trojan",
		server,
		port,
		password,
		udp: trojanUdp !== null ? trojanUdp : true,
		tls: true,
		network: ["tcp", "ws", "grpc"].includes(network) ? network : "tcp",
	};

	const skipCertVerify = parseBooleanLike(
		firstQuery(urlValue, ["skip-cert-verify", "skip_cert_verify", "insecure", "allowinsecure"]),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const sni = urlValue.searchParams.get("sni") || "";
	if (sni) {
		proxy.sni = sni;
	}

	if (network === "ws") {
		const path = urlValue.searchParams.get("path") || "";
		const host = urlValue.searchParams.get("host") || "";
		if (path) {
			proxy["ws-opts"] = `{ path: '${escapeYamlSingleQuoted(path)}'${host ? `, headers: { Host: '${escapeYamlSingleQuoted(host)}' }` : ""} }`;
		} else if (host) {
			proxy["ws-opts"] = `{ headers: { Host: '${escapeYamlSingleQuoted(host)}' } }`;
		}
	}

	if (network === "grpc") {
		const serviceName = urlValue.searchParams.get("serviceName") || urlValue.searchParams.get("service_name") || "";
		if (serviceName) {
			proxy["grpc-opts"] = `{ grpc-service-name: '${escapeYamlSingleQuoted(serviceName)}' }`;
		}
	}

	return proxy;
}

function parseShadowsocksToClash(node: PreviewNode): ClashProxy | null {
	const raw = node.finalUri.trim();
	if (!raw.toLowerCase().startsWith("ss://")) {
		return null;
	}

	const withoutScheme = raw.slice("ss://".length);
	const hashIndex = withoutScheme.indexOf("#");
	const core = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
	const atIndex = core.lastIndexOf("@");

	let userInfo = "";
	let serverPort = "";
	if (atIndex > -1) {
		userInfo = core.slice(0, atIndex);
		serverPort = core.slice(atIndex + 1);
	} else {
		const decoded = tryDecodeBase64Text(core);
		if (!decoded) {
			return null;
		}
		const decodedAt = decoded.lastIndexOf("@");
		if (decodedAt < 0) {
			return null;
		}
		userInfo = decoded.slice(0, decodedAt);
		serverPort = decoded.slice(decodedAt + 1);
	}

	if (!serverPort) {
		return null;
	}

	const lastColon = serverPort.lastIndexOf(":");
	if (lastColon <= 0) {
		return null;
	}

	const server = serverPort.slice(0, lastColon).trim();
	const portRaw = serverPort.slice(lastColon + 1).trim();
	if (!server || !portRaw) {
		return null;
	}
	const port = parsePort(portRaw);

	const decodedUserInfo = decodeSsUserInfo(userInfo);
	if (!decodedUserInfo) {
		return null;
	}

	const split = decodedUserInfo.indexOf(":");
	if (split <= 0) {
		return null;
	}
	const cipher = decodedUserInfo.slice(0, split).trim();
	const password = decodedUserInfo.slice(split + 1).trim();
	if (!cipher || !password) {
		return null;
	}

	return {
		name: node.finalName || server,
		type: "ss",
		server,
		port,
		cipher,
		password,
		udp: true,
	};
}

function parseHysteria2ToClash(node: PreviewNode): ClashProxy | null {
	let urlValue: URL;
	try {
		urlValue = new URL(node.finalUri);
	} catch {
		return null;
	}

	const server = urlValue.hostname.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(urlValue.port || "443");
	const password = decodeURIComponent(urlValue.username || urlValue.password || "").trim();
	if (!password) {
		return null;
	}

	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "hysteria2",
		server,
		port,
		password,
	};

	const sni = firstQuery(urlValue, ["sni", "peer"]);
	if (sni) {
		proxy.sni = sni;
	}

	const skipCertVerify = parseBooleanLike(
		firstQuery(urlValue, ["skip-cert-verify", "skip_cert_verify", "insecure", "allowinsecure"]),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const fingerprint = firstQuery(urlValue, ["fp", "fingerprint"]);
	if (fingerprint) {
		proxy.fingerprint = fingerprint;
	}

	const obfs = firstQuery(urlValue, ["obfs"]);
	if (obfs) {
		proxy.obfs = obfs;
	}
	const obfsPassword = firstQuery(urlValue, ["obfs-password", "obfs_password", "obfsPassword"]);
	if (obfsPassword) {
		proxy["obfs-password"] = obfsPassword;
	}

	const alpn = parseCsvList(firstQuery(urlValue, ["alpn"]));
	if (alpn.length > 0) {
		proxy.alpn = formatYamlInlineArray(alpn);
	}

	const up = normalizeSpeedValue(firstQuery(urlValue, ["up", "upmbps", "up_mbps"]));
	const down = normalizeSpeedValue(firstQuery(urlValue, ["down", "downmbps", "down_mbps"]));
	if (up) {
		proxy.up = up;
	}
	if (down) {
		proxy.down = down;
	}

	const ports = firstQuery(urlValue, ["ports"]);
	if (ports) {
		proxy.ports = ports;
	}

	const hopInterval = parseIntegerLike(firstQuery(urlValue, ["hop-interval", "hop_interval", "hopInterval"]));
	if (hopInterval !== null) {
		proxy["hop-interval"] = hopInterval;
	}

	return proxy;
}

function parseTuicToClash(node: PreviewNode): ClashProxy | null {
	let urlValue: URL;
	try {
		urlValue = new URL(node.finalUri);
	} catch {
		return null;
	}

	const server = urlValue.hostname.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(urlValue.port || "443");
	const username = decodeURIComponent(urlValue.username || "").trim();
	const password = decodeURIComponent(urlValue.password || "").trim();

	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "tuic",
		server,
		port,
	};

	if (username && password) {
		proxy.uuid = username;
		proxy.password = password;
	} else if (username) {
		if (looksLikeUuid(username)) {
			proxy.uuid = username;
			const queryPassword = firstQuery(urlValue, ["password", "passwd"]);
			if (queryPassword) {
				proxy.password = queryPassword;
			}
		} else {
			proxy.token = username;
		}
	}

	if (!proxy.uuid && !proxy.token) {
		return null;
	}

	const queryToken = firstQuery(urlValue, ["token"]);
	if (queryToken && !proxy.token) {
		proxy.token = queryToken;
	}

	const queryPassword = firstQuery(urlValue, ["password", "passwd"]);
	if (queryPassword && !proxy.password) {
		proxy.password = queryPassword;
	}

	const sni = firstQuery(urlValue, ["sni"]);
	if (sni) {
		proxy.sni = sni;
	}

	const disableSni = parseBooleanLike(firstQuery(urlValue, ["disable-sni", "disable_sni"]));
	if (disableSni !== null) {
		proxy["disable-sni"] = disableSni;
	}

	const skipCertVerify = parseBooleanLike(
		firstQuery(urlValue, ["skip-cert-verify", "skip_cert_verify", "insecure", "allowinsecure"]),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const reduceRtt = parseBooleanLike(firstQuery(urlValue, ["reduce-rtt", "reduce_rtt"]));
	if (reduceRtt !== null) {
		proxy["reduce-rtt"] = reduceRtt;
	}

	const fastOpen = parseBooleanLike(firstQuery(urlValue, ["fast-open", "fast_open"]));
	if (fastOpen !== null) {
		proxy["fast-open"] = fastOpen;
	}

	const udpRelayMode = firstQuery(urlValue, ["udp-relay-mode", "udp_relay_mode"]);
	if (udpRelayMode) {
		proxy["udp-relay-mode"] = udpRelayMode;
	}

	const congestionController = firstQuery(urlValue, [
		"congestion-controller",
		"congestion_control",
		"congestionController",
	]);
	if (congestionController) {
		proxy["congestion-controller"] = congestionController;
	}

	const heartbeatInterval = parseIntegerLike(firstQuery(urlValue, [
		"heartbeat-interval",
		"heartbeat_interval",
		"heartbeatInterval",
	]));
	if (heartbeatInterval !== null) {
		proxy["heartbeat-interval"] = heartbeatInterval;
	}

	const requestTimeout = parseIntegerLike(firstQuery(urlValue, [
		"request-timeout",
		"request_timeout",
		"requestTimeout",
	]));
	if (requestTimeout !== null) {
		proxy["request-timeout"] = requestTimeout;
	}

	const maxUdpRelayPacketSize = parseIntegerLike(firstQuery(urlValue, [
		"max-udp-relay-packet-size",
		"max_udp_relay_packet_size",
	]));
	if (maxUdpRelayPacketSize !== null) {
		proxy["max-udp-relay-packet-size"] = maxUdpRelayPacketSize;
	}

	const maxOpenStreams = parseIntegerLike(firstQuery(urlValue, [
		"max-open-streams",
		"max_open_streams",
	]));
	if (maxOpenStreams !== null) {
		proxy["max-open-streams"] = maxOpenStreams;
	}

	const ip = firstQuery(urlValue, ["ip"]);
	if (ip) {
		proxy.ip = ip;
	}

	const alpn = parseCsvList(firstQuery(urlValue, ["alpn"]));
	if (alpn.length > 0) {
		proxy.alpn = formatYamlInlineArray(alpn);
	}

	return proxy;
}

function parseAnyTlsToClash(node: PreviewNode): ClashProxy | null {
	let urlValue: URL;
	try {
		urlValue = new URL(node.finalUri);
	} catch {
		return null;
	}

	const server = urlValue.hostname.trim();
	if (!server) {
		return null;
	}
	const port = parsePort(urlValue.port || "443");
	const user = decodeURIComponent(urlValue.username || "").trim();
	const pass = decodeURIComponent(urlValue.password || "").trim();
	const queryPassword = firstQuery(urlValue, ["password", "passwd", "pass", "token"]);
	const password = user || pass || queryPassword || "";
	if (!password) {
		return null;
	}

	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "anytls",
		server,
		port,
		password,
		udp: true,
	};

	const udpValue = parseBooleanLike(firstQuery(urlValue, ["udp"]));
	if (udpValue !== null) {
		proxy.udp = udpValue;
	}

	const sni = firstQuery(urlValue, ["sni", "servername", "peer"]);
	if (sni) {
		proxy.sni = sni;
	}

	const clientFingerprint = firstQuery(urlValue, [
		"client-fingerprint",
		"client_fingerprint",
		"fp",
		"fingerprint",
	]);
	if (clientFingerprint) {
		proxy["client-fingerprint"] = clientFingerprint;
	}

	const alpn = parseCsvList(firstQuery(urlValue, ["alpn"]));
	if (alpn.length > 0) {
		proxy.alpn = formatYamlInlineArray(alpn);
	}

	const skipCertVerify = parseBooleanLike(
		firstQuery(urlValue, ["skip-cert-verify", "skip_cert_verify", "insecure", "allowinsecure"]),
	);
	if (skipCertVerify !== null) {
		proxy["skip-cert-verify"] = skipCertVerify;
	}

	const idleCheckInterval = parseIntegerLike(firstQuery(urlValue, [
		"idle-session-check-interval",
		"idle_session_check_interval",
		"idleSessionCheckInterval",
	]));
	if (idleCheckInterval !== null) {
		proxy["idle-session-check-interval"] = idleCheckInterval;
	}

	const idleTimeout = parseIntegerLike(firstQuery(urlValue, [
		"idle-session-timeout",
		"idle_session_timeout",
		"idleSessionTimeout",
	]));
	if (idleTimeout !== null) {
		proxy["idle-session-timeout"] = idleTimeout;
	}

	const minIdleSession = parseIntegerLike(firstQuery(urlValue, [
		"min-idle-session",
		"min_idle_session",
		"minIdleSession",
	]));
	if (minIdleSession !== null) {
		proxy["min-idle-session"] = minIdleSession;
	}

	return proxy;
}

function decodeSsUserInfo(value: string): string | null {
	const decoded = tryDecodeBase64Text(value);
	if (decoded && decoded.includes(":")) {
		return decoded;
	}
	try {
		const plain = decodeURIComponent(value);
		if (plain.includes(":")) {
			return plain;
		}
	} catch {
		return null;
	}
	if (value.includes(":")) {
		return value;
	}
	return null;
}

function parsePort(value: string | undefined): number {
	const parsed = Number.parseInt(value || "443", 10);
	if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
		return 443;
	}
	return parsed;
}

function parseIntegerLike(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return parsed;
}

function parseBooleanLike(value: string | null): boolean | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return null;
}

function firstQuery(urlValue: URL, keys: string[]): string | null {
	for (const key of keys) {
		const value = urlValue.searchParams.get(key);
		if (value && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function parseCsvList(value: string | null): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function formatYamlInlineArray(values: string[]): string {
	return `[${values.map((item) => `'${escapeYamlSingleQuoted(item)}'`).join(", ")}]`;
}

function normalizeSpeedValue(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (/[a-zA-Z]/.test(trimmed)) {
		return trimmed;
	}
	return `${trimmed} Mbps`;
}

function looksLikeUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isTruthy(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.toLowerCase();
	return ["1", "true", "tls", "yes"].includes(normalized);
}

function escapeYamlSingleQuoted(input: string): string {
	return input.replace(/'/g, "''");
}

const YAML_SPECIAL_LITERALS = new Set([
	"true",
	"false",
	"yes",
	"no",
	"on",
	"off",
	"null",
	"y",
	"n",
]);

function toYamlScalar(value: string | number | boolean): string {
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}

	const trimmed = value.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return trimmed;
	}

	if (/^[a-zA-Z0-9_.-]+$/.test(trimmed) && !YAML_SPECIAL_LITERALS.has(trimmed.toLowerCase())) {
		return trimmed;
	}

	return `'${escapeYamlSingleQuoted(value)}'`;
}
