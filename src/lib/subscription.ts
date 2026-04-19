import { tryDecodeBase64Text, utf8ToBase64 } from "./encoding";
import { sha256Base64Url } from "./security";
import type {
	AggregateResult,
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
	const payload = await fetchSourcePayload(source.url);
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
	sources: Array<SourceRow & { url: string }>;
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
						url: source.url,
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
			const payload = await fetchSourcePayload(source.url);
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
