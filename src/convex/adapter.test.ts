import { anyApi } from "convex/server";
import { describe, expect, test, vi } from "vitest";

import { resolveActionScope } from "../contracts/scope.js";
import { resolveExtensionAccess } from "../extensions/types.js";
import type { ComponentApi } from "../component/_generated/component.js";
import {
	createConvexExtensionPersistence,
	createConvexInvocationPersistence,
	type AgentNativeConvexComponent,
} from "./adapter.js";

const fingerprint = `sha256:${"a".repeat(64)}`;

describe("context-bound Convex persistence adapter", () => {
	test("the adapter accepts the packaged generated component API", () => {
		const generated = null as unknown as ComponentApi;
		const compatible: AgentNativeConvexComponent = generated;
		expect(compatible).toBeNull();
	});
	test("PER-N01 forwards only its host-resolved normalized scope", async () => {
		const runMutation = vi.fn().mockResolvedValue({
			outcome: "claimed",
			invocation: {
				id: "invocation-id",
				scopeKey: "org:alpha",
				actionName: "increment-widget",
				idempotencyKey: "request-1",
				actorId: "user:1",
				requestFingerprint: fingerprint,
				caller: "frontend",
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			},
		});
		const persistence = createConvexInvocationPersistence(
			{ runMutation, runQuery: vi.fn() } as never,
			anyApi.agentNativeConvex as unknown as AgentNativeConvexComponent,
			resolveActionScope({ scopeKey: "org:alpha", subjectId: "user:1" }),
		);

		await persistence.claimInvocation({
			scopeKey: "org:alpha",
			actionName: "increment-widget",
			idempotencyKey: "request-1",
			actorId: "user:1",
			requestFingerprint: fingerprint,
			caller: "frontend",
		});

		expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
			scopeKey: "org:alpha",
			actionName: "increment-widget",
			idempotencyKey: "request-1",
			actorId: "user:1",
			requestFingerprint: fingerprint,
			caller: "frontend",
		});
	});

	test("PER-F01 adapter failures become stable typed errors", async () => {
		const persistence = createConvexInvocationPersistence(
			{
				runMutation: vi.fn().mockRejectedValue(new Error("database detail")),
				runQuery: vi.fn(),
			} as never,
			anyApi.agentNativeConvex as unknown as AgentNativeConvexComponent,
			resolveActionScope({ scopeKey: "org:alpha", subjectId: "user:1" }),
		);

		await expect(
			persistence.claimInvocation({
				scopeKey: "org:alpha",
				actionName: "increment-widget",
				idempotencyKey: "request-1",
				actorId: "user:1",
				requestFingerprint: fingerprint,
				caller: "frontend",
			}),
		).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE", retryable: true });
	});

	test("PER-I01 port scope arguments cannot override the bound scope", async () => {
		const runMutation = vi.fn();
		const persistence = createConvexInvocationPersistence(
			{ runMutation, runQuery: vi.fn() } as never,
			anyApi.agentNativeConvex as unknown as AgentNativeConvexComponent,
			resolveActionScope({ scopeKey: "org:alpha", subjectId: "user:1" }),
		);

		await expect(
			persistence.claimInvocation({
				scopeKey: "org:beta",
				actionName: "increment-widget",
				idempotencyKey: "request-1",
				actorId: "user:1",
				requestFingerprint: fingerprint,
				caller: "frontend",
			}),
		).rejects.toMatchObject({ code: "INVALID_SCOPE" });
		expect(runMutation).not.toHaveBeenCalled();
	});

	test("binds native extension functions to branded host access", async () => {
		const runQuery = vi.fn().mockResolvedValue(null);
		const persistence = createConvexExtensionPersistence(
			{ runQuery, runMutation: vi.fn() } as never,
			anyApi.agentNativeConvex as unknown as AgentNativeConvexComponent,
		);
		const access = resolveExtensionAccess({
			scopeKey: "org:alpha",
			subjectId: "user:1",
			organizationId: "alpha",
			role: "viewer",
		});
		await expect(persistence.getExtension(access, "status-card")).resolves.toBeNull();
		expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
			scopeKey: "org:alpha",
			subjectId: "user:1",
			organizationId: "alpha",
			role: "viewer",
			extensionId: "status-card",
		});
	});
});
