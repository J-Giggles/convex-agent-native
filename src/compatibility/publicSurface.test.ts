import type { AgentNativeExtensionDefinition } from "@agent-native/core/client/extensions";
import type { ComponentApi as AgentComponentApi } from "@convex-dev/agent/_generated/component.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as action from "../action/index.js";
import * as client from "../client/index.js";
import type { ComponentApi } from "../component/_generated/component.js";
import * as convex from "../convex/index.js";
import type { AgentNativeConvexComponent } from "../convex/adapter.js";
import * as extensions from "../extensions/index.js";
import * as protocols from "../protocols/index.js";
import { PUBLIC_API_GROUP_SNAPSHOT, type UpstreamPublicTypeSnapshot } from "./publicSurface.js";

describe("public API and upstream compile snapshots", () => {
	it("CT-N01 snapshots every promised public symbol group", () => {
		for (const [group, symbols] of Object.entries(PUBLIC_API_GROUP_SNAPSHOT)) {
			const api = { action, client, convex, extensions, protocols }[
				group as keyof typeof PUBLIC_API_GROUP_SNAPSHOT
			];
			for (const symbol of symbols) expect(api).toHaveProperty(symbol);
		}
	});

	it("CT-I01 keeps packaged and official component APIs structurally composed", () => {
		expectTypeOf<ComponentApi>().toMatchTypeOf<AgentNativeConvexComponent>();
		type ChildComposition = {
			agent: AgentComponentApi<"agent">;
			agentNative: ComponentApi<"agentNative">;
		};
		expectTypeOf<ChildComposition>().toMatchTypeOf<{
			agent: AgentComponentApi<"agent">;
			agentNative: AgentNativeConvexComponent;
		}>();
	});

	it("pins official portable extension types while narrowing host authority", async () => {
		const definition: AgentNativeExtensionDefinition = {
			id: "status-card",
			name: "Status card",
			description: "Portable status card",
			content: "<section><strong>Ready</strong></section>",
			manifest: {
				slots: ["dashboard", "unreviewed"],
				requestedActions: ["widgets.read", "widgets.delete"],
				storageScopes: ["user", "org", "all"],
			},
		};
		const installation = await convex.preparePortableExtensionInstallation(definition, {
			visibility: "organization",
			allowedSlots: ["dashboard"],
			allowedActions: ["widgets.read"],
			allowedStorageScopes: ["user", "organization"],
		});
		expect(installation.manifest).toEqual({
			slots: ["dashboard"],
			requestedActions: ["widgets.read"],
			requestedCommands: [],
			storageScopes: ["user", "organization"],
		});
		expect(installation.revision.renderPolicy).toEqual(extensions.INERT_EXTENSION_RENDER_POLICY);
	});

	it("compile snapshot still resolves all reviewed upstream type families", () => {
		expectTypeOf<UpstreamPublicTypeSnapshot>().toBeObject();
	});
});
