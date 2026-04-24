import { describe, expect, it } from "vitest";
import { actionRequiresConfiguredSession } from "../public/app-actions.js";

describe("app action guards", () => {
	it("allows auth-side actions before login and protects dashboard-only actions", () => {
		expect(actionRequiresConfiguredSession("switch-auth")).toBe(false);
		expect(actionRequiresConfiguredSession("send-code")).toBe(false);
		expect(actionRequiresConfiguredSession("switch-view")).toBe(true);
		expect(actionRequiresConfiguredSession("add-source")).toBe(true);
	});
});
