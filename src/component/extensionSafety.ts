import { assertPurposeTypedDurableContent } from "./durableContent.js";

const NAME = /^[a-z][a-z0-9._-]{0,95}$/;
const UI_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const FINANCIAL_IDENTIFIER = /\b\d{8,19}\b/;
const SECRET_VALUE =
	/(?:\$\{(?:keys|automationSecret)\.[^}]+\}|authorization\s*:|bearer\s+[A-Za-z0-9._~+\/-]{6,}|(?:token|password|secret)\s*[=:]\s*\S+)/i;
const MAX_CONTENT_BYTES = 64 * 1024;

export const INERT_CSP = [
	"default-src 'none'",
	"script-src 'none'",
	"style-src 'none'",
	"img-src 'none'",
	"connect-src 'none'",
	"font-src 'none'",
	"media-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

function bounded(value: string, label: string, max = 256): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > max) throw new Error(`${label} is invalid`);
	return normalized;
}

export function assertAccess(input: {
	scopeKey: string;
	subjectId: string;
	organizationId?: string;
	role: string;
}) {
	const scopeKey = bounded(input.scopeKey, "scopeKey");
	const subjectId = bounded(input.subjectId, "subjectId");
	const organizationId =
		input.organizationId === undefined
			? undefined
			: bounded(input.organizationId, "organizationId");
	if (!(["owner", "admin", "editor", "viewer"] as const).includes(input.role as never)) {
		throw new Error("role is invalid");
	}
	return { scopeKey, subjectId, organizationId, role: input.role };
}

export function assertEditor(role: string) {
	if (role !== "owner" && role !== "admin" && role !== "editor") {
		throw new Error("Extension write forbidden");
	}
}

export function assertName(value: string, label: string): string {
	if (!NAME.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export function assertMetadataLabel(value: string, label: string, allowEmpty = false): string {
	const normalized = value.trim();
	if ((allowEmpty && normalized === "") || UI_LABEL.test(normalized)) return normalized;
	throw new Error(`${label} must be a bounded non-sensitive UI label`);
}

export function assertManifest(manifest: {
	slots: string[];
	requestedActions: string[];
	requestedCommands: string[];
	storageScopes: string[];
}) {
	for (const [label, values] of Object.entries(manifest)) {
		if (values.length > 32 || new Set(values).size !== values.length) {
			throw new Error(`${label} is invalid`);
		}
		for (const value of values) {
			if (label === "storageScopes") {
				if (value !== "user" && value !== "organization") {
					throw new Error("storageScopes is invalid");
				}
			} else assertName(value, label);
		}
	}
}

/** Component-boundary enforcement of the canonical purpose-typed contract. */
export function assertPurposeTypedData(value: unknown) {
	assertPurposeTypedDurableContent(value);
}

async function hashContent(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

export async function assertInertRevision(input: {
	content: string;
	contentHash: string;
	summary?: string;
	renderPolicy: { mode: string; sandbox: string[]; csp: string };
}) {
	if (
		!HASH.test(input.contentHash) ||
		new TextEncoder().encode(input.content).byteLength > MAX_CONTENT_BYTES ||
		SECRET_VALUE.test(input.content) ||
		input.contentHash !== (await hashContent(input.content))
	) {
		throw new Error("Extension revision content is unsafe");
	}
	const content = input.content.trim();
	if (!content.startsWith("<") || !content.endsWith(">")) {
		throw new Error("Extension content must be inert markup");
	}
	const tags = content.match(/<[^>]*>/g) ?? [];
	if (
		tags.some((tag) => {
			const body = tag.slice(1, -1).trim();
			return body.startsWith("/")
				? !/^\/[A-Za-z][A-Za-z0-9-]*$/.test(body)
				: !/^[A-Za-z][A-Za-z0-9-]*\/?$/.test(body);
		})
	) {
		throw new Error("Extension markup attributes and directives are forbidden");
	}
	const text = content
		.replace(/<[^>]*>/g, "\n")
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
	if (text.some((item) => !UI_LABEL.test(item) || FINANCIAL_IDENTIFIER.test(item))) {
		throw new Error("Extension markup contains unsafe text");
	}
	if (
		input.summary !== undefined &&
		(!UI_LABEL.test(input.summary) || FINANCIAL_IDENTIFIER.test(input.summary))
	) {
		throw new Error("Extension summary is unsafe");
	}
	if (
		input.renderPolicy.mode !== "inert-text" ||
		input.renderPolicy.sandbox.length !== 0 ||
		input.renderPolicy.csp !== INERT_CSP
	) {
		throw new Error("Extension render policy must be fixed and inert");
	}
}

export function storagePrincipal(input: {
	storageScope: "user" | "organization";
	subjectId: string;
	organizationId?: string;
}) {
	if (input.storageScope === "user") return `user:${input.subjectId}`;
	if (!input.organizationId) throw new Error("Verified organization scope is required");
	return `organization:${input.organizationId}`;
}
