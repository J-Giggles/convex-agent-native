import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { executeRegisteredAction } from "../action/execute.js";
import { ActionRegistry } from "../action/registry.js";
import { createActionClient } from "../client/index.js";
import { resolveActionScope } from "../contracts/scope.js";
import type { InvocationPersistence } from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import { createA2AProtocolAdapter } from "./a2a.js";
import { ConvexActionCliAdapter } from "./cli.js";
import { handleMcpRequest } from "./mcp.js";

const persistence: InvocationPersistence = {
	getInvocation: async () => null,
	claimInvocation: async () => {
		throw new Error("read-only action must not claim an invocation");
	},
	completeInvocation: async () => {
		throw new Error("read-only action must not settle an invocation");
	},
	failInvocation: async () => {
		throw new Error("read-only action must not settle an invocation");
	},
};

const scope = resolveActionScope({
	scopeKey: "org:surface-test",
	subjectId: "user:surface-test",
});

function makeSurfaces(registry: ActionRegistry) {
	const invoke = (request: { actionName: string; input: unknown; idempotencyKey?: string }) =>
		executeRegisteredAction(registry, persistence, {
			...request,
			caller: "frontend",
			scope,
		});
	return {
		client: createActionClient(invoke),
		cli: new ConvexActionCliAdapter({ invoke }),
		mcp: (name: string, input: unknown) =>
			handleMcpRequest({
				registry,
				persistence,
				scope,
				request: {
					jsonrpc: "2.0",
					id: "surface-mcp",
					method: "tools/call",
					params: { name, arguments: input },
				},
			}),
		a2a: createA2AProtocolAdapter({
			name: "Surface test",
			description: "Shared action surface test",
			baseUrl: "https://surface.example.test",
			registry,
			persistence,
			createId: () => "surface-a2a",
		}),
	};
}

describe("shared action surface fan-out", () => {
	it("SUR-N01 routes client, CLI, MCP, and A2A through one official action", async () => {
		const run = vi.fn(({ id }: { id: string }) => ({ id, ok: true }));
		const registry = new ActionRegistry().register(
			"get-surface",
			defineAction({
				description: "Get a surface result",
				schema: z.object({ id: z.string() }),
				readOnly: true,
				publicAgent: { expose: true, readOnly: true },
				run,
			}),
		);
		const surfaces = makeSurfaces(registry);

		await expect(
			surfaces.client.callAction("get-surface", { id: "client" }),
		).resolves.toMatchObject({
			result: { id: "client", ok: true },
		});
		await expect(surfaces.cli.execute(["get-surface", '{"id":"cli"}'])).resolves.toMatchObject({
			exitCode: 0,
		});
		await expect(surfaces.mcp("get-surface", { id: "mcp" })).resolves.toMatchObject({
			result: { structuredContent: { id: "mcp", ok: true } },
		});
		await expect(
			surfaces.a2a.handle(
				{
					jsonrpc: "2.0",
					id: "a2a",
					method: "actions/invoke",
					params: { action: "get-surface", input: { id: "a2a" } },
				},
				{ scope, authenticated: true, audienceVerified: true },
			),
		).resolves.toMatchObject({ result: { action: "get-surface", status: "completed" } });
		expect(run).toHaveBeenCalledTimes(4);
	});

	it("SUR-F01 enforces surface-specific exposure restrictions", async () => {
		const registry = new ActionRegistry().register(
			"host-only-read",
			defineAction({
				description: "Host-only read",
				schema: z.object({}),
				readOnly: true,
				publicAgent: { expose: true, readOnly: true },
				toolCallable: false,
				run: () => ({ ok: true }),
			}),
		);
		const surfaces = makeSurfaces(registry);

		await expect(surfaces.client.callAction("host-only-read", {})).resolves.toMatchObject({
			result: { ok: true },
		});
		await expect(surfaces.mcp("host-only-read", {})).resolves.toMatchObject({
			error: { code: -32003 },
		});
		await expect(
			surfaces.a2a.handle(
				{
					jsonrpc: "2.0",
					id: "denied",
					method: "actions/invoke",
					params: { action: "host-only-read", input: {} },
				},
				{ scope, authenticated: true, audienceVerified: true },
			),
		).resolves.toMatchObject({ error: { code: -32000 } });
	});

	it("SUR-I01 shares schema validation and scope-bound execution across callers", async () => {
		const run = vi.fn(() => ({ ok: true }));
		const registry = new ActionRegistry().register(
			"validated-surface",
			defineAction({
				description: "Validated surface",
				schema: z.object({ amount: z.number().int() }),
				readOnly: true,
				publicAgent: { expose: true, readOnly: true },
				run,
			}),
		);
		const surfaces = makeSurfaces(registry);

		await expect(
			surfaces.client.callAction("validated-surface", { amount: "wrong" }),
		).rejects.toMatchObject({ code: "ACTION_INPUT_INVALID" });
		await expect(
			surfaces.cli.execute(["validated-surface", '{"amount":"wrong"}']),
		).resolves.toMatchObject({ exitCode: 1 });
		await expect(surfaces.mcp("validated-surface", { amount: "wrong" })).resolves.toMatchObject({
			error: { code: -32602 },
		});
		await expect(
			surfaces.a2a.handle(
				{
					jsonrpc: "2.0",
					id: "invalid",
					method: "actions/invoke",
					params: { action: "validated-surface", input: { amount: "wrong" } },
				},
				{ scope, authenticated: true, audienceVerified: true },
			),
		).resolves.toMatchObject({ error: { code: -32000 } });
		expect(run).not.toHaveBeenCalled();
	});
});
