import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { resolveActionScope } from "../contracts/scope.js";
import type {
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { listMcpTools } from "../protocols/mcp.js";
import { testSchema as z } from "../test/standard-schema.js";
import { deriveApprovalKey, isApprovalKey } from "./approval.js";
import { defineConvexAction } from "./define.js";
import { executeRegisteredAction, type ApprovalVerifier } from "./execute.js";
import { isExposedToExternalAgents, isExposedToInAppAgent } from "./exposure.js";
import { fingerprintActionInput } from "./fingerprint.js";
import { ActionRegistry } from "./registry.js";
import { normalizeToolParameters } from "./tool-schema.js";

class MemoryInvocations implements InvocationPersistence {
	readonly records = new Map<string, InvocationRecord>();
	async claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		const key = `${input.scopeKey}:${input.actionName}:${input.idempotencyKey}`;
		const current = this.records.get(key);
		if (current) return { outcome: "replay", invocation: current };
		const now = Date.now();
		const invocation: InvocationRecord = {
			id: `inv_${this.records.size + 1}`,
			...input,
			status: "running",
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(key, invocation);
		return { outcome: "claimed", invocation };
	}
	async getInvocation(input: {
		scopeKey: string;
		invocationId: string;
	}): Promise<InvocationRecord | null> {
		return (
			[...this.records.values()].find(
				(record) => record.scopeKey === input.scopeKey && record.id === input.invocationId,
			) ?? null
		);
	}
	async completeInvocation(input: {
		scopeKey: string;
		invocationId: string;
		result: unknown;
	}): Promise<InvocationRecord> {
		const record = await this.getInvocation(input);
		if (!record) throw new Error("not found");
		Object.assign(record, { status: "completed" as const, result: input.result });
		return record;
	}
	async failInvocation(input: {
		scopeKey: string;
		invocationId: string;
		errorCode: string;
		errorMessage: string;
	}): Promise<InvocationRecord> {
		const record = await this.getInvocation(input);
		if (!record) throw new Error("not found");
		Object.assign(record, { status: "failed" as const, errorCode: input.errorCode });
		return record;
	}
}

const scope = resolveActionScope({ scopeKey: "org_1", subjectId: "user_1" });
const publicRead = { expose: true, readOnly: true } as const;

function readAction(overrides: Record<string, unknown>) {
	return defineAction({
		description: "Read",
		schema: z.object({}),
		readOnly: true,
		publicAgent: publicRead,
		run: () => ({ ok: true }),
		...overrides,
	});
}

describe("upstream 0.189 exposure rules", () => {
	it("mcpTool narrows external exposure without hiding the in-app agent", () => {
		const definition = readAction({ mcpTool: false });
		expect(isExposedToInAppAgent(definition)).toBe(true);
		expect(isExposedToExternalAgents(definition)).toBe(false);
	});

	it("agentTool: false with mcpTool: true is an external-only action", () => {
		const definition = readAction({ agentTool: false, mcpTool: true });
		expect(isExposedToInAppAgent(definition)).toBe(false);
		expect(isExposedToExternalAgents(definition)).toBe(true);
	});

	it("uiOnly hides the action from every agent surface", () => {
		const definition = readAction({ uiOnly: true });
		expect(isExposedToInAppAgent(definition)).toBe(false);
		expect(isExposedToExternalAgents(definition)).toBe(false);
	});

	it("endsTurn stays in-app unless mcpTool opts back in", () => {
		expect(isExposedToExternalAgents(readAction({ endsTurn: true }))).toBe(false);
		expect(isExposedToExternalAgents(readAction({ endsTurn: true, mcpTool: true }))).toBe(true);
	});

	it("refuses webmcp and mcp callers for an mcpTool: false action", async () => {
		const registry = new ActionRegistry().register("narrow-read", readAction({ mcpTool: false }));
		for (const caller of ["mcp", "webmcp"] as const) {
			await expect(
				executeRegisteredAction(registry, new MemoryInvocations(), {
					actionName: "narrow-read",
					input: {},
					caller,
					scope,
				}),
			).rejects.toMatchObject({ code: "ACTION_NOT_EXPOSED" });
		}
		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "narrow-read",
				input: {},
				caller: "tool",
				scope,
			}),
		).resolves.toMatchObject({ result: { ok: true } });
	});

	it("hides mcpTool: false and uiOnly actions from tools/list", () => {
		const registry = new ActionRegistry()
			.register("visible", readAction({}))
			.register("narrow", readAction({ mcpTool: false }))
			.register("ui-only", readAction({ uiOnly: true }));
		expect(listMcpTools(registry).map((tool) => tool.name)).toEqual(["visible"]);
	});
});

describe("upstream 0.189 capability scopes", () => {
	const registry = new ActionRegistry().register(
		"scoped-read",
		defineConvexAction({
			description: "Scoped read",
			schema: z.object({}),
			toolParameters: { type: "object", properties: {} },
			readOnly: true,
			capabilityScopes: ["ledger:read"],
			run: () => ({ ok: true }),
		}),
	);

	it("normalises declared scopes the way granted scopes are normalised", () => {
		const definition = defineConvexAction({
			description: "Padded scopes",
			schema: z.object({}),
			toolParameters: { type: "object", properties: {} },
			readOnly: true,
			capabilityScopes: [" ledger:read ", "ledger:read"],
			run: () => ({ ok: true }),
		});
		expect(definition.capabilityScopes).toEqual(["ledger:read"]);
		expect(() =>
			defineConvexAction({
				description: "Blank scope",
				schema: z.object({}),
				toolParameters: { type: "object", properties: {} },
				capabilityScopes: [" "],
				run: () => ({ ok: true }),
			}),
		).toThrow(/capabilityScopes/u);
	});

	it("fails closed when the resolved scope carries no granted scopes", async () => {
		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "scoped-read",
				input: {},
				caller: "frontend",
				scope,
			}),
		).rejects.toMatchObject({
			code: "ACTION_NOT_AUTHORIZED",
			details: { missingScopes: ["ledger:read"] },
		});
	});

	it("runs when every declared scope is granted", async () => {
		const granted = resolveActionScope({
			scopeKey: "org_1",
			subjectId: "user_1",
			grantedScopes: ["ledger:read", "ledger:write"],
		});
		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "scoped-read",
				input: {},
				caller: "frontend",
				scope: granted,
			}),
		).resolves.toMatchObject({ result: { ok: true } });
	});
});

describe("upstream 0.189 approval hardening", () => {
	function approvalRegistry(allowPersistentApproval: boolean | undefined) {
		return new ActionRegistry().register(
			"gated-write",
			defineAction({
				description: "Gated write",
				schema: z.object({ amount: z.number() }),
				needsApproval: true,
				audit: { enabled: false },
				...(allowPersistentApproval === undefined ? {} : { allowPersistentApproval }),
				run: () => ({ ok: true }),
			}),
			{ authorizeBeforeClaim: () => true, projectReplayResult: (result) => result },
		);
	}

	it("hands the verifier a content-addressed approval key for the exact call", async () => {
		const verifier: ApprovalVerifier = { verifyAndConsume: vi.fn(async () => true) };
		await executeRegisteredAction(
			approvalRegistry(undefined),
			new MemoryInvocations(),
			{
				actionName: "gated-write",
				input: { amount: 5 },
				caller: "frontend",
				scope,
				idempotencyKey: "k1",
				approvedToolCallKey: "grant-1",
			},
			{ approvalVerifier: verifier },
		);
		const expected = await deriveApprovalKey(
			"gated-write",
			await fingerprintActionInput({ amount: 5 }),
		);
		expect(isApprovalKey(expected)).toBe(true);
		expect(verifier.verifyAndConsume).toHaveBeenCalledWith(
			expect.objectContaining({ approvalKey: expected, allowPersistentApproval: false }),
		);
		expect(expected).not.toBe(
			await deriveApprovalKey("gated-write", await fingerprintActionInput({ amount: 6 })),
		);
	});

	it("refuses a standing approval unless the action allows persistent approval", async () => {
		const standing: ApprovalVerifier = {
			verifyAndConsume: async () => ({ approved: true, persistent: true }),
		};
		const request = {
			actionName: "gated-write",
			input: { amount: 5 },
			caller: "frontend" as const,
			scope,
			idempotencyKey: "k2",
			approvedToolCallKey: "standing-grant",
		};
		await expect(
			executeRegisteredAction(approvalRegistry(undefined), new MemoryInvocations(), request, {
				approvalVerifier: standing,
			}),
		).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
		await expect(
			executeRegisteredAction(approvalRegistry(true), new MemoryInvocations(), request, {
				approvalVerifier: standing,
			}),
		).resolves.toMatchObject({ result: { ok: true } });
	});
});

describe("upstream 0.189 connection-required mapping", () => {
	it("maps an agentConnectionRequired error to a stable code with provider details", async () => {
		class ConnectionRequired extends Error {
			readonly agentConnectionRequired = true;
			readonly provider = "stripe";
			readonly reason = "reauthorize";
		}
		const registry = new ActionRegistry().register(
			"needs-stripe",
			readAction({ run: () => Promise.reject(new ConnectionRequired("connect stripe")) }),
		);
		await expect(
			executeRegisteredAction(registry, new MemoryInvocations(), {
				actionName: "needs-stripe",
				input: {},
				caller: "tool",
				scope,
			}),
		).rejects.toMatchObject({
			code: "ACTION_CONNECTION_REQUIRED",
			details: { provider: "stripe", reason: "reauthorize" },
		});
	});
});

describe("upstream 0.187 tool schema normalisation", () => {
	it("flattens a root union into one object schema and rewrites oneOf", () => {
		const normalized = normalizeToolParameters({
			oneOf: [
				{
					type: "object",
					properties: { kind: { const: "a" }, id: { type: "string" } },
					required: ["kind", "id"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { kind: { const: "b" }, id: { type: "string" }, note: { type: "string" } },
					required: ["kind", "note"],
				},
			],
		});
		expect(normalized).toMatchObject({
			type: "object",
			properties: {
				kind: { anyOf: [{ const: "a" }, { const: "b" }] },
				id: { type: "string" },
				note: { type: "string" },
			},
			required: ["kind"],
		});
		expect(normalized).not.toHaveProperty("oneOf");
		expect(normalized).not.toHaveProperty("additionalProperties");
	});

	it("strips provider-rejected keywords, formats and lookaround patterns without mutating input", () => {
		const parameters = {
			type: "object",
			properties: {
				url: { type: "string", format: "uri", pattern: "^(?!bad)" },
				when: { type: "string", format: "date-time" },
			},
			propertyNames: { pattern: "^[a-z]+$" },
		};
		const snapshot = JSON.stringify(parameters);
		const normalized = normalizeToolParameters(parameters);
		expect(normalized).toEqual({
			type: "object",
			properties: { url: { type: "string" }, when: { type: "string", format: "date-time" } },
		});
		expect(JSON.stringify(parameters)).toBe(snapshot);
	});
});
