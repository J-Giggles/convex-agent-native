import { describe, expect, it, vi } from "vitest";

import {
	ConvexExtensionPersistence,
	ExtensionSecurityError,
	assertExtensionBridgeAction,
	assertSafeExtensionData,
	createInertExtensionRevision,
	extensionDataDigest,
	extensionDataIdentifier,
	resolveExtensionAccess,
	type ConvexExtensionFunctions,
	type ConvexExtensionFunctionRunner,
	type ExtensionRecord,
} from "./index.js";

const access = resolveExtensionAccess({
	scopeKey: "org:acme",
	subjectId: "user:one",
	organizationId: "acme",
	role: "editor",
});

const extension: ExtensionRecord = {
	id: "ext_dashboard",
	scopeKey: "org:acme",
	organizationId: "acme",
	name: "Dashboard",
	description: "An inert dashboard document",
	visibility: "organization",
	manifest: {
		slots: ["dashboard"],
		requestedActions: ["refresh-dashboard"],
		requestedCommands: [],
		storageScopes: ["organization"],
	},
	currentRevision: 1,
	currentContentHash: "sha256:content-one",
	createdAt: 1,
	updatedAt: 1,
};

function functionRefs(): ConvexExtensionFunctions {
	return {
		getExtension: "getExtension" as never,
		listExtensions: "listExtensions" as never,
		appendRevision: "appendRevision" as never,
		listRevisions: "listRevisions" as never,
		getConsent: "getConsent" as never,
		grantConsent: "grantConsent" as never,
		listData: "listData" as never,
		getData: "getData" as never,
		setData: "setData" as never,
		removeData: "removeData" as never,
	};
}

describe("Convex extension foundation", () => {
	it("XTN-N01 persists one inert revision and scoped data through Convex", async () => {
		const revision = await createInertExtensionRevision({
			extensionId: extension.id,
			content: "<section>Revenue summary</section>",
			summary: "Initial revision",
		});
		const mutation = vi.fn(async (reference: unknown, args: any) => {
			if (reference === "appendRevision") {
				return {
					extension: { ...extension, currentContentHash: revision.contentHash },
					revision: {
						...revision,
						scopeKey: access.scopeKey,
						revision: 1,
						createdAt: 2,
					},
				};
			}
			if (reference === "setData") {
				return {
					id: args.itemId,
					extensionId: args.extensionId,
					collection: args.collection,
					storageScope: args.storageScope,
					scopeKey: access.scopeKey,
					data: args.data,
					createdAt: 3,
					updatedAt: 3,
				};
			}
			throw new Error("unexpected mutation");
		});
		const persistence = new ConvexExtensionPersistence(
			{ query: vi.fn(), mutation } as unknown as ConvexExtensionFunctionRunner,
			functionRefs(),
		);

		const appended = await persistence.appendRevision(access, revision);
		const row = await persistence.setData(access, extension, {
			collection: "preferences",
			itemId: "layout",
			storageScope: "organization",
			data: { columns: 3 },
		});

		expect(appended.revision.content).toBe("<section>Revenue summary</section>");
		expect(row).toMatchObject({ id: "layout", data: { columns: 3 } });
		expect(mutation).toHaveBeenCalledTimes(2);
	});

	it("XTN-F01 / SEC-04 denies missing consent, cross-org state, and forged bridge callers", () => {
		expect(() =>
			assertExtensionBridgeAction({
				caller: "extension",
				access,
				extension,
				slotId: "dashboard",
				consent: null,
				actionName: "refresh-dashboard",
				action: { toolCallable: true },
			}),
		).toThrowError(ExtensionSecurityError);

		expect(() =>
			assertExtensionBridgeAction({
				caller: "extension",
				access,
				extension: { ...extension, organizationId: "other", scopeKey: "org:other" },
				slotId: "dashboard",
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				actionName: "refresh-dashboard",
				action: { toolCallable: true },
			}),
		).toThrow(/scope/i);

		expect(() =>
			assertExtensionBridgeAction({
				caller: "extension",
				access,
				extension,
				slotId: "dashboard",
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				actionName: "refresh-dashboard",
				action: { toolCallable: false },
			}),
		).toThrow(/not callable/i);

		expect(() =>
			assertExtensionBridgeAction({
				caller: "extension",
				access,
				extension,
				slotId: "dashboard",
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				actionName: "refresh-dashboard",
				action: {},
			}),
		).toThrow(/not callable/i);

		expect(() =>
			assertExtensionBridgeAction({
				caller: "frontend" as never,
				access,
				extension,
				slotId: "dashboard",
				consent: {
					extensionId: extension.id,
					scopeKey: access.scopeKey,
					subjectId: access.subjectId,
					contentHash: extension.currentContentHash,
					grantedAt: 2,
				},
				actionName: "refresh-dashboard",
				action: { toolCallable: true },
			}),
		).toThrow(/caller provenance/i);
	});

	it("XTN-I01 / SEC-02 fixes sandbox/CSP and rejects unsafe durable content", async () => {
		const safe = await createInertExtensionRevision({
			extensionId: extension.id,
			content: "<p>Safe document</p>",
		});
		expect(safe.renderPolicy.sandbox).not.toContain("allow-same-origin");
		expect(safe.renderPolicy.csp).toContain("connect-src 'none'");
		expect(safe.renderPolicy.csp).toContain("object-src 'none'");

		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "Authorization: Bearer super-secret",
			}),
		).rejects.toThrow(/secret/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "x".repeat(70_000),
			}),
		).rejects.toThrow(/large/i);
		expect(() =>
			assertSafeExtensionData({
				content: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			}),
		).toThrow(/purpose-typed identifier/i);
		expect(() => assertSafeExtensionData({ value: 12_345_678 })).toThrow(/identifier-shaped/i);
		expect(() => assertSafeExtensionData({ value: "12345678" })).toThrow(
			/purpose-typed identifier/i,
		);
		expect(() =>
			assertSafeExtensionData({
				legacyInvoiceId: "invoice-42",
				invoiceId: extensionDataIdentifier("invoice", "invoice_42"),
				legacyContentDigest: `sha256:${"c".repeat(64)}`,
				contentDigest: extensionDataDigest("content", `sha256:${"c".repeat(64)}`),
			}),
		).not.toThrow();
		const narrative = "Invoice 43872 for GBP 920.00 from billing@example.test";
		for (const encoded of [
			Buffer.from(narrative).toString("base64"),
			Buffer.from(narrative).toString("base64url"),
			Buffer.from(narrative).toString("hex"),
			encodeURIComponent(narrative),
		]) {
			expect(() => assertSafeExtensionData({ nested: { neutral: encoded } })).toThrow(
				/purpose-typed identifier/i,
			);
			expect(() => extensionDataIdentifier("invoice", encoded)).toThrow(/durable/i);
			expect(() => assertSafeExtensionData({ invoiceId: encoded })).toThrow(/durable/i);
		}
		expect(() => assertSafeExtensionData({ nested: { neutral: "invoice_42" } })).toThrow(
			/durable/i,
		);
		expect(() => extensionDataDigest("content", `sha256:${"x".repeat(64)}`)).toThrow(/durable/i);
		expect(() =>
			assertSafeExtensionData({
				value: {
					$agentNative: "opaque-id",
					purpose: "invoice",
					value: "invoice_42",
					narrative,
				},
			}),
		).toThrow(/durable/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			}),
		).rejects.toThrow(/static inert markup/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: '<p title="Dear recipient attached invoice 43872 for GBP 920">Safe document</p>',
			}),
		).rejects.toThrow(/attributes/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "<p>Safe document</p>",
				summary: "Dear recipient, attached invoice 43872 for GBP 920.00; please pay supplier ABC.",
			}),
		).rejects.toThrow(/bounded UI labels/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "<p>Account 12345678</p>",
			}),
		).rejects.toThrow(/UI labels/i);
		await expect(
			createInertExtensionRevision({
				extensionId: extension.id,
				content: "<p>Safe document</p>",
				summary: "Account 12345678",
			}),
		).rejects.toThrow(/UI labels/i);

		const mutation = vi.fn();
		const persistence = new ConvexExtensionPersistence(
			{ query: vi.fn(), mutation } as unknown as ConvexExtensionFunctionRunner,
			functionRefs(),
		);
		await expect(
			persistence.appendRevision(access, {
				...safe,
				contentHash: "sha256:forged",
				renderPolicy: {
					mode: "inert-text",
					sandbox: ["allow-same-origin"],
					csp: "default-src *",
				},
			}),
		).rejects.toThrow(/policy|hash/i);
		expect(mutation).not.toHaveBeenCalled();
	});
});
