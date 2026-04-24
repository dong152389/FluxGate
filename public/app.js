import { actionRequiresConfiguredSession } from "./app-actions.js";
import { createAuthDraftState, mergeAuthDraft, readAuthDraft } from "./auth-draft.js";

const state = {
	user: null,
	config: null,
	preview: null,
	authMode: "login",
	activeView: "overview",
	notice: null,
	toasts: [],
	sourceChecks: {},
	loading: true,
	adminUsers: null,
	authDraft: createAuthDraftState(),
};

const app = document.getElementById("app");
const toastTimers = new Map();

boot();

async function boot() {
	render();
	try {
		const me = await api("/api/auth/me");
		state.user = me.user;
		if (state.user?.emailVerified || state.user?.isAdmin) {
			state.config = await api("/api/config");
		}
	} catch (error) {
		if (error.status !== 401 && error.status !== 403) {
			pushNotice(error.message || "初始化失败", true);
		}
	} finally {
		state.loading = false;
		render();
	}
}

async function loadAdminUsers() {
	try {
		const result = await api("/api/admin/users");
		state.adminUsers = result.users;
		render();
	} catch (error) {
		pushNotice(error.message || "加载用户列表失败", true);
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

		if (actionRequiresConfiguredSession(action) && (!state.user || !state.config)) {
			return;
		}

		syncDraftConfig();
		syncDraftPreview();

		if (action === "switch-view") {
			state.activeView = button.dataset.view || "overview";
			if (state.activeView === "admin") {
				loadAdminUsers();
			}
			render();
			return;
		}

		if (action === "send-code") {
			await withBusy(button, "发送中...", async () => {
				const form = button.closest("form");
				const emailInput = form?.querySelector('input[name="email"]');
				const email = emailInput?.value?.trim();
				if (!email) {
					pushNotice("请先填写邮箱", false, "warn");
					return;
				}
				await api("/api/auth/send-code", {
					method: "POST",
					body: JSON.stringify({ email, purpose: button.dataset.purpose || "register" }),
				});
				pushNotice("验证码已发送，请查收邮件");
				startCodeCountdown(button);
			});
			return;
		}

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
			const value = state.config.publicUrls?.v2ray || state.config.publicUrl;
			await copyText(value, "v2ray 订阅链接已复制");
			return;
		}

		if (action === "copy-clash-url") {
			const value = state.config.publicUrls?.clash || `${state.config.publicUrl}?format=clash`;
			await copyText(value, "Clash/Mihomo 订阅链接已复制");
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
				state.config.publicUrls = {
					...(state.config.publicUrls || {}),
					v2ray: result.publicUrl,
					clash: `${result.publicUrl}?format=clash`,
					raw: `${result.publicUrl}?raw=1`,
				};
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
				state.config.publicUrls = {
					...(state.config.publicUrls || {}),
					v2ray: result.publicUrl,
					clash: `${result.publicUrl}?format=clash`,
					raw: `${result.publicUrl}?raw=1`,
				};
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
				state.activeView = "overview";
				state.adminUsers = null;
				pushNotice("已退出登录");
				render();
			});
			return;
		}

		if (action === "toggle-user-status") {
			await withBusy(button, "更新中...", async () => {
				await api('/api/admin/users/' + button.dataset.id + '/status', {
					method: "POST",
					body: JSON.stringify({ status: button.dataset.status }),
				});
				await loadAdminUsers();
				pushNotice("用户状态已更新");
			});
			return;
		}

		if (action === "delete-user") {
			if (!confirm("确定要删除该用户吗？此操作不可恢复。")) {
				return;
			}
			await withBusy(button, "删除中...", async () => {
				await api('/api/admin/users/' + button.dataset.id, { method: "DELETE" });
				await loadAdminUsers();
				pushNotice("用户已删除");
			});
			return;
		}

		if (action === "save-alias") {
			await withBusy(button, "保存中...", async () => {
				await saveAlias(button.dataset.fingerprint);
			});
			return;
		}

		if (action === "save-all-aliases") {
			await withBusy(button, "保存中...", async () => {
				await saveAllAliases();
			});
			return;
		}

		if (action === "apply-batch") {
			applyBatchTransform();
			return;
		}

		if (action === "select-all-nodes") {
			if (state.preview?.nodes?.length) {
				state.preview.nodes.forEach((node) => {
					node._selected = true;
				});
				render();
			}
			return;
		}

		if (action === "clear-node-selection") {
			if (state.preview?.nodes?.length) {
				state.preview.nodes.forEach((node) => {
					node._selected = false;
				});
				render();
			}
			return;
		}

		if (action === "toggle-select-all-nodes") {
			if (state.preview?.nodes?.length) {
				const shouldSelect = button.checked;
				state.preview.nodes.forEach((node) => {
					node._selected = shouldSelect;
				});
				render();
			}
			return;
		}

		if (action === "unbind-email") {
			const form = button.closest('form[data-form="email"]');
			if (!form) {
				return;
			}
			const emailInput = form.querySelector('input[name="email"]');
			if (emailInput) {
				emailInput.value = "";
			}
			if (typeof form.requestSubmit === "function") {
				form.requestSubmit();
			} else {
				form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
			}
			return;
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
			return;
		}

		if (form.dataset.form === "email") {
			await withBusy(submitter, "保存中...", async () => {
				await submitEmailBinding(form);
			});
		}

		if (form.dataset.form === "email-verify") {
			await withBusy(submitter, "验证中...", async () => {
				await submitEmailBinding(form);
			});
		}
	} catch (error) {
		pushNotice(error.message || "提交失败", true);
		render();
	}
});

function render() {
	syncAuthDraft();

	if (state.loading) {
		app.innerHTML = renderLoading();
		return;
	}

	if (!state.user) {
		app.innerHTML = renderAuth();
		return;
	}

	if (!state.user.emailVerified && !state.user?.isAdmin) {
		app.innerHTML = renderVerifyEmailView();
		return;
	}

	if (!state.config) {
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
	const isRegister = state.authMode === "register";
	const authDraft = readAuthDraft(state.authDraft, state.authMode);
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
						<button class="tab ${!isRegister ? "active" : ""}" data-action="switch-auth" data-mode="login">登录</button>
						<button class="tab ${isRegister ? "active" : ""}" data-action="switch-auth" data-mode="register">注册</button>
					</div>
					<form data-form="auth" data-mode="${state.authMode}" class="stack">
						${isRegister
							? `<div class="field">
									<label for="auth-username">用户名</label>
									<input id="auth-username" name="username" value="${escapeAttribute(authDraft.username || "")}" placeholder="3-32 位字母/数字/._-" autocomplete="username" required />
								</div>
								<div class="field">
									<label for="auth-email">邮箱</label>
									<input id="auth-email" name="email" type="email" value="${escapeAttribute(authDraft.email || "")}" placeholder="请输入邮箱" autocomplete="email" required />
								</div>
								<div class="field">
									<label for="auth-code">验证码</label>
									<div class="inline-actions">
										<input id="auth-code" name="code" value="${escapeAttribute(authDraft.code || "")}" placeholder="6 位数字" autocomplete="off" required style="flex:1" />
										<button class="btn btn-secondary btn-small" type="button" data-action="send-code" data-purpose="register">获取验证码</button>
									</div>
								</div>`
							: `<div class="field">
									<label for="auth-identifier">账号</label>
									<input id="auth-identifier" name="identifier" value="${escapeAttribute(authDraft.identifier || "")}" placeholder="用户名或邮箱" autocomplete="username" required />
								</div>`}
						<div class="field">
							<label for="auth-password">密码</label>
							<input id="auth-password" name="password" type="password" value="${escapeAttribute(authDraft.password || "")}" placeholder="请输入密码" autocomplete="${isRegister ? "new-password" : "current-password"}" required />
						</div>
						<button class="btn btn-primary" type="submit">${isRegister ? "创建账号并进入控制台" : "登录控制台"}</button>
					</form>
					<p class="footer-note">用户名或邮箱均可登录，公开订阅链接与登录态分离。</p>
				</section>
			</div>
		</div>
		${renderToasts()}
	`;
}

function renderVerifyEmailView() {
	return `
		<div class="auth-wrap">
			<div class="auth-card">
				<section class="auth-hero">
					<div class="eyebrow">安全验证</div>
					<h1>验证邮箱</h1>
					<p>为了保障账号安全，请先验证邮箱地址。</p>
					<ul>
						<li>验证后可使用全部功能</li>
						<li>可用邮箱登录和找回密码</li>
						<li>接收重要安全通知</li>
					</ul>
				</section>
				<section class="auth-panel">
					<h2>绑定邮箱</h2>
					<form data-form="email-verify" class="stack">
						<div class="field">
							<label for="verify-email">邮箱</label>
							<input id="verify-email" name="email" type="email" placeholder="name@example.com" autocomplete="email" required />
						</div>
						<div class="field">
							<label for="verify-code">验证码</label>
							<div class="inline-actions">
								<input id="verify-code" name="code" placeholder="6 位数字" autocomplete="off" required style="flex:1" />
								<button class="btn btn-secondary btn-small" type="button" data-action="send-code" data-purpose="bind">获取验证码</button>
							</div>
						</div>
						<div class="field">
							<label for="verify-password">当前密码</label>
							<input id="verify-password" name="currentPassword" type="password" placeholder="验证身份" autocomplete="current-password" required />
						</div>
						<button class="btn btn-primary" type="submit">验证并进入</button>
					</form>
					<p class="footer-note">验证完成后即可使用全部功能。</p>
				</section>
			</div>
		</div>
		${renderToasts()}
	`;
}

const NAV_ITEMS = [
	{ id: "overview", label: "概览", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><rect x="2" y="2" width="5.5" height="5.5" rx="1.2"/><rect x="8.5" y="2" width="5.5" height="5.5" rx="1.2"/><rect x="2" y="8.5" width="5.5" height="5.5" rx="1.2"/><rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.2"/></svg>` },
	{ id: "sources", label: "订阅源", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/><path d="M4 4.5a5 5 0 0 0 0 7M12 4.5a5 5 0 0 1 0 7"/><path d="M2 2.5a8 8 0 0 0 0 11M14 2.5a8 8 0 0 1 0 11"/></svg>` },
	{ id: "rules", label: "聚合规则", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="6" cy="4" r="1.4" fill="currentColor"/><circle cx="11" cy="8" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/></svg>` },
	{ id: "preview", label: "节点预览", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><path d="M1.5 8C4 3.5 12 3.5 14.5 8c-2.5 4.5-10.5 4.5-13 0z"/><circle cx="8" cy="8" r="2"/></svg>` },
	{ id: "account", label: "账号安全", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c0-3.5 10-3.5 10 0"/></svg>` },
];

function renderDashboard() {
	const view = state.activeView || "overview";
	return `
		<div class="app-dashboard">
			${renderSidebar(view)}
			<main class="workspace">
				${renderWorkspace(view)}
			</main>
		</div>
		${renderToasts()}
	`;
}

function getNavItems() {
	const items = [...NAV_ITEMS];
	if (state.user?.isAdmin) {
		items.push({
			id: "admin",
			label: "用户管理",
			icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" width="16" height="16"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c0-3.5 10-3.5 10 0"/></svg>`,
		});
	}
	return items;
}

function renderSidebar(activeView) {
	const username = state.user?.username || "";
	const initial = username.slice(0, 1).toUpperCase() || "U";
	return `
		<aside class="sidebar">
			<div class="sidebar-brand">
				<span class="brand-mark">Fx</span>
				<div class="brand-meta">
					<strong>FluxGate</strong>
					<small>订阅聚合控制台</small>
				</div>
			</div>
			<nav class="sidebar-nav">
				${getNavItems().map((item) => `
					<button class="nav-item ${item.id === activeView ? "active" : ""}" data-action="switch-view" data-view="${item.id}">
						<span class="nav-icon">${item.icon}</span>
						<span>${item.label}</span>
					</button>
				`).join("")}
			</nav>
			<div class="sidebar-footer">
				<div class="user-chip">
					<span class="avatar">${escapeHtml(initial)}</span>
					<div class="user-meta">
						<strong>${escapeHtml(username)}</strong>
						<small>已登录</small>
					</div>
				</div>
				<button class="btn btn-secondary btn-small btn-block" data-action="logout">退出登录</button>
			</div>
		</aside>
	`;
}

function renderWorkspace(view) {
	if (view === "sources") return renderSourcesView();
	if (view === "rules") return renderRulesView();
	if (view === "preview") return renderPreviewView();
	if (view === "account") return renderAccountView();
	if (view === "admin") return renderAdminView();
	return renderOverview();
}

function renderWorkspaceHead(breadcrumb, title, description, actions = "") {
	return `
		<header class="workspace-head">
			<div class="workspace-head-text">
				<span class="breadcrumb">${escapeHtml(breadcrumb)}</span>
				<h1>${escapeHtml(title)}</h1>
				${description ? `<p class="muted">${escapeHtml(description)}</p>` : ""}
			</div>
			${actions ? `<div class="head-actions">${actions}</div>` : ""}
		</header>
	`;
}

function renderOverview() {
	const sourceCount = state.config.sources.length;
	const ruleCount = state.config.renameRules.length;
	const previewCount = state.preview?.nodeCount ?? 0;
	const username = state.user?.username || "";
	const publicUrls = resolvePublicUrls(state.config);
	return `
		${renderWorkspaceHead("FluxGate · 概览", "聚合控制台", "把多个上游订阅整合成稳定可控的单一入口")}
		<div class="workspace-body">
			<section class="hello-card">
				<div>
					<span class="eyebrow-dim">你好, ${escapeHtml(username)}</span>
					<h2>管理订阅源、规则与公开拉取 token</h2>
					<p class="muted">推荐流程：保存配置 → 预览节点 → 给客户端使用公开链接</p>
				</div>
				<div class="hello-badge">
					<span class="badge ok">用户隔离已开启</span>
				</div>
			</section>
			<div class="metrics-row">
				<div class="metric-card">
					<small>订阅源</small>
					<strong>${sourceCount}</strong>
					<span class="muted">当前配置的上游</span>
				</div>
				<div class="metric-card">
					<small>改名规则</small>
					<strong>${ruleCount}</strong>
					<span class="muted">按顺序应用</span>
				</div>
				<div class="metric-card">
					<small>预览节点</small>
					<strong>${previewCount}</strong>
					<span class="muted">最新一次聚合</span>
				</div>
			</div>
			<section class="card">
				<div class="card-head">
					<h3>公开订阅</h3>
					<p>客户端填这个链接即可拉取聚合结果</p>
				</div>
				<div class="field">
					<label for="public-url">v2ray 订阅链接</label>
					<input id="public-url" value="${escapeAttribute(publicUrls.v2ray)}" readonly />
				</div>
				<div class="field">
					<label for="public-url-clash">Clash / Mihomo 订阅链接</label>
					<input id="public-url-clash" value="${escapeAttribute(publicUrls.clash)}" readonly />
				</div>
				<div class="toolbar">
					<button class="btn btn-primary btn-small" data-action="copy-public-url">复制 v2ray 链接</button>
					<button class="btn btn-secondary btn-small" data-action="copy-clash-url">复制 Clash 链接</button>
					<button class="btn btn-secondary btn-small" data-action="reset-token">重置 token</button>
					<button class="btn btn-ghost btn-small" data-action="refresh-cache">刷新缓存</button>
				</div>
				<p class="footer-note">重置 token 后，旧链接会立即失效。</p>
			</section>
		</div>
	`;
}

function renderSourcesView() {
	const actions = `
		<button class="btn btn-secondary btn-small" data-action="add-source">新增订阅源</button>
		<button class="btn btn-primary btn-small" data-action="save-config">保存配置</button>
	`;
	return `
		${renderWorkspaceHead("FluxGate · 订阅源", "订阅源管理", "添加多个上游链接，控制优先级、启用状态和单源测试", actions)}
		<div class="workspace-body">
			<section class="card">
				<div class="section-list" data-editor="sources">
					${state.config.sources.length ? state.config.sources.map(renderSourceCard).join("") : `
						<div class="empty-state">
							还没有订阅源。先添加一个 https:// 开头的订阅地址。
						</div>
					`}
				</div>
			</section>
		</div>
	`;
}

function renderRulesView() {
	const actions = `
		<button class="btn btn-secondary btn-small" data-action="add-rule">新增规则</button>
		<button class="btn btn-primary btn-small" data-action="save-config">保存配置</button>
	`;
	return `
		${renderWorkspaceHead("FluxGate · 规则", "聚合规则", "去重策略、来源前缀、排序与批量改名", actions)}
		<div class="workspace-body">
			<section class="card" data-editor="settings">
				<div class="card-head">
					<h3>全局设置</h3>
					<p>控制去重、来源前缀、无名节点保留方式和排序策略</p>
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
			<section class="card">
				<div class="card-head">
					<h3>批量改名规则</h3>
					<p>按顺序应用前缀、后缀、替换或正则替换</p>
				</div>
				<div class="section-list" data-editor="rules">
					${state.config.renameRules.length ? state.config.renameRules.map(renderRuleCard).join("") : `
						<div class="empty-state">
							还没有规则。你可以只用来源前缀，也可以添加批量替换。
						</div>
					`}
				</div>
			</section>
		</div>
	`;
}

function renderPreviewView() {
	const actions = `
		<button class="btn btn-primary btn-small" data-action="preview">生成预览</button>
		<button class="btn btn-secondary btn-small" data-action="copy-raw-output">复制明文</button>
		<button class="btn btn-ghost btn-small" data-action="copy-b64-output">复制 Base64</button>
	`;
	return `
		${renderWorkspaceHead("FluxGate · 预览", "节点预览", "预览聚合效果，并对单个节点持久化别名", actions)}
		<div class="workspace-body">
			${state.preview ? `<section class="card">${renderPreviewPanel()}</section>` : `<div class="empty-state">预览尚未生成。建议在保存配置后执行一次预览。</div>`}
		</div>
	`;
}

function renderAccountView() {
	const boundEmail = state.user?.email || "";
	const publicUrls = resolvePublicUrls(state.config);
	return `
		${renderWorkspaceHead("FluxGate · 账号", "账号安全", "修改密码、绑定邮箱并管理公开订阅入口")}
		<div class="workspace-body">
			<section class="card">
				<div class="card-head">
					<h3>邮箱登录</h3>
					<p>${boundEmail ? `当前已绑定：<strong>${escapeHtml(boundEmail)}</strong>` : "尚未绑定邮箱，绑定后可用邮箱登录"}</p>
				</div>
				<form data-form="email" class="stack">
					<div class="field">
						<label for="bind-email">邮箱</label>
						<input id="bind-email" name="email" type="email" autocomplete="email" placeholder="name@example.com" value="${escapeAttribute(boundEmail)}" />
					</div>
					<div class="field">
						<label for="bind-email-password">当前密码</label>
						<input id="bind-email-password" name="currentPassword" type="password" autocomplete="current-password" placeholder="验证身份所用" required />
					</div>
					<div class="toolbar">
						<button class="btn btn-primary btn-small" type="submit">${boundEmail ? "更新邮箱" : "绑定邮箱"}</button>
						${boundEmail ? `<button class="btn btn-ghost btn-small" type="button" data-action="unbind-email">解除绑定</button>` : ""}
					</div>
					<p class="footer-note">留空并点击更新可清除绑定。</p>
				</form>
			</section>
			<section class="card">
				<div class="card-head">
					<h3>修改密码</h3>
					<p>使用新密码登录，请妥善保管</p>
				</div>
				<form data-form="password" class="stack">
					<div class="field">
						<label for="current-password">当前密码</label>
						<input id="current-password" name="currentPassword" type="password" autocomplete="current-password" placeholder="请输入当前密码" required />
					</div>
					<div class="field">
						<label for="new-password">新密码</label>
						<input id="new-password" name="newPassword" type="password" autocomplete="new-password" placeholder="请输入新密码" required />
					</div>
					<div class="toolbar">
						<button class="btn btn-primary btn-small" type="submit">更新密码</button>
						<button class="btn btn-danger btn-small" type="button" data-action="logout">退出登录</button>
					</div>
				</form>
			</section>
			<section class="card">
				<div class="card-head">
					<h3>公开订阅 token</h3>
					<p>重置或刷新公开订阅缓存，旧链接会立即失效</p>
				</div>
				<div class="field">
					<label for="account-public-url">当前 v2ray 订阅链接</label>
					<input id="account-public-url" value="${escapeAttribute(publicUrls.v2ray)}" readonly />
				</div>
				<div class="field">
					<label for="account-public-url-clash">当前 Clash / Mihomo 订阅链接</label>
					<input id="account-public-url-clash" value="${escapeAttribute(publicUrls.clash)}" readonly />
				</div>
				<div class="toolbar">
					<button class="btn btn-secondary btn-small" data-action="copy-public-url">复制 v2ray 链接</button>
					<button class="btn btn-secondary btn-small" data-action="copy-clash-url">复制 Clash 链接</button>
					<button class="btn btn-secondary btn-small" data-action="reset-token">重置 token</button>
					<button class="btn btn-ghost btn-small" data-action="refresh-cache">刷新缓存</button>
				</div>
			</section>
		</div>
	`;
}

function renderAdminView() {
	const users = state.adminUsers || [];
	return `
		${renderWorkspaceHead("FluxGate · 用户管理", "用户管理", "查看和管理系统注册用户")}
		<div class="workspace-body">
			<section class="card">
				<div class="card-head">
					<h3>用户列表</h3>
					<p>共 ${users.length} 位注册用户</p>
				</div>
				<div style="overflow-x: auto;">
					<table class="preview-table">
						<thead>
							<tr>
								<th>ID</th>
								<th>用户名</th>
								<th>邮箱</th>
								<th>角色</th>
								<th>状态</th>
								<th>注册时间</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody>
							${users.map((user) => `
								<tr>
									<td>${escapeHtml(user.id)}</td>
									<td>${escapeHtml(user.username)}</td>
									<td>${escapeHtml(user.email || "—")}</td>
									<td><span class="badge ${user.isAdmin ? "warn" : "ok"}">${user.isAdmin ? "管理员" : "普通用户"}</span></td>
									<td><span class="badge ${user.status === "active" ? "ok" : "fail"}">${user.status === "active" ? "正常" : "已禁用"}</span></td>
									<td>${escapeHtml(new Date(user.created_at).toLocaleString("zh-CN"))}</td>
									<td>
										${user.isAdmin
											? `<span class="muted">—</span>`
											: `<div class="inline-actions">
												${user.status === "active"
													? `<button class="btn btn-ghost btn-small" data-action="toggle-user-status" data-id="${escapeAttribute(user.id)}" data-status="disabled">禁用</button>`
													: `<button class="btn btn-secondary btn-small" data-action="toggle-user-status" data-id="${escapeAttribute(user.id)}" data-status="active">启用</button>`
												}
												<button class="btn btn-danger btn-small" data-action="delete-user" data-id="${escapeAttribute(user.id)}">删除</button>
											</div>`
										}
									</td>
								</tr>
							`).join("")}
							${users.length === 0 ? `<tr><td colspan="7" style="text-align:center;color:var(--muted)">暂无用户</td></tr>` : ""}
						</tbody>
					</table>
				</div>
			</section>
		</div>
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
					<label>V2Ray 订阅链接</label>
					<input
						data-source-field="v2rayUrl"
						value="${escapeAttribute(source.v2rayUrl || "")}"
						placeholder="https://example.com/v2ray-sub"
					/>
				</div>
				<div class="field">
					<label>Clash / Mihomo 链接</label>
					<input
						data-source-field="clashUrl"
						value="${escapeAttribute(source.clashUrl || "")}"
						placeholder="https://example.com/clash-sub"
					/>
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
	const batch = state.previewBatch || { type: "prefix", match: "", value: "" };
	const total = state.preview.nodes.length;
	const selectedCount = state.preview.nodes.filter((node) => node._selected).length;
	const allSelected = total > 0 && selectedCount === total;
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
			<div class="preview-batch-toolbar" data-editor="preview-batch">
				<div class="preview-batch-info">
					<strong>已选 ${selectedCount}</strong>
					<span class="muted">/ ${total}</span>
				</div>
				<div class="field">
					<label>操作</label>
					<select data-preview-batch-type>
						<option value="prefix" ${batch.type === "prefix" ? "selected" : ""}>加前缀</option>
						<option value="suffix" ${batch.type === "suffix" ? "selected" : ""}>加后缀</option>
						<option value="replace" ${batch.type === "replace" ? "selected" : ""}>查找替换</option>
						<option value="clear" ${batch.type === "clear" ? "selected" : ""}>清空</option>
					</select>
				</div>
				<div class="field" data-size="sm">
					<label>查找</label>
					<input data-preview-batch-match value="${escapeAttribute(batch.match || "")}" placeholder="仅替换用" />
				</div>
				<div class="field">
					<label>值</label>
					<input data-preview-batch-value value="${escapeAttribute(batch.value || "")}" placeholder="前缀 / 后缀 / 替换文本" />
				</div>
				<div class="inline-actions preview-batch-actions">
					<button class="btn btn-ghost btn-small" data-action="select-all-nodes">全选</button>
					<button class="btn btn-ghost btn-small" data-action="clear-node-selection">清空</button>
					<button class="btn btn-secondary btn-small" data-action="apply-batch">应用</button>
					<button class="btn btn-primary btn-small" data-action="save-all-aliases">批量保存</button>
				</div>
			</div>
			<div style="overflow-x: auto;">
				<table class="preview-table">
					<thead>
						<tr>
							<th><input type="checkbox" data-action="toggle-select-all-nodes" ${allSelected ? "checked" : ""} aria-label="全选" /></th>
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
								<td><input type="checkbox" data-preview-select ${node._selected ? "checked" : ""} aria-label="选择 ${escapeAttribute(node.finalName)}" /></td>
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
	const password = `${formData.get("password") || ""}`;

	const payload = mode === "register"
		? {
			username: `${formData.get("username") || ""}`.trim(),
			email: `${formData.get("email") || ""}`.trim(),
			password,
			code: `${formData.get("code") || ""}`.trim(),
		}
		: {
			identifier: `${formData.get("identifier") || ""}`.trim(),
			password,
		};

	const response = await api(`/api/auth/${mode === "register" ? "register" : "login"}`, {
		method: "POST",
		body: JSON.stringify(payload),
	});

	const responseUser = response.user || {};
	const configUser = response.config?.user || {};
	state.user = {
		...configUser,
		...responseUser,
		isAdmin: responseUser.isAdmin ?? configUser.isAdmin ?? false,
	};
	state.config = response.config;
	if (state.config && !state.config.publicUrls) {
		state.config.publicUrls = resolvePublicUrls(state.config);
	}
	state.preview = null;
	state.sourceChecks = {};
	state.authDraft = createAuthDraftState();
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

async function submitEmailBinding(form) {
	const formData = new FormData(form);
	const email = `${formData.get("email") || ""}`.trim();
	const currentPassword = `${formData.get("currentPassword") || ""}`;
	const code = `${formData.get("code") || ""}`.trim();

	const response = await api("/api/auth/email", {
		method: "POST",
		body: JSON.stringify({ email, currentPassword, code }),
	});

	if (state.user) {
		state.user.email = response.user?.email ?? null;
		state.user.emailVerified = response.user?.emailVerified ?? false;
	}
	form.reset();
	pushNotice(email ? "邮箱已绑定" : "邮箱已解除绑定");
	render();
}

function syncDraftConfig() {
	if (!state.config) {
		return;
	}

	const sourcesEditor = document.querySelector('[data-editor="sources"]');
	if (sourcesEditor) {
		state.config.sources = [...sourcesEditor.querySelectorAll("[data-source-id]")].map((card) => ({
			id: card.dataset.sourceId,
			name: card.querySelector('[data-source-field="name"]').value,
			v2rayUrl: card.querySelector('[data-source-field="v2rayUrl"]').value,
			clashUrl: card.querySelector('[data-source-field="clashUrl"]').value,
			enabled: card.querySelector('[data-source-field="enabled"]').checked,
			priority: Number(card.querySelector('[data-source-field="priority"]').value || 0),
			notes: card.querySelector('[data-source-field="notes"]').value,
		}));
	}

	const rulesEditor = document.querySelector('[data-editor="rules"]');
	if (rulesEditor) {
		state.config.renameRules = [...rulesEditor.querySelectorAll("[data-rule-id]")].map((card) => ({
			id: card.dataset.ruleId,
			type: card.querySelector('[data-rule-field="type"]').value,
			enabled: card.querySelector('[data-rule-field="enabled"]').checked,
			match: card.querySelector('[data-rule-field="match"]').value,
			replace: card.querySelector('[data-rule-field="replace"]').value,
			value: card.querySelector('[data-rule-field="value"]').value,
			order: Number(card.querySelector('[data-rule-field="order"]').value || 0),
		}));
	}

	const settingsEditor = document.querySelector('[data-editor="settings"]');
	if (settingsEditor) {
		state.config.settings = {
			dedupeEnabled: document.getElementById("setting-dedupe").checked,
			prefixSourceName: document.getElementById("setting-prefix-source").checked,
			sourcePrefixTemplate: document.getElementById("setting-prefix-template").value,
			keepUnnamed: document.getElementById("setting-keep-unnamed").checked,
			sortMode: document.getElementById("setting-sort-mode").value,
		};
	}
}

function syncAuthDraft() {
	const form = app.querySelector('form[data-form="auth"]');
	if (!form) {
		return;
	}

	const mode = form.dataset.mode || "login";
	const formData = new FormData(form);
	if (mode === "register") {
		state.authDraft = mergeAuthDraft(state.authDraft, "register", {
			username: `${formData.get("username") || ""}`.trim(),
			email: `${formData.get("email") || ""}`.trim(),
			code: `${formData.get("code") || ""}`.trim(),
			password: `${formData.get("password") || ""}`,
		});
		return;
	}

	state.authDraft = mergeAuthDraft(state.authDraft, "login", {
		identifier: `${formData.get("identifier") || ""}`.trim(),
		password: `${formData.get("password") || ""}`,
	});
}

function syncDraftPreview() {
	if (!state.preview || !Array.isArray(state.preview.nodes)) {
		return;
	}

	const byFingerprint = new Map(state.preview.nodes.map((node) => [node.fingerprint, node]));
	document.querySelectorAll("[data-node-fingerprint]").forEach((row) => {
		const fingerprint = row.getAttribute("data-node-fingerprint");
		const node = byFingerprint.get(fingerprint);
		if (!node) {
			return;
		}
		const aliasInput = row.querySelector("[data-alias-input]");
		if (aliasInput) {
			node.alias = aliasInput.value;
		}
		const checkbox = row.querySelector("[data-preview-select]");
		if (checkbox) {
			node._selected = checkbox.checked;
		}
	});

	const toolbar = document.querySelector('[data-editor="preview-batch"]');
	if (toolbar) {
		const typeSelect = toolbar.querySelector("[data-preview-batch-type]");
		const matchInput = toolbar.querySelector("[data-preview-batch-match]");
		const valueInput = toolbar.querySelector("[data-preview-batch-value]");
		state.previewBatch = {
			type: typeSelect?.value || "prefix",
			match: matchInput?.value || "",
			value: valueInput?.value || "",
		};
	}
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
	if (state.config && !state.config.publicUrls) {
		state.config.publicUrls = resolvePublicUrls(state.config);
	}
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

	const rawAlias = row.querySelector("[data-alias-input]").value;
	const alias = rawAlias.trim();
	await api("/api/rename-node", {
		method: "POST",
		body: JSON.stringify({ fingerprint, alias }),
	});

	const node = state.preview?.nodes.find((item) => item.fingerprint === fingerprint);
	if (node) {
		node.alias = alias;
		if (alias) {
			node.finalName = alias;
		}
	}
	pushNotice("节点别名已保存");
}

async function saveAllAliases() {
	if (!state.preview || !state.preview.nodes.length) {
		pushNotice("当前没有可保存的节点", false, "warn");
		return;
	}

	const updates = state.preview.nodes.map((node) => ({
		fingerprint: node.fingerprint,
		alias: (node.alias ?? "").trim(),
	}));

	const result = await api("/api/rename-nodes", {
		method: "POST",
		body: JSON.stringify({ updates }),
	});

	state.preview.nodes.forEach((node) => {
		const trimmed = (node.alias ?? "").trim();
		node.alias = trimmed;
		if (trimmed) {
			node.finalName = trimmed;
		}
	});

	pushNotice(`已批量保存 ${result?.count ?? updates.length} 个节点别名`);
}

function applyBatchTransform() {
	if (!state.preview || !state.preview.nodes.length) {
		pushNotice("请先生成预览", false, "warn");
		return;
	}

	const batch = state.previewBatch || { type: "prefix", match: "", value: "" };
	const targets = state.preview.nodes.filter((node) => node._selected);
	if (!targets.length) {
		pushNotice("请先勾选至少一个节点", false, "warn");
		return;
	}

	if (batch.type === "replace" && !batch.match) {
		pushNotice("查找替换需要填写查找内容", false, "warn");
		return;
	}

	let mutated = 0;
	targets.forEach((node) => {
		const current = (node.alias ?? "");
		const base = current || node.finalName || "";
		let next = current;

		if (batch.type === "prefix") {
			next = (batch.value || "") + base;
		} else if (batch.type === "suffix") {
			next = base + (batch.value || "");
		} else if (batch.type === "replace") {
			next = base.split(batch.match).join(batch.value || "");
		} else if (batch.type === "clear") {
			next = "";
		}

		if (next !== current) {
			node.alias = next;
			mutated += 1;
		}
	});

	if (mutated) {
		pushNotice(`已更新 ${mutated} 个节点别名（待保存）`);
	} else {
		pushNotice("没有节点发生变化", false, "warn");
	}
}

function blankSource() {
	return {
		id: crypto.randomUUID(),
		name: "",
		v2rayUrl: "",
		clashUrl: "",
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

function startCodeCountdown(button) {
	let seconds = 60;
	button.disabled = true;
	button.textContent = `${seconds}s`;
	const timer = setInterval(() => {
		seconds -= 1;
		if (seconds <= 0) {
			clearInterval(timer);
			button.disabled = false;
			button.textContent = "获取验证码";
		} else {
			button.textContent = `${seconds}s`;
		}
	}, 1000);
}

function resolvePublicUrls(config) {
	const base = config?.publicUrl || "";
	const urls = config?.publicUrls || {};
	return {
		v2ray: urls.v2ray || base,
		clash: urls.clash || (base ? `${base}?format=clash` : ""),
		raw: urls.raw || (base ? `${base}?raw=1` : ""),
	};
}
