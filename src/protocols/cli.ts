import type { CliAdapter, CliResult } from "@agent-native/core/adapters/cli";

import { sanitizeErrorMessage, sanitizePersistedValue } from "../action/sanitize.js";
import type { ActionClientRequest, ActionClientResult } from "../client/index.js";

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const CREDENTIAL_ARGUMENT =
	/^--?(?:authorization|bearer|token|access-token|api[-_]?key|password|secret)(?:=|$)/i;
const CREDENTIAL_KEY =
	/(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)$/i;

export interface ConvexActionCliAdapterOptions {
	invoke(request: ActionClientRequest): Promise<ActionClientResult>;
	available?: () => Promise<boolean>;
	readStdin?: () => Promise<string>;
	name?: string;
	description?: string;
	version?: string;
	maxOutputChars?: number;
}

interface ParsedActionCommand {
	actionName: string;
	inputSource: string;
	readFromStdin: boolean;
	idempotencyKey?: string;
}

function result(stderr: string, exitCode: number): CliResult {
	return { stdout: "", stderr: `${stderr}\n`, exitCode };
}

function usage(name: string): string {
	return `Usage: ${name} [action] <action-name> [json|--stdin] ` + `[--idempotency-key <key>]`;
}

function parseCommand(argv: readonly string[], name: string): ParsedActionCommand | CliResult {
	if (argv.some((arg) => CREDENTIAL_ARGUMENT.test(arg))) {
		return result("Credentials are not accepted in CLI arguments", 2);
	}

	const args = [...argv];
	if (args[0] === "action" || args[0] === "script") args.shift();
	const actionName = args.shift()?.trim();
	if (!actionName) return result(usage(name), 2);

	let inputSource = "{}";
	let inputSpecified = false;
	let readFromStdin = false;
	let idempotencyKey: string | undefined;

	if (args[0] === "--stdin" || args[0] === "-") {
		readFromStdin = true;
		args.shift();
	} else if (args[0] !== undefined && !args[0].startsWith("--")) {
		inputSource = args.shift()!;
		inputSpecified = true;
	}

	while (args.length > 0) {
		const arg = args.shift()!;
		if (arg === "--stdin") {
			if (inputSpecified || readFromStdin) {
				return result("Specify either JSON or --stdin, not both", 2);
			}
			readFromStdin = true;
			continue;
		}
		if (arg === "--idempotency-key") {
			const value = args.shift()?.trim();
			if (!value) return result("--idempotency-key requires a value", 2);
			idempotencyKey = value;
			continue;
		}
		if (arg.startsWith("--idempotency-key=")) {
			const value = arg.slice("--idempotency-key=".length).trim();
			if (!value) return result("--idempotency-key requires a value", 2);
			idempotencyKey = value;
			continue;
		}
		// Preserve the v0.1 positional idempotency-key shape.
		if (!arg.startsWith("--") && idempotencyKey === undefined && args.length === 0) {
			idempotencyKey = arg;
			continue;
		}
		return result(`Unknown argument: ${arg}`, 2);
	}

	return {
		actionName,
		inputSource,
		readFromStdin,
		...(idempotencyKey === undefined ? {} : { idempotencyKey }),
	};
}

function safeOutput(value: unknown, maxChars: number): string {
	const serialized = JSON.stringify(sanitizePersistedValue(value));
	const text = serialized ?? "null";
	if (text.length <= maxChars) return text;
	return JSON.stringify({
		truncated: true,
		preview: text.slice(0, Math.max(0, maxChars - 128)),
	});
}

function containsCredential(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsCredential);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).some(
		([key, entry]) => CREDENTIAL_KEY.test(key) || containsCredential(entry),
	);
}

/**
 * Runtime-neutral `CliAdapter` over the configured action client. The host owns
 * authentication and scope; this adapter deliberately has no credential flags.
 */
export class ConvexActionCliAdapter implements CliAdapter {
	readonly name: string;
	readonly description: string;
	readonly #version: string;
	readonly #invoke: ConvexActionCliAdapterOptions["invoke"];
	readonly #available: () => Promise<boolean>;
	readonly #readStdin: (() => Promise<string>) | undefined;
	readonly #maxOutputChars: number;

	constructor(options: ConvexActionCliAdapterOptions) {
		this.name = options.name ?? "agent-native-convex";
		this.description =
			options.description ?? "Independent Agent-Native compatibility actions over Convex";
		this.#version = options.version ?? "0.1.0";
		this.#invoke = options.invoke;
		this.#available = options.available ?? (async () => true);
		this.#readStdin = options.readStdin;
		this.#maxOutputChars = Math.max(
			1_024,
			Math.min(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 1024 * 1024),
		);
	}

	async isAvailable(): Promise<boolean> {
		try {
			return await this.#available();
		} catch {
			return false;
		}
	}

	async execute(args: string[]): Promise<CliResult> {
		if (args[0] === "--version") {
			return {
				stdout: `${this.name} ${this.#version}\n`,
				stderr: "",
				exitCode: 0,
			};
		}
		if (args[0] === "--help" || args[0] === "-h") {
			return { stdout: `${usage(this.name)}\n`, stderr: "", exitCode: 0 };
		}

		const parsed = parseCommand(args, this.name);
		if ("exitCode" in parsed) return parsed;

		let source = parsed.inputSource;
		if (parsed.readFromStdin) {
			if (!this.#readStdin) return result("Standard input is not configured", 2);
			try {
				source = await this.#readStdin();
			} catch {
				return result("Could not read standard input", 2);
			}
		}

		let input: unknown;
		try {
			input = JSON.parse(source);
		} catch {
			return result("Input must be valid JSON", 2);
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			return result("Input must be a JSON object", 2);
		}
		if (containsCredential(input)) {
			return result("Credentials are not accepted in CLI action input", 2);
		}

		try {
			const invocation = await this.#invoke({
				actionName: parsed.actionName,
				input,
				...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }),
			});
			return {
				stdout: `${safeOutput(invocation.result, this.#maxOutputChars)}\n`,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			return result(sanitizeErrorMessage(error), 1);
		}
	}
}
