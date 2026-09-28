import { AgentNativeConvexError } from "../contracts/error.js";

export async function fingerprintActionInput(input: unknown): Promise<string> {
	return `sha256:${await sha256Hex(canonicalJson(input))}`;
}

/** Lower-case hex SHA-256 of a UTF-8 string, using the platform WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidInput();
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		const entries = Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
		return `{${entries.join(",")}}`;
	}
	return invalidInput();
}

function invalidInput(): never {
	throw new AgentNativeConvexError(
		"ACTION_INPUT_INVALID",
		"Action input must be a finite JSON value",
	);
}
