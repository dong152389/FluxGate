const state = {
	user: null,
	config: null,
	preview: null,
	authMode: "login",
	notice: null,
	toasts: [],
	sourceChecks: {},
	loading: true,
};

const app = document.getElementById("app");
const toastTimers = new Map();

boot();

async function boot() {
	render();
	try {
		const me = await api("/api/auth/me");
		state.user = me.user;
		state.config = await api("/api/config");
	} catch (error) {
		if (error.status !== 401) {
			pushNotice(error.message || "初始化失败", true);
		}
	} finally {
		state.loading = false;
		render();
	}
}

document.addEventListener("click", async (event) => {
	const button = event.target.closest("[data-action]");
	if (!button) {
		return;
	}

	const action = button.dataset.action;

	try {
		if (action === "dismiss-toast") {
			removeToast(button.dataset.id);
			return;
		}

		if (action === "switch-auth") {
			state.authMode = button.dataset.mode || "login";
			render();
			return;
		}

		if (!state.user || !state.config) {
			return;
		}

		syncDraftConfig();

		if (action === "add-source") {
			state.config.sources.push(blankSource());
			render();
			return;
		}

		if (action === "remove-source") {
			state.config.sources = state.config.sources.filter((source) => source.id !== button.dataset.id);
			render();
			return;
		}

		if (action === "test-source") {
			await withBusy(button, "测试中...", async () => {
				await handleTestSource(button.dataset.id);
			});
			return;
		}

		if (action === "add-rule") {
			state.config.renameRules.push(blankRule(state.config.renameRules.length));
			render();
			return;
		}

		if (action === "remove-rule") {
			state.config.renameRules = state.config.renameRules.filter((rule) => rule.id !== button.dataset.id);
			render();
			return;
		}

		if (action === "copy-public-url") {
			await copyText(state.config.publicUrl, "聚合链接已复制");
			return;
		}

		if (action === "copy-raw-output") {
			if (!state.preview) {
				pushNotice("请先生成预览", false, "warn");
				return;
			}
			await copyText(state.preview.rawText, "聚合文本已复制");
			return;
		}

		if (action === "copy-b64-output") {
			if (!state.preview) {
				pushNotice("请先生成预览", false, "warn");
				return;
			}
			await copyText(state.preview.encodedText, "Base64 订阅已复制");
			return;
		}

		if (action === "preview") {
			await withBusy(button, "生成中...", async () => {
				await loadPreview();
			});
			return;
		}

		if (action === "save-config") {
			await withBusy(button, "保存中...", async () => {
				await saveConfig();
			});
			return;
		}

		if (action === "refresh-cache") {
			await withBusy(button, "刷新中...", async () => {
				const result = await api("/api/refresh", { method: "POST" });
				state.config.publicUrl = result.publicUrl;
				pushNotice("缓存版本已刷新，新的拉取会重新聚合");
				render();
			});
			return;
		}

		if (action === "reset-token") {
			await withBusy(button, "重置中...", async () => {
				const result = await api("/api/auth/reset-public-token", { method: "POST" });
				state.config.publicToken = result.publicToken;
				state.config.publicUrl = result.publicUrl;
				pushNotice("公开订阅 token 已重置，旧链接已失效");
				render();
			});
			return;
		}

		if (action === "logout") {
			await withBusy(button, "退出中...", async () => {
				await api("/api/auth/logout", { method: "POST" });
				state.user = null;
				state.config = null;
				state.preview = null;
				state.sourceChecks = {};
				pushNotice("已退出登录");
				render();
			});
			return;
		}

		if (action === "save-alias") {
			await withBusy(button, "保存中...", async () => {
				await saveAlias(button.dataset.fingerprint);
			});
		}
	} catch (error) {
		pushNotice(error.message || "操作失败", true);
		render();
	}
});

document.addEventListener("submit", async (event) => {
	const form = event.target;
	if (!(form instanceof HTMLFormElement)) {
		return;
	}

	event.preventDefault();
	const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;

	try {
		if (form.dataset.form === "auth") {
			await withBusy(submitter, state.authMode === "register" ? "创建中..." : "登录中...", async () => {
				await submitAuth(form);
			});
			return;
		}

		if (form.dataset.form === "password") {
			await withBusy(submitter, "更新中...", async () => {
				await submitPasswordChange(form);
			});
		}
	} catch (error) {
		pushNotice(error.message || "提交失败", true);
		render();
	}
});

function render() {
	if (state.loading) {
		app.innerHTML = renderLoading();
		return;
	}

	if (!state.user || !state.config) {
		app.innerHTML = renderAuth();
		return;
	}

	app.innerHTML = renderDashboard();
}

function renderLoading() {
	return `
		<div class="auth-wrap">
			<div class="auth-card">
				<section class="auth-hero">
					<div class="eyebrow">FluxGate</div>
					<h1>准备你的聚合控制台</h1>
					<p>正在初始化会话和本地配置，请稍候。</p>
				</section>
				<section class="auth-panel">
					<p class="support-text">连接 Worker、读取会话、加载配置中…</p>
				</section>
			</div>
		</div>
		${renderToasts()}
	`;
}

function renderAuth() {
	return `
		<div class="auth-wrap">
			<div class="auth-card">
				<section class="auth-hero">
					<div class="eyebrow">Secure Merge</div>
					<h1>FluxGate</h1>
					<p>把多个上游订阅整合成一个安全、可控、可重命名的新订阅入口。</p>
					<ul>
						<li>支持多订阅源聚合与去重</li>
						<li>支持批量改名和单节点别名</li>
						<li>每个用户独立 token 与隔离配置</li>
					</ul>
				</section>
				<section class="auth-panel">
					<div class="tabs">
						<button class="tab ${state.authMode === "login" ? "active" : ""}" data-action="switch-auth" data-mode="login">登录</button>
						<button class="tab ${state.authMode === "register" ? "active" : ""}" data-action="switch-auth" data-mode="register">注册</button>
					</div>
					<form data-form="auth" data-mode="${state.authMode}" class="stack">
						<div class="field">
							<label for="auth-username">用户名</label>
							<input id="auth-username" name="username" placeholder="例如 dong5" autocomplete="username" required />
						</div>
						${state.authMode === "register"
							? `<div class="field">
									<label for="auth-email">邮箱（可选）</label>
									<input id="auth-email" name="email" placeholder="you@example.com" autocomplete="email" />
								</div>`
							: ""}
						<div class="field">
							<label for="auth-password">密码</label>
							<input id="auth-password" name="password" type="password" autocomplete="${state.authMode === "register" ? "new-password" : "current-password"}" required />
						</div>
						<button class="btn btn-primary" type="submit">${state.authMode === "register" ? "创建账号并进入控制台" : "登录控制台"}</button>
					</form>
					<p class="footer-note">首版默认使用用户名密码登录，公开订阅链接与登录态分离。</p>
				</section>
			</div>
		</div>
		${renderToasts()}
	`;
}

function renderDashboard() {
	const sourceCount = state.config.sources.length;
	const ruleCount = state.config.renameRules.length;
	const previewCount = state.preview?.nodeCount ?? 0;

	return `
		<div class="shell">
			<section class="hero">
				<div class="hero-card">
					<div class="eyebrow">FluxGate Console</div>
					<h1>聚合多个订阅，发布一个稳定入口。</h1>
					<p>当前账号 <strong>${escapeHtml(state.user.username)}</strong> 正在管理自己的订阅源、改名规则和公开拉取 token。你可以先保存配置，再生成预览或刷新公开缓存。</p>
					<div class="hero-metrics">
						<div class="metric"><strong>${sourceCount}</strong><span>订阅源</span></div>
						<div class="metric"><strong>${ruleCount}</strong><span>改名规则</span></div>
						<div class="metric"><strong>${previewCount}</strong><span>预览节点</span></div>
					</div>
				</div>
				<div class="hero-side">
					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>公开订阅</h2>
								<p>客户端填这个链接即可拉取聚合结果</p>
							</div>
							<span class="badge ok">用户隔离已开启</span>
						</div>
						<div class="field">
							<label for="public-url">聚合链接</label>
							<input id="public-url" value="${escapeAttribute(state.config.publicUrl)}" readonly />
						</div>
						<div class="toolbar">
							<button class="btn btn-primary btn-small" data-action="copy-public-url">复制链接</button>
							<button class="btn btn-secondary btn-small" data-action="reset-token">重置 token</button>
							<button class="btn btn-ghost btn-small" data-action="refresh-cache">刷新缓存</button>
						</div>
						<p class="footer-note">重置 token 后，旧链接会立即失效。</p>
					</section>
					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>发布节奏</h2>
								<p>推荐流程：保存配置 → 预览节点 → 给客户端使用公开链接</p>
							</div>
						</div>
						<div class="inline-actions">
							<span class="pill">Base64 输出</span>
							<span class="pill">单节点别名</span>
							<span class="pill">Cloudflare Worker</span>
						</div>
					</section>
				</div>
			</section>

			<section class="grid">
				<div class="stack">
					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>订阅源管理</h2>
								<p>添加多个上游链接，控制优先级、启用状态和单源测试。</p>
							</div>
							<div class="toolbar">
								<button class="btn btn-secondary btn-small" data-action="add-source">新增订阅源</button>
								<button class="btn btn-primary btn-small" data-action="save-config">保存配置</button>
							</div>
						</div>
						<div class="section-list">
							${state.config.sources.length ? state.config.sources.map(renderSourceCard).join("") : `
								<div class="empty-state">
									还没有订阅源。先添加一个 https:// 开头的订阅地址。
								</div>
							`}
						</div>
					</section>

					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>聚合规则</h2>
								<p>控制去重、来源前缀、无名节点保留方式和排序策略。</p>
							</div>
						</div>
						<div class="settings-grid">
							<div class="field">
								<label class="toggle-row"><input type="checkbox" id="setting-dedupe" ${state.config.settings.dedupeEnabled ? "checked" : ""} />启用去重</label>
							</div>
							<div class="field">
								<label class="toggle-row"><input type="checkbox" id="setting-prefix-source" ${state.config.settings.prefixSourceName ? "checked" : ""} />节点名前加来源标记</label>
							</div>
							<div class="field">
								<label for="setting-prefix-template">来源前缀模板</label>
								<input id="setting-prefix-template" value="${escapeAttribute(state.config.settings.sourcePrefixTemplate)}" placeholder="[{{source}}] " />
							</div>
							<div class="field">
								<label for="setting-sort-mode">节点排序</label>
								<select id="setting-sort-mode">
									<option value="source-priority" ${state.config.settings.sortMode === "source-priority" ? "selected" : ""}>按来源优先级</option>
									<option value="name" ${state.config.settings.sortMode === "name" ? "selected" : ""}>按最终名称</option>
								</select>
							</div>
							<div class="field">
								<label class="toggle-row"><input type="checkbox" id="setting-keep-unnamed" ${state.config.settings.keepUnnamed ? "checked" : ""} />保留无名称节点</label>
							</div>
						</div>
					</section>

					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>批量改名规则</h2>
								<p>按顺序应用前缀、后缀、替换或正则替换。</p>
							</div>
							<button class="btn btn-secondary btn-small" data-action="add-rule">新增规则</button>
						</div>
						<div class="section-list">
							${state.config.renameRules.length ? state.config.renameRules.map(renderRuleCard).join("") : `
								<div class="empty-state">
									还没有规则。你可以只用来源前缀，也可以添加批量替换。
								</div>
							`}
						</div>
					</section>
				</div>

				<div class="stack">
					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>节点预览</h2>
								<p>预览聚合效果，并对单个节点持久化别名。</p>
							</div>
							<div class="toolbar">
								<button class="btn btn-primary btn-small" data-action="preview">生成预览</button>
								<button class="btn btn-secondary btn-small" data-action="copy-raw-output">复制明文</button>
								<button class="btn btn-ghost btn-small" data-action="copy-b64-output">复制 Base64</button>
							</div>
						</div>
						${state.preview ? renderPreviewPanel() : `<div class="empty-state">预览尚未生成。建议在保存配置后执行一次预览。</div>`}
					</section>

					<section class="panel">
						<div class="panel-head">
							<div>
								<h2>账号安全</h2>
								<p>修改密码、退出登录和管理公开订阅入口。</p>
							</div>
						</div>
						<form data-form="password" class="stack">
							<div class="field">
								<label for="current-password">当前密码</label>
								<input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required />
							</div>
							<div class="field">
								<label for="new-password">新密码</label>
								<input id="new-password" name="newPassword" type="password" autocomplete="new-password" required />
							</div>
							<div class="toolbar">
								<button class="btn btn-primary btn-small" type="submit">更新密码</button>
								<button class="btn btn-danger btn-small" type="button" data-action="logout">退出登录</button>
							</div>
						</form>
					</section>
				</div>
			</section>
		</div>
		${renderToasts()}
	`;
}

function renderSourceCard(source, index) {
	const check = state.sourceChecks[source.id];
	return `
		<div class="item-card" data-source-id="${escapeAttribute(source.id)}">
			<div class="item-card-header">
				<div class="item-card-title">
					<span class="item-index">${index + 1}</span>
					<div>
						<strong>${escapeHtml(source.name || `来源 ${index + 1}`)}</strong>
						<div class="muted">${check ? escapeHtml(check.error ? check.error : `最近测试成功，节点 ${check.nodeCount}`) : "可单独测试这个源的可达性和节点数量"}</div>
					</div>
				</div>
				<div class="inline-actions">
					${check ? `<span class="badge ${check.error ? "fail" : "ok"}">${check.error ? "测试失败" : `节点 ${check.nodeCount}`}</span>` : ""}
					<button class="btn btn-secondary btn-small" data-action="test-source" data-id="${escapeAttribute(source.id)}">测试</button>
					<button class="btn btn-danger btn-small" data-action="remove-source" data-id="${escapeAttribute(source.id)}">删除</button>
				</div>
			</div>
			<div class="input-grid">
				<div class="input-grid two">
					<div class="field">
						<label>来源名称</label>
						<input data-source-field="name" value="${escapeAttribute(source.name)}" placeholder="机场 A" />
					</div>
					<div class="field">
						<label>优先级</label>
						<input data-source-field="priority" type="number" min="0" max="999" value="${Number(source.priority) || 0}" />
					</div>
				</div>
				<div class="field">
					<label>订阅链接</label>
					<input data-source-field="url" value="${escapeAttribute(source.url)}" placeholder="https://example.com/sub" />
				</div>
				<div class="input-grid two">
					<div class="field">
						<label class="toggle-row"><input data-source-field="enabled" type="checkbox" ${source.enabled ? "checked" : ""} />启用这个来源</label>
					</div>
					<div class="field">
						<label>备注</label>
						<input data-source-field="notes" value="${escapeAttribute(source.notes || "")}" placeholder="可记录机场套餐或用途" />
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderRuleCard(rule, index) {
	return `
		<div class="item-card" data-rule-id="${escapeAttribute(rule.id)}">
			<div class="item-card-header">
				<div class="item-card-title">
					<span class="item-index">R${index + 1}</span>
					<div>
						<strong>${escapeHtml(rule.type.toUpperCase())}</strong>
						<div class="muted">按顺序应用的批量改名规则</div>
					</div>
				</div>
				<div class="inline-actions">
					<label class="toggle-row muted"><input data-rule-field="enabled" type="checkbox" ${rule.enabled ? "checked" : ""} />启用</label>
					<button class="btn btn-danger btn-small" data-action="remove-rule" data-id="${escapeAttribute(rule.id)}">删除</button>
				</div>
			</div>
			<div class="input-grid two">
				<div class="field">
					<label>规则类型</label>
					<select data-rule-field="type">
						<option value="prefix" ${rule.type === "prefix" ? "selected" : ""}>prefix</option>
						<option value="suffix" ${rule.type === "suffix" ? "selected" : ""}>suffix</option>
						<option value="replace" ${rule.type === "replace" ? "selected" : ""}>replace</option>
						<option value="regex" ${rule.type === "regex" ? "selected" : ""}>regex</option>
					</select>
				</div>
				<div class="field">
					<label>执行顺序</label>
					<input data-rule-field="order" type="number" min="0" max="999" value="${Number(rule.order) || 0}" />
				</div>
				<div class="field">
					<label>match</label>
					<input data-rule-field="match" value="${escapeAttribute(rule.match || "")}" placeholder="例如 香港" />
				</div>
				<div class="field">
					<label>replace</label>
					<input data-rule-field="replace" value="${escapeAttribute(rule.replace || "")}" placeholder="例如 HK" />
				</div>
				<div class="field" style="grid-column: 1 / -1;">
					<label>value</label>
					<input data-rule-field="value" value="${escapeAttribute(rule.value || "")}" placeholder="prefix / suffix 规则会使用这个值" />
				</div>
			</div>
		</div>
	`;
}

function renderPreviewPanel() {
	return `
		<div class="stack">
			<div class="inline-actions">
				<span class="badge ok">成功源 ${state.preview.successfulSources}</span>
				<span class="badge ${state.preview.failedSources ? "fail" : "ok"}">失败源 ${state.preview.failedSources}</span>
				<span class="badge warn">节点 ${state.preview.nodeCount}</span>
			</div>
			<div class="section-list">
				${state.preview.sourceSummaries.map((item) => `
					<div class="item-card">
						<div class="item-card-header">
							<div>
								<strong>${escapeHtml(item.sourceName)}</strong>
								<div class="muted">${item.ok ? `已解析 ${item.nodeCount} 个节点` : escapeHtml(item.error || "拉取失败")}</div>
							</div>
							<span class="badge ${item.ok ? "ok" : "fail"}">${item.ok ? "成功" : "失败"}</span>
						</div>
					</div>
				`).join("")}
			</div>
			<div class="code-block">${escapeHtml(state.preview.rawText || "当前没有可输出的节点")}</div>
			<div style="overflow-x: auto;">
				<table class="preview-table">
					<thead>
						<tr>
							<th>来源</th>
							<th>协议</th>
							<th>原始名称</th>
							<th>最终名称</th>
							<th>单节点别名</th>
						</tr>
					</thead>
					<tbody>
						${state.preview.nodes.map((node) => `
							<tr data-node-fingerprint="${escapeAttribute(node.fingerprint)}">
								<td>${escapeHtml(node.sourceName)}</td>
								<td>${escapeHtml(node.protocol)}</td>
								<td>${escapeHtml(node.originalName)}</td>
								<td>${escapeHtml(node.finalName)}</td>
								<td>
									<div class="inline-actions">
										<input data-alias-input value="${escapeAttribute(node.alias || "")}" placeholder="自定义别名" />
										<button class="btn btn-secondary btn-small" data-action="save-alias" data-fingerprint="${escapeAttribute(node.fingerprint)}">保存</button>
									</div>
								</td>
							</tr>
						`).join("")}
					</tbody>
				</table>
			</div>
		</div>
	`;
}

async function submitAuth(form) {
	const formData = new FormData(form);
	const mode = form.dataset.mode || "login";
	const payload = {
		username: `${formData.get("username") || ""}`.trim(),
		password: `${formData.get("password") || ""}`,
	};

	if (mode === "register") {
		payload.email = `${formData.get("email") || ""}`.trim();
	}

	const response = await api(`/api/auth/${mode === "register" ? "register" : "login"}`, {
		method: "POST",
		body: JSON.stringify(payload),
	});

	state.user = response.user;
	state.config = response.config;
	state.preview = null;
	state.sourceChecks = {};
	pushNotice(mode === "register" ? "账号已创建，欢迎进入控制台" : "登录成功");
	render();
}

async function submitPasswordChange(form) {
	const formData = new FormData(form);
	await api("/api/auth/change-password", {
		method: "POST",
		body: JSON.stringify({
			currentPassword: `${formData.get("currentPassword") || ""}`,
			newPassword: `${formData.get("newPassword") || ""}`,
		}),
	});
	form.reset();
	pushNotice("密码已更新");
	render();
}

function syncDraftConfig() {
	if (!state.config) {
		return;
	}

	const sources = [...document.querySelectorAll("[data-source-id]")].map((card) => ({
		id: card.dataset.sourceId,
		name: card.querySelector('[data-source-field="name"]').value,
		url: card.querySelector('[data-source-field="url"]').value,
		enabled: card.querySelector('[data-source-field="enabled"]').checked,
		priority: Number(card.querySelector('[data-source-field="priority"]').value || 0),
		notes: card.querySelector('[data-source-field="notes"]').value,
	}));

	const renameRules = [...document.querySelectorAll("[data-rule-id]")].map((card) => ({
		id: card.dataset.ruleId,
		type: card.querySelector('[data-rule-field="type"]').value,
		enabled: card.querySelector('[data-rule-field="enabled"]').checked,
		match: card.querySelector('[data-rule-field="match"]').value,
		replace: card.querySelector('[data-rule-field="replace"]').value,
		value: card.querySelector('[data-rule-field="value"]').value,
		order: Number(card.querySelector('[data-rule-field="order"]').value || 0),
	}));

	state.config.sources = sources;
	state.config.renameRules = renameRules;
	state.config.settings = {
		dedupeEnabled: document.getElementById("setting-dedupe").checked,
		prefixSourceName: document.getElementById("setting-prefix-source").checked,
		sourcePrefixTemplate: document.getElementById("setting-prefix-template").value,
		keepUnnamed: document.getElementById("setting-keep-unnamed").checked,
		sortMode: document.getElementById("setting-sort-mode").value,
	};
}

async function saveConfig() {
	const response = await api("/api/config", {
		method: "PUT",
		body: JSON.stringify({
			settings: state.config.settings,
			sources: state.config.sources,
			renameRules: state.config.renameRules,
		}),
	});
	state.config = response;
	state.preview = null;
	pushNotice("配置已保存");
	render();
}

async function loadPreview() {
	const preview = await api("/api/preview");
	state.preview = preview;
	pushNotice(`预览完成，共生成 ${preview.nodeCount} 个节点`);
	render();
}

async function handleTestSource(sourceId) {
	const source = state.config.sources.find((item) => item.id === sourceId);
	if (!source) {
		return;
	}

	const result = await api("/api/test-source", {
		method: "POST",
		body: JSON.stringify(source),
	});

	state.sourceChecks[sourceId] = {
		nodeCount: result.nodeCount,
		error: null,
	};
	pushNotice(`单源测试成功，返回 ${result.nodeCount} 个节点`);
	render();
}

async function saveAlias(fingerprint) {
	const row = document.querySelector(`[data-node-fingerprint="${CSS.escape(fingerprint)}"]`);
	if (!row) {
		return;
	}

	const alias = row.querySelector("[data-alias-input]").value;
	await api("/api/rename-node", {
		method: "POST",
		body: JSON.stringify({ fingerprint, alias }),
	});
	pushNotice("节点别名已保存，预览已重新生成");
	await loadPreview();
}

function blankSource() {
	return {
		id: crypto.randomUUID(),
		name: "",
		url: "",
		enabled: true,
		priority: state.config ? state.config.sources.length : 0,
		notes: "",
	};
}

function blankRule(order) {
	return {
		id: crypto.randomUUID(),
		type: "replace",
		enabled: true,
		match: "",
		replace: "",
		value: "",
		order,
	};
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		credentials: "same-origin",
		headers: {
			"content-type": "application/json",
			...(options.headers || {}),
		},
		...options,
	});

	const contentType = response.headers.get("content-type") || "";
	const data = contentType.includes("application/json") ? await response.json() : await response.text();

	if (!response.ok) {
		const message =
			typeof data === "string"
				? data
				: data?.error?.message || data?.message || "请求失败";
		const error = new Error(message);
		error.status = response.status;
		throw error;
	}

	return data;
}

function pushNotice(message, isError = false, kindOverride = null) {
	const kind = kindOverride || (isError ? "error" : "success");
	const toast = {
		id: crypto.randomUUID(),
		message,
		kind,
	};

	state.notice = {
		message,
		isError,
	};
	state.toasts = [...state.toasts, toast].slice(-4);
	scheduleToastRemoval(toast.id, kind === "error" ? 5200 : 3200);
	render();
}

function renderNotice() {
	if (!state.notice) {
		return "";
	}
	return `<div class="notice ${state.notice.isError ? "error" : ""}">${escapeHtml(state.notice.message)}</div>`;
}

async function copyText(value, successMessage) {
	await navigator.clipboard.writeText(value);
	pushNotice(successMessage);
	render();
}

function renderToasts() {
	if (!state.toasts.length) {
		return "";
	}

	return `
		<div class="toast-viewport" aria-live="polite" aria-atomic="true">
			${state.toasts
				.map(
					(toast) => `
						<div class="toast toast-${toast.kind}">
							<div class="toast-mark">${getToastMark(toast.kind)}</div>
							<div class="toast-copy">
								<strong>${getToastTitle(toast.kind)}</strong>
								<div>${escapeHtml(toast.message)}</div>
							</div>
							<button class="toast-close" type="button" data-action="dismiss-toast" data-id="${toast.id}" aria-label="关闭提示">x</button>
						</div>
					`,
				)
				.join("")}
		</div>
	`;
}

function getToastTitle(kind) {
	if (kind === "error") {
		return "操作失败";
	}
	if (kind === "warn") {
		return "请注意";
	}
	return "操作成功";
}

function getToastMark(kind) {
	if (kind === "error") {
		return "!";
	}
	if (kind === "warn") {
		return "?";
	}
	return "OK";
}

function scheduleToastRemoval(id, delay) {
	if (toastTimers.has(id)) {
		clearTimeout(toastTimers.get(id));
	}

	const timer = setTimeout(() => {
		toastTimers.delete(id);
		removeToast(id);
	}, delay);
	toastTimers.set(id, timer);
}

function removeToast(id) {
	if (!id) {
		return;
	}

	if (toastTimers.has(id)) {
		clearTimeout(toastTimers.get(id));
		toastTimers.delete(id);
	}

	state.toasts = state.toasts.filter((toast) => toast.id !== id);
	render();
}

async function withBusy(button, pendingText, task) {
	if (!button) {
		return task();
	}

	const originalText = button.textContent;
	button.disabled = true;
	button.classList.add("is-busy");
	button.textContent = pendingText;

	try {
		return await task();
	} finally {
		button.disabled = false;
		button.classList.remove("is-busy");
		button.textContent = originalText;
	}
}

function escapeHtml(value) {
	return `${value ?? ""}`
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
	return escapeHtml(value).replace(/'/g, "&#39;");
}
