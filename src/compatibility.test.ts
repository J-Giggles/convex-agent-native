import { describe, expect, it } from "vitest";

import { AGENT_NATIVE_CONVEX_COMPATIBILITY, assertCompatibilitySurface } from "./compatibility.js";
import * as clientApi from "./client/index.js";
import * as convexApi from "./convex/index.js";
import * as drizzleApi from "./drizzle/index.js";
import * as publicApi from "./index.js";

describe("versioned compatibility contract", () => {
	it("CT-N01 imports every promised public symbol group", () => {
		for (const symbol of [
			"ActionRegistry",
			"executeRegisteredAction",
			"createA2AProtocolAdapter",
			"ConvexActionCliAdapter",
			"handleMcpRequest",
		]) {
			expect(publicApi).toHaveProperty(symbol);
		}
		expect(clientApi).toHaveProperty("createActionClient");
		expect(convexApi).toHaveProperty("createConvexInvocationPersistence");
		expect(drizzleApi).toHaveProperty("createDrizzleInvocationPersistence");
	});

	it("CT-F01 rejects a surface outside the versioned claim", () => {
		expect(() => assertCompatibilitySurface("db-exec")).toThrow(
			/Unsupported Agent-Native compatibility surface/u,
		);
		expect(AGENT_NATIVE_CONVEX_COMPATIBILITY.excluded).toContain("sql-emulation");
	});

	it("CT-I01 pins the reviewed upstream package versions and commits", () => {
		expect(AGENT_NATIVE_CONVEX_COMPATIBILITY).toMatchObject({
			specificationVersion: "0.2.0-draft.1",
			agentNative: {
				package: "@agent-native/core",
				version: "0.189.0",
				commit: "089a5a96f4a882c0fc9e5d4abca8f8fc32f7ef85",
			},
			convexAgent: {
				package: "@convex-dev/agent",
				version: "0.6.4",
				commit: "0aba1879f905d9a0d91ca50cb896ecce563bd995",
			},
		});
	});
});
