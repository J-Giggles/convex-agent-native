import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";

import { ActionRegistry } from "../action/registry.js";
import type {
	ClaimInvocationInput,
	ClaimInvocationResult,
	InvocationPersistence,
	InvocationRecord,
} from "../persistence/invocations.js";
import { testSchema as z } from "../test/standard-schema.js";
import { executeExtensionAction } from "./bridge.js";
import { resolveExtensionAccess, type ExtensionRecord } from "./types.js";

class MemoryInvocations implements InvocationPersistence {
	record?: InvocationRecord;

	async claimInvocation(input: ClaimInvocationInput): Promise<ClaimInvocationResult> {
		this.record = {
			id: "invocation_1",
			...input,
			status: "running",
			createdAt: 1,
			updatedAt: 1,
		};
		return { outcome: "claimed", invocation: this.record };
	}

	async getInvocation(): Promise<InvocationRecord | null> {
		return this.record ?? null;
	}

	async completeInvocation(input: { result: unknown }): Promise<InvocationRecord> {
		if (!this.record) throw new Error("missing invocation");
		this.record = { ...this.record, status: "completed", result: input.result, updatedAt: 2 };
		return this.record;
	}

	async failInvocation(input: {
		errorCode: string;
		errorMessage: string;
	}): Promise<InvocationRecord> {
		if (!this.record) throw new Error("missing invocation");
		this.record = {
			...this.record,
			status: "failed",
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			updatedAt: 2,
		};
		return this.record;
	}
}

const access = resolveExtensionAccess({
	scopeKey: "org:alpha",
	subjectId: "user:owner",
	organizationId: "alpha",
	role: "owner",
});

const extension: ExtensionRecord = {
	id: "status-card",
	scopeKey: access.scopeKey,
	organizationId: "alpha",
	name: "Status card",
	description: "Inert status card",
	visibility: "organization",
	manifest: {
		slots: ["dashboard"],
		requestedActions: ["refresh-dashboard"],
		requestedCommands: [],
		storageScopes: ["user"],
	},
	currentRevision: 1,
	currentContentHash: `sha256:${"a".repeat(64)}`,
	createdAt: 1,
	updatedAt: 1,
};

describe("authenticated extension action bridge", () => {
	it("SEC-04 carries verified extension provenance through policy, claim, and handler", async () => {
		const authorize = vi.fn((_input, context) => context.caller === "extension");
		const handler = vi.fn((_input, context) => ({ caller: context?.caller }));
		const registry = new ActionRegistry().register(
			"refresh-dashboard",
			defineAction({
				description: "Refresh the extension dashboard",
				schema: z.object({}),
				toolCallable: true,
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: authorize,
				projectReplayResult: () => ({ ok: true }),
			},
		);
		const persistence = new MemoryInvocations();

		await expect(
			executeExtensionAction(registry, persistence, {
				actionName: "refresh-dashboard",
				input: {},
				idempotencyKey: "extension-request-1",
				access,
				extension,
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				slotId: "dashboard",
			}),
		).resolves.toMatchObject({ replayed: false });

		expect(authorize).toHaveBeenCalledWith({}, expect.objectContaining({ caller: "extension" }));
		expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ caller: "extension" }));
		expect(persistence.record).toMatchObject({
			caller: "extension",
			actorId: access.subjectId,
			scopeKey: access.scopeKey,
			status: "completed",
		});
	});

	it("SEC-04 refuses a deserialized access claim before durable claim or handler dispatch", async () => {
		const handler = vi.fn(() => ({ ok: true }));
		const registry = new ActionRegistry().register(
			"refresh-dashboard",
			defineAction({
				description: "Refresh the extension dashboard",
				schema: z.object({}),
				toolCallable: true,
				audit: { enabled: false },
				run: handler,
			}),
			{
				authorizeBeforeClaim: () => true,
				projectReplayResult: () => ({ ok: true }),
			},
		);
		const persistence = new MemoryInvocations();
		const deserializedAccess = JSON.parse(JSON.stringify(access));

		await expect(
			executeExtensionAction(registry, persistence, {
				actionName: "refresh-dashboard",
				input: {},
				idempotencyKey: "extension-request-forged",
				access: deserializedAccess,
				extension,
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				slotId: "dashboard",
			}),
		).rejects.toMatchObject({ code: "INVALID_SCOPE" });
		expect(persistence.record).toBeUndefined();
		expect(handler).not.toHaveBeenCalled();
	});
});
