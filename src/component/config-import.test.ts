import { describe, expect, it } from "vitest";

describe("component config package import", () => {
	it("is side-effect safe under ordinary Node ESM import", async () => {
		const { default: component } = await import("./convex.config.js");
		const analysis = (
			component as unknown as {
				export(): {
					childComponents: Array<{ name: string; path: string }>;
					envVars?: Array<[string, { optional?: boolean }]>;
				};
			}
		).export();

		// The ordinary Node import has no Convex analysis transform, so the
		// unanalysed dependency is intentionally not registered.
		expect(analysis.childComponents).toEqual([]);
		expect(analysis.envVars).toEqual([
			["HOST_SCOPE_POLICY", expect.not.objectContaining({ optional: true })],
		]);
	});
});
