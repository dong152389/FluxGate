import { tryDecodeBase64Text, utf8ToBase64 } from "./encoding";
import {
	MIHOMO_TEMPLATE_GROUPS_PLACEHOLDER,
	MIHOMO_TEMPLATE_PROXY_PLACEHOLDER,
} from "./mihomo-template";
import { getClashTemplatePreset, resolveClashTemplateId } from "./mihomo-template-presets";
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
			originalName,
			finalName,
			alias,
			rawUri: parsed.rawUri,
			finalUri: serializeNode(parsed, finalName),
		});
	}

	if (input.settings.sortMode === "name") {
		nodes.sort((left, right) => left.finalName.localeCompare(right.finalName, "zh-Hans-CN"));
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
				accept: "text/plain, */*",
				"user-agent": "SubFlow/1.0",
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

async function parseSubscriptionPayload(
	payload: string,
	source: SourceConfig,
): Promise<ParsedNode[]> {
	const lines = normalizeSubscriptionContent(payload);
	const nodes: ParsedNode[] = [];

	for (const line of lines) {
		const parsed = await parseNodeLine(line, source);
		if (parsed) {
			nodes.push(parsed);
		}
	}

	return nodes;
}

function normalizeSubscriptionContent(payload: string): string[] {
	const text = payload.trim();
	if (!text) {
		return [];
	}

	if (text.includes("://")) {
		return splitNodeLines(text);
	}

	const decoded = tryDecodeBase64Text(text);
	if (decoded && decoded.includes("://")) {
		return splitNodeLines(decoded);
	}

	return splitNodeLines(text);
}

function splitNodeLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("//"));
}

async function parseNodeLine(
	line: string,
	source: SourceConfig,
): Promise<ParsedNode | null> {
	const protocol = line.slice(0, line.indexOf("://")).toLowerCase();
	if (!protocol) {
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
		return {
			kind: "generic",
			protocol: urlValue.protocol.replace(":", ""),
			rawUri: line,
			originalName: decodeHashName(urlValue.hash),
			fallbackName,
			fingerprint: await sha256Base64Url(line.trim()),
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
	options: { templateId?: string | null } = {},
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
	const proxyGroupsSection = renderClashProxyGroups(
		names,
		preset.policyGroups,
		preset.includeAutoSelect,
	);
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
	policyGroups: string[],
	includeAutoSelect: boolean,
): string {
	const normalizedNames = proxyNames.length > 0 ? proxyNames : ["DIRECT"];
	const lines: string[] = [];

	if (includeAutoSelect) {
		lines.push(...renderAutoProxyGroup(normalizedNames));
		lines.push(
			...renderProxyGroup("🚀 节点选择", [
				"⚡ 自动选择",
				"DIRECT",
				"REJECT",
				...normalizedNames,
			]),
		);
	} else {
		lines.push(...renderProxyGroup("🚀 节点选择", ["DIRECT", ...normalizedNames]));
	}

	for (const name of policyGroups) {
		if (name === "🛑 广告拦截") {
			lines.push(...renderProxyGroup(name, ["REJECT", "DIRECT", "🚀 节点选择"]));
			continue;
		}
		if (name === "🏠 私有网络" || name === "🔒 国内服务") {
			lines.push(
				...renderProxyGroup(
					name,
					includeAutoSelect
						? ["DIRECT", "REJECT", "🚀 节点选择", "⚡ 自动选择", ...normalizedNames]
						: ["DIRECT", "🚀 节点选择"],
				),
			);
			continue;
		}
		lines.push(
			...renderProxyGroup(
				name,
				includeAutoSelect
					? ["🚀 节点选择", "⚡ 自动选择", "DIRECT", "REJECT", ...normalizedNames]
					: ["🚀 节点选择", "DIRECT"],
			),
		);
	}

	return lines.join("\n");
}

function renderAutoProxyGroup(proxyNames: string[]): string[] {
	const deduped = Array.from(new Set(proxyNames.filter((value) => value.trim().length > 0)));
	return [
		`  - name: '${escapeYamlSingleQuoted("⚡ 自动选择")}'`,
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
		udp: true,
	};

	if (network === "ws" || network === "grpc" || network === "http" || network === "h2") {
		proxy.network = network;
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

	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "vless",
		server,
		port,
		uuid,
		udp: true,
		tls: tlsEnabled,
		network: ["tcp", "ws", "grpc", "http", "h2"].includes(network) ? network : "tcp",
	};

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
	const proxy: ClashProxy = {
		name: node.finalName || server,
		type: "trojan",
		server,
		port,
		password,
		udp: true,
		tls: true,
		network: ["tcp", "ws", "grpc"].includes(network) ? network : "tcp",
	};

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
	return `'${escapeYamlSingleQuoted(value)}'`;
}
