import { describe, expect, it } from "vitest";
import { createAuthDraftState, mergeAuthDraft, readAuthDraft } from "../public/auth-draft.js";

describe("auth draft state", () => {
	it("preserves independent login and register field values across re-renders", () => {
		let draft = createAuthDraftState();

		draft = mergeAuthDraft(draft, "register", {
			username: "alice",
			email: "alice@example.com",
			password: "secret",
			code: "123456",
		});
		draft = mergeAuthDraft(draft, "login", {
			identifier: "alice",
			password: "login-pass",
		});

		expect(readAuthDraft(draft, "register")).toEqual({
			username: "alice",
			email: "alice@example.com",
			password: "secret",
			code: "123456",
		});
		expect(readAuthDraft(draft, "login")).toEqual({
			identifier: "alice",
			password: "login-pass",
		});
	});
});
