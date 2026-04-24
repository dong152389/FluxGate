const EMPTY_AUTH_DRAFT = Object.freeze({
	login: {
		identifier: "",
		password: "",
	},
	register: {
		username: "",
		email: "",
		code: "",
		password: "",
	},
});

export function createAuthDraftState() {
	return {
		login: { ...EMPTY_AUTH_DRAFT.login },
		register: { ...EMPTY_AUTH_DRAFT.register },
	};
}

export function readAuthDraft(state, mode) {
	const normalizedMode = mode === "register" ? "register" : "login";
	return {
		...EMPTY_AUTH_DRAFT[normalizedMode],
		...(state?.[normalizedMode] || {}),
	};
}

export function mergeAuthDraft(state, mode, patch) {
	const normalizedMode = mode === "register" ? "register" : "login";
	return {
		...state,
		[normalizedMode]: {
			...readAuthDraft(state, normalizedMode),
			...(patch || {}),
		},
	};
}
