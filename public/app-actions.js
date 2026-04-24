const SESSION_OPTIONAL_ACTIONS = new Set(["dismiss-toast", "switch-auth", "send-code"]);

export function actionRequiresConfiguredSession(action) {
	return !SESSION_OPTIONAL_ACTIONS.has(action || "");
}
