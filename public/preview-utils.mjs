const CATEGORY_DEFINITIONS = [
	{ id: "core", label: "核心", color: "blue" },
	{ id: "common", label: "常用", color: "green" },
	{ id: "social", label: "社交", color: "violet" },
	{ id: "media", label: "媒体", color: "pink" },
	{ id: "games", label: "游戏", color: "orange" },
	{ id: "tech", label: "技术", color: "teal" },
	{ id: "payment", label: "支付", color: "gold" },
	{ id: "other", label: "其它", color: "slate" },
];

const PROVIDER_LABELS = {
	"category-ads-all": "广告域名",
	"category-ai-chat-!cn": "AI 服务合集",
	anthropic: "Anthropic (Claude)",
	atlassian: "Atlassian",
	apple: "Apple",
	bbc: "BBC",
	binance: "Binance",
	bloomberg: "Bloomberg",
	cn: "中国域名",
	"cn-ip": "中国 IP",
	cnn: "CNN",
	ebay: "eBay",
	"geolocation-!cn": "海外域名",
	"geolocation-cn": "国内域名",
	github: "GitHub",
	gitlab: "GitLab",
	google: "Google",
	"google-ip": "Google IP",
	icloud: "iCloud",
	microsoft: "Microsoft",
	nytimes: "New York Times",
	onedrive: "OneDrive",
	openai: "OpenAI",
	private: "私有域名",
	"private-ip": "私有 IP",
	telegram: "Telegram",
	"telegram-ip": "Telegram IP",
	wise: "Wise",
	wsj: "Wall Street Journal",
	youtube: "YouTube",
};

const STRATEGY_LABELS = {
	"⚡ 自动选择": "自动选择",
	"🚀 节点选择": "节点选择",
	DIRECT: "直连",
	REJECT: "拒绝",
};

export function parseTemplateYamlSummary(yamlText, templateId) {
	const proxiesSection = readYamlSection(yamlText, "proxies", "proxy-groups");
	const groupsSection = readYamlSection(yamlText, "proxy-groups", "rule-providers");
	const providersSection = readYamlSection(yamlText, "rule-providers", "rules");
	const rulesSection = readYamlSection(yamlText, "rules", null);

	const providerMap = parseRuleProviders(providersSection);
	const ruleItemsByGroup = parseRules(rulesSection, providerMap);
	const nodes = parseTemplateProxies(proxiesSection);
	const groups = parseTemplateProxyGroups(groupsSection, ruleItemsByGroup);
	const ruleProviderCount = countYamlMappings(providersSection, 2);
	const ruleCount = countYamlListItems(rulesSection, 2);
	const snippet = yamlText.length > 3200
		? `${yamlText.slice(0, 3200)}\n\n# ... 预览截断，复制可获取完整 YAML`
		: yamlText;

	return {
		templateId,
		yamlText,
		yamlSnippet: snippet,
		metrics: {
			nodeCount: nodes.length,
			groupCount: groups.length,
			ruleProviderCount,
			ruleCount,
		},
		legend: buildLegend(groups),
		groups,
		nodes,
	};
}

function readYamlSection(yamlText, startKey, endKey) {
	const startRegex = new RegExp(`^${escapeRegex(startKey)}:\\r?\\n`, "m");
	const startMatch = startRegex.exec(yamlText);
	if (!startMatch) {
		return "";
	}

	const startIndex = startMatch.index + startMatch[0].length;
	if (!endKey) {
		return yamlText.slice(startIndex);
	}

	const sliced = yamlText.slice(startIndex);
	const endRegex = new RegExp(`^${escapeRegex(endKey)}:\\r?\\n`, "m");
	const endMatch = endRegex.exec(sliced);
	if (!endMatch) {
		return sliced;
	}

	return sliced.slice(0, endMatch.index);
}

function countYamlListItems(sectionText, indentSpaces) {
	if (!sectionText) {
		return 0;
	}
	const regex = new RegExp(`^\\s{${indentSpaces}}-\\s`, "gm");
	return [...sectionText.matchAll(regex)].length;
}

function countYamlMappings(sectionText, indentSpaces) {
	if (!sectionText) {
		return 0;
	}
	const regex = new RegExp(`^\\s{${indentSpaces}}[^\\s#][^:]*:\\s`, "gm");
	return [...sectionText.matchAll(regex)].length;
}

function parseTemplateProxies(sectionText) {
	if (!sectionText) {
		return [];
	}

	const lines = sectionText.split(/\r?\n/);
	const nodes = [];
	let current = null;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const nameMatch = line.match(/^\s{2}-\sname:\s(.+)$/);
		if (nameMatch) {
			if (current) {
				nodes.push(current);
			}
			current = {
				name: normalizeYamlValue(nameMatch[1]),
				protocol: "UNKNOWN",
			};
			continue;
		}

		if (!current) {
			continue;
		}

		const typeMatch = line.match(/^\s{4}type:\s(.+)$/);
		if (typeMatch) {
			current.protocol = normalizeProtocol(normalizeYamlValue(typeMatch[1]));
		}
	}

	if (current) {
		nodes.push(current);
	}

	return nodes;
}

function parseTemplateProxyGroups(sectionText, ruleItemsByGroup) {
	if (!sectionText) {
		return [];
	}

	const lines = sectionText.split(/\r?\n/);
	const groups = [];
	let current = null;
	let readingProxyList = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const nameMatch = line.match(/^\s{2}-\sname:\s(.+)$/);
		if (nameMatch) {
			if (current) {
				groups.push(finishGroup(current, ruleItemsByGroup));
			}
			current = {
				name: normalizeYamlValue(nameMatch[1]),
				type: "select",
				defaultProxy: "-",
				proxyCount: 0,
				proxies: [],
			};
			readingProxyList = false;
			continue;
		}

		if (!current) {
			continue;
		}

		const typeMatch = line.match(/^\s{4}type:\s(.+)$/);
		if (typeMatch) {
			current.type = normalizeYamlValue(typeMatch[1]);
			continue;
		}

		if (/^\s{4}proxies:\s*$/.test(line)) {
			readingProxyList = true;
			continue;
		}

		if (readingProxyList) {
			const proxyMatch = line.match(/^\s{6}-\s(.+)$/);
			if (proxyMatch) {
				const option = normalizeYamlValue(proxyMatch[1]);
				current.proxyCount += 1;
				current.proxies.push(option);
				if (current.defaultProxy === "-") {
					current.defaultProxy = option;
				}
				continue;
			}

			if (!/^\s{6}/.test(line)) {
				readingProxyList = false;
			}
		}
	}

	if (current) {
		groups.push(finishGroup(current, ruleItemsByGroup));
	}

	return groups;
}

function finishGroup(group, ruleItemsByGroup) {
	const category = resolveGroupCategory(group.name);
	const displayName = extractDisplayName(group.name);
	const icon = extractLeadingIcon(group.name);
	const modeLabel = resolveModeLabel(group);
	const defaultLabel = resolveStrategyLabel(group.defaultProxy);
	const ruleItems = ruleItemsByGroup.get(group.name) || [];
	const fallbackItems = ruleItems.length
		? ruleItems
		: group.proxies.map((proxy) => ({
			kind: "proxy",
			key: proxy,
			label: resolveStrategyLabel(proxy),
			badge: normalizeGroupType(group.type),
		}));

	return {
		...group,
		icon,
		displayName,
		category,
		modeLabel,
		defaultLabel,
		items: fallbackItems,
	};
}

function parseRuleProviders(sectionText) {
	const providerMap = new Map();
	if (!sectionText) {
		return providerMap;
	}

	for (const rawLine of sectionText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const match = line.match(/^([^\s:]+):\s*\{(.+)\}$/);
		if (!match) {
			continue;
		}

		const providerKey = match[1];
		const body = match[2];
		const behaviorMatch = body.match(/behavior:\s*([^,\s}]+)/);
		providerMap.set(providerKey, {
			key: providerKey,
			label: resolveProviderLabel(providerKey),
			behavior: behaviorMatch ? behaviorMatch[1].trim() : "rule",
		});
	}

	return providerMap;
}

function parseRules(sectionText, providerMap) {
	const grouped = new Map();
	if (!sectionText) {
		return grouped;
	}

	for (const rawLine of sectionText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("- ")) {
			continue;
		}

		const payload = line.slice(2);
		const segments = splitRuleSegments(payload);
		if (!segments.length) {
			continue;
		}

		const kind = segments[0];
		if (kind === "RULE-SET" && segments.length >= 3) {
			const providerKey = segments[1];
			const groupName = segments[2];
			const provider = providerMap.get(providerKey);
			pushGroupItem(grouped, groupName, {
				kind: "rule-provider",
				key: providerKey,
				label: provider?.label || resolveProviderLabel(providerKey),
				badge: provider?.behavior || "rule",
			});
			continue;
		}

		if (kind === "MATCH" && segments.length >= 2) {
			pushGroupItem(grouped, segments[1], {
				kind: "fallback",
				key: "MATCH",
				label: "默认兜底",
				badge: "match",
			});
		}
	}

	return grouped;
}

function pushGroupItem(map, groupName, item) {
	if (!map.has(groupName)) {
		map.set(groupName, []);
	}
	map.get(groupName).push(item);
}

function splitRuleSegments(value) {
	return `${value}`
		.split(",")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function buildLegend(groups) {
	const seen = new Set();
	const legend = [];
	for (const group of groups) {
		if (seen.has(group.category.id)) {
			continue;
		}
		seen.add(group.category.id);
		legend.push(group.category);
	}
	return legend;
}

function resolveGroupCategory(groupName) {
	const displayName = extractDisplayName(groupName);
	if (["节点选择", "自动选择"].includes(displayName)) {
		return categoryById("core");
	}
	if (["广告拦截", "AI 服务", "私有网络", "国内服务", "非中国", "漏网之鱼"].includes(displayName)) {
		return categoryById("common");
	}
	if (["电报消息", "推特/X", "Meta 系", "Discord", "其他社交"].includes(displayName)) {
		return categoryById("social");
	}
	if (["油管视频", "欧美流媒体", "奈飞", "迪士尼+", "亚洲流媒体"].includes(displayName)) {
		return categoryById("media");
	}
	if (["Steam", "PC 游戏", "主机游戏"].includes(displayName)) {
		return categoryById("games");
	}
	if (["教育学术", "云服务", "谷歌服务", "微软服务", "代码托管", "开发工具", "网盘存储", "苹果服务"].includes(displayName)) {
		return categoryById("tech");
	}
	if (["支付平台", "加密货币", "海淘购物"].includes(displayName)) {
		return categoryById("payment");
	}
	return categoryById("other");
}

function categoryById(id) {
	return CATEGORY_DEFINITIONS.find((item) => item.id === id) || CATEGORY_DEFINITIONS[CATEGORY_DEFINITIONS.length - 1];
}

function resolveModeLabel(group) {
	const displayName = extractDisplayName(group.name);
	if (displayName === "广告拦截") {
		return "拦截";
	}
	if (normalizeGroupType(group.type) === "url-test") {
		return "自动测速";
	}
	return "手动选择";
}

function normalizeGroupType(value) {
	return `${value || "select"}`.trim().toLowerCase();
}

function resolveStrategyLabel(value) {
	const normalized = normalizeYamlValue(value);
	return STRATEGY_LABELS[normalized] || normalized;
}

function resolveProviderLabel(providerKey) {
	if (PROVIDER_LABELS[providerKey]) {
		return PROVIDER_LABELS[providerKey];
	}

	return `${providerKey}`
		.split(/[-_]/g)
		.filter(Boolean)
		.map((segment) => {
			if (segment.toUpperCase() === segment || /^[0-9!]+$/.test(segment)) {
				return segment;
			}
			return segment.charAt(0).toUpperCase() + segment.slice(1);
		})
		.join(" ");
}

function extractDisplayName(value) {
	return `${value || ""}`.replace(/^[^\p{L}\p{N}]+/u, "").trim() || `${value || ""}`.trim();
}

function extractLeadingIcon(value) {
	const source = `${value || ""}`.trim();
	const displayName = extractDisplayName(source);
	if (!source || source === displayName) {
		return "";
	}
	const icon = source.slice(0, source.indexOf(displayName)).trim();
	return icon || "";
}

function normalizeProtocol(value) {
	return `${value || "UNKNOWN"}`.trim().toUpperCase();
}

function normalizeYamlValue(value) {
	const trimmed = `${value || ""}`.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith("\"") && trimmed.endsWith("\""))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function escapeRegex(value) {
	return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
