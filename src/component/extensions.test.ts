import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import {
	assertSafeExtensionData,
	createInertExtensionRevision,
	extensionDataDigest,
	extensionDataIdentifier,
	INERT_EXTENSION_RENDER_POLICY,
} from "../extensions/policy.js";
import { api } from "./_generated/api.js";
import { assertPurposeTypedData } from "./extensionSafety.js";
import schema from "./schema.js";

const modules = {
	"./_generated/api.ts": () => import("./_generated/api.js"),
	"./_generated/dataModel.ts": () => import("./_generated/dataModel.js"),
	"./_generated/server.ts": () => import("./_generated/server.js"),
	"./extensionSafety.ts": () => import("./extensionSafety.js"),
	"./extensionValidators.ts": () => import("./extensionValidators.js"),
	"./extensions.ts": () => import("./extensions.js"),
};

const owner = {
	scopeKey: "org:alpha",
	subjectId: "user:owner",
	organizationId: "alpha",
	role: "owner" as const,
};

function setup() {
	return convexTest(schema, modules);
}

function mutableDraft<T extends Awaited<ReturnType<typeof createInertExtensionRevision>>>(
	draft: T,
) {
	return {
		...draft,
		renderPolicy: {
			...draft.renderPolicy,
			sandbox: [...draft.renderPolicy.sandbox],
		},
	};
}

async function install(t: ReturnType<typeof setup>) {
	const draft = await createInertExtensionRevision({
		extensionId: "status-card",
		content: "<section><strong>Ready</strong></section>",
		summary: "Initial card",
	});
	return t.mutation(api.extensions.installPortable, {
		...owner,
		...mutableDraft(draft),
		name: "Status card",
		description: "Inert status card",
		visibility: "organization",
		manifest: {
			slots: ["dashboard"],
			requestedActions: [],
			requestedCommands: [],
			storageScopes: ["user", "organization"],
		},
	});
}

describe("native Convex extension persistence", () => {
	it("XTN-N01 persists an inert portable definition and monotonic revisions", async () => {
		const t = setup();
		const first = await install(t);
		expect(first).toMatchObject({
			extension: { id: "status-card", currentRevision: 1 },
			revision: { revision: 1, renderPolicy: INERT_EXTENSION_RENDER_POLICY },
		});

		const secondDraft = await createInertExtensionRevision({
			extensionId: "status-card",
			content: "<section><strong>Updated</strong></section>",
			summary: "Updated card",
		});
		const second = await t.mutation(api.extensions.appendRevision, {
			...owner,
			...mutableDraft(secondDraft),
		});
		expect(second.extension.currentRevision).toBe(2);
		await expect(
			t.query(api.extensions.listRevisions, { ...owner, extensionId: "status-card" }),
		).resolves.toMatchObject([{ revision: 1 }, { revision: 2 }]);

		const consent = await t.mutation(api.extensions.grantConsent, {
			...owner,
			extensionId: "status-card",
			contentHash: second.extension.currentContentHash,
		});
		expect(consent).toMatchObject({ subjectId: owner.subjectId });
		await expect(
			t.mutation(api.extensions.setData, {
				...owner,
				extensionId: "status-card",
				collection: "preferences",
				itemId: "layout",
				storageScope: "user",
				data: { layoutId: "compact" },
			}),
		).resolves.toMatchObject({ id: "layout", data: { layoutId: "compact" } });
	});

	it("XTN-F01 refuses cross-scope, unprivileged, stale-consent, and unsafe writes", async () => {
		const t = setup();
		const installed = await install(t);
		await expect(
			t.query(api.extensions.getExtension, {
				...owner,
				scopeKey: "org:beta",
				organizationId: "beta",
				extensionId: "status-card",
			}),
		).resolves.toBeNull();

		const safeDraft = await createInertExtensionRevision({
			extensionId: "status-card",
			content: "<section>Viewer</section>",
		});
		await expect(
			t.mutation(api.extensions.appendRevision, {
				...owner,
				role: "viewer",
				...mutableDraft(safeDraft),
			}),
		).rejects.toThrow("forbidden");
		await expect(
			t.mutation(api.extensions.grantConsent, {
				...owner,
				extensionId: "status-card",
				contentHash: `sha256:${"0".repeat(64)}`,
			}),
		).rejects.toThrow("current extension revision");
		await expect(
			t.mutation(api.extensions.setData, {
				...owner,
				extensionId: "status-card",
				collection: "preferences",
				itemId: "unsafe",
				storageScope: "user",
				data: { note: "invoice-12345678" },
			}),
		).rejects.toThrow(/purpose-typed|unsafe/u);
		await expect(
			t.mutation(api.extensions.appendRevision, {
				...owner,
				extensionId: "status-card",
				content: "<section>Changed</section>",
				contentHash: installed.extension.currentContentHash,
				renderPolicy: {
					mode: "inert-text",
					sandbox: ["allow-same-origin"],
					csp: INERT_EXTENSION_RENDER_POLICY.csp,
				},
			}),
		).rejects.toThrow();
	});

	it("XTN-I01 isolates user data and never stores executable render authority", async () => {
		const t = setup();
		await install(t);
		await t.mutation(api.extensions.setData, {
			...owner,
			extensionId: "status-card",
			collection: "preferences",
			itemId: "layout",
			storageScope: "user",
			data: { layoutId: "compact" },
		});
		await expect(
			t.query(api.extensions.getData, {
				...owner,
				subjectId: "user:other",
				extensionId: "status-card",
				collection: "preferences",
				itemId: "layout",
				storageScope: "user",
			}),
		).resolves.toBeNull();

		const revisions = await t.query(api.extensions.listRevisions, {
			...owner,
			extensionId: "status-card",
		});
		expect(revisions[0]?.renderPolicy).toEqual(INERT_EXTENSION_RENDER_POLICY);
		expect(JSON.stringify(revisions)).not.toMatch(/allow-scripts|allow-same-origin|https?:/u);
	});

	it("reuses the canonical durable-data policy at the component boundary", () => {
		const safeValues = [
			{ invoiceId: "invoice_42" },
			{ requestDigest: `sha256:${"a".repeat(64)}` },
			{
				nested: {
					invoiceId: extensionDataIdentifier("invoice", "invoice_42"),
					requestDigest: extensionDataDigest("request", `sha256:${"b".repeat(64)}`),
				},
			},
		];
		for (const value of safeValues) {
			expect(() => assertSafeExtensionData(value)).not.toThrow();
			expect(() => assertPurposeTypedData(value)).not.toThrow();
		}

		const narrative = "Invoice 43872 for GBP 920.00 from billing@example.test";
		const encodedNarratives = [
			Buffer.from(narrative).toString("base64"),
			Buffer.from(narrative).toString("base64url"),
			Buffer.from(narrative).toString("hex"),
			encodeURIComponent(narrative),
		];
		const unsafeValues = [
			{ note: narrative },
			...encodedNarratives.flatMap((encoded) => [
				{ invoiceId: encoded },
				{ invoice_id: encoded },
				{ invoiceIds: [encoded] },
				{ nested: { invoiceId: encoded } },
				{ nested: { request_hash: encoded } },
				{ date: encoded },
			]),
			{ invoiceId: "12345678" },
			{ invoiceId: 42 },
			{ invoiceId: { nestedId: "invoice_42" } },
			{ invoiceId: extensionDataDigest("request", `sha256:${"c".repeat(64)}`) },
			{ requestDigest: `sha256:${"x".repeat(64)}` },
			{ requestDigest: extensionDataIdentifier("request", "request_42") },
			{ requestDigest: { nestedDigest: `sha256:${"c".repeat(64)}` } },
			{
				invoiceId: {
					$agentNative: "opaque-id",
					purpose: "invoice",
					value: "invoice_42",
					note: narrative,
				},
			},
			{ date: "2026-08-02" },
			{ authorization: "Bearer credential" },
		];
		for (const value of unsafeValues) {
			expect(() => assertSafeExtensionData(value)).toThrow();
			expect(() => assertPurposeTypedData(value)).toThrow();
		}
	});
});
