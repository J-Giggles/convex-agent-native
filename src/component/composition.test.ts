import { describe, expect, it, vi } from "vitest";

import schema from "./schema.js";

vi.mock("@convex-dev/agent/convex.config", () => ({
	default: {
		componentDefinitionPath: "components/agent",
		defaultName: "agent",
	},
}));

describe("official Convex Agent composition", () => {
	it("CVA-N01 registers the official Agent component as a child", async () => {
		const { default: component } = await import("./convex.config.js");
		const analysis = (
			component as unknown as {
				export(): {
					childComponents: Array<{ name: string; path: string }>;
					envVars?: Array<[string, { optional?: boolean }]>;
				};
			}
		).export();

		expect(analysis.childComponents).toEqual([
			expect.objectContaining({ name: "agent", path: "components/agent" }),
		]);
	});

	it("CVA-F01 requires an explicit host-derived scope policy at setup", async () => {
		const { default: component } = await import("./convex.config.js");
		const analysis = (
			component as unknown as {
				export(): { envVars?: Array<[string, { optional?: boolean }]> };
			}
		).export();
		expect(analysis.envVars).toEqual([
			["HOST_SCOPE_POLICY", expect.not.objectContaining({ optional: true })],
		]);
	});

	it("CVA-I01 does not duplicate Agent thread or message tables", () => {
		const tableNames = Object.keys(schema.tables);
		expect(tableNames).toEqual([
			"invocations",
			"invocationAuditEvents",
			"extensions",
			"extensionRevisions",
			"extensionConsents",
			"extensionData",
		]);
		expect(tableNames).not.toEqual(
			expect.arrayContaining([
				"threads",
				"messages",
				"streamingMessages",
				"streamDeltas",
				"memories",
				"files",
			]),
		);
	});
});
