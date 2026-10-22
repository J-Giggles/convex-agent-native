import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	attachActionExecutionContext,
	readActionExecutionContext,
	type ActionRunContext,
} from "./index.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const corePackage = /^@agent-native\/core(?:\/|$)/;

describe("./action execution context binding", () => {
	it("CVX-N-030 exports attachActionExecutionContext from the ./action entry", () => {
		const context: ActionRunContext = { caller: "mcp", actionName: "list-contacts" };
		const bound = attachActionExecutionContext(context, { principalId: "user_1" });

		expect(bound).toBe(context);
		expect(readActionExecutionContext<{ principalId: string }>(bound)).toEqual({
			principalId: "user_1",
		});
		expect(Object.keys(bound)).not.toContain("executionContext");
		expect(() => attachActionExecutionContext(bound, { principalId: "user_2" })).toThrow();
	});
});

/**
 * Emits the public declarations and compiles a consumer against them without
 * `skipLibCheck` and without `@agent-native/core` installed. A public action
 * type that still leans on core then fails to resolve, or collapses to `any`.
 */
describe("public action type contract", () => {
	let workDir: string;
	let declarationDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(path.join(tmpdir(), "agent-native-convex-contract-"));
		declarationDir = path.join(workDir, "dist");
		const config = ts.getParsedCommandLineOfConfigFile(
			path.join(packageRoot, "tsconfig.build.json"),
			{},
			{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
		);
		if (!config) throw new Error("tsconfig.build.json could not be parsed");
		const program = ts.createProgram(config.fileNames, {
			...config.options,
			outDir: declarationDir,
			declaration: true,
			emitDeclarationOnly: true,
		});
		const emitted = program.emit();
		expect(emitted.emitSkipped).toBe(false);
	}, 120_000);

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("CVX-N-031 keeps @agent-native/core out of every declaration the ./action entry reaches", () => {
		const coreImports = bareImportsReachableFrom(path.join(declarationDir, "action/index.d.ts"))
			.filter(({ specifier }) => corePackage.test(specifier))
			.map(({ file, specifier }) => `${path.relative(declarationDir, file)} -> ${specifier}`);

		expect(coreImports).toEqual([]);
	});

	it("CVX-N-032 keeps @agent-native/core/action out of every exported declaration", () => {
		const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
			exports: Record<string, string | { types?: string }>;
		};
		const entries = Object.values(packageJson.exports)
			.map((target) => (typeof target === "string" ? undefined : target.types))
			.filter((types): types is string => types !== undefined)
			.map((types) => path.join(declarationDir, path.relative("dist", types)));
		const actionImports = entries
			.flatMap((entry) => bareImportsReachableFrom(entry))
			.filter(({ specifier }) => specifier.startsWith("@agent-native/core/action"))
			.map(({ file, specifier }) => `${path.relative(declarationDir, file)} -> ${specifier}`);

		expect([...new Set(actionImports)]).toEqual([]);
	});

	it("CVX-N-033 resolves every public action type to a real type without skipLibCheck or core", () => {
		const consumer = path.join(workDir, "consumer.ts");
		writeFileSync(
			consumer,
			`import type {
	ActionCaller,
	ActionDefinition,
	ActionPolicyContext,
	ActionRunContext,
	ActionSurface,
	ConvexActionDefinition,
	DefineConvexActionOptions,
	RegisteredAction,
	RegisterActionOptions,
} from "./dist/action/index.js";
import type {
	attachActionExecutionContext,
	defineConvexAction,
	readActionExecutionContext,
} from "./dist/action/index.js";

type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? "any" : "ok";

export const checks: Record<string, "ok"> = {
	actionCaller: null as unknown as NotAny<ActionCaller>,
	actionDefinition: null as unknown as NotAny<ActionDefinition<unknown, unknown>>,
	actionDefinitionRun: null as unknown as NotAny<ActionDefinition<unknown, unknown>["run"]>,
	actionDefinitionTool: null as unknown as NotAny<ActionDefinition<unknown, unknown>["tool"]>,
	actionDefinitionPublicAgent: null as unknown as NotAny<ActionDefinition<unknown, unknown>["publicAgent"]>,
	actionDefinitionAudit: null as unknown as NotAny<ActionDefinition<unknown, unknown>["audit"]>,
	actionDefinitionHttp: null as unknown as NotAny<ActionDefinition<unknown, unknown>["http"]>,
	actionDefinitionNeedsApproval: null as unknown as NotAny<ActionDefinition<unknown, unknown>["needsApproval"]>,
	actionRunContext: null as unknown as NotAny<ActionRunContext>,
	actionRunContextCaller: null as unknown as NotAny<ActionRunContext["caller"]>,
	actionPolicyContext: null as unknown as NotAny<ActionPolicyContext>,
	actionSurface: null as unknown as NotAny<ActionSurface>,
	convexActionDefinition: null as unknown as NotAny<ConvexActionDefinition<unknown, unknown>>,
	defineOptionsHttp: null as unknown as NotAny<DefineConvexActionOptions<never, unknown>["http"]>,
	registeredAction: null as unknown as NotAny<RegisteredAction["definition"]>,
	registerOptions: null as unknown as NotAny<RegisterActionOptions<unknown, unknown>>,
	attachContext: null as unknown as NotAny<Parameters<typeof attachActionExecutionContext>[0]>,
	readContext: null as unknown as NotAny<Parameters<typeof readActionExecutionContext>[0]>,
	defineAction: null as unknown as NotAny<ReturnType<typeof defineConvexAction>>,
};
`,
			"utf8",
		);

		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
			strict: true,
			exactOptionalPropertyTypes: true,
			skipLibCheck: false,
			noEmit: true,
			types: [],
		};
		const host = ts.createCompilerHost(options);
		// Resolve dependencies from this package, but never `@agent-native/core`.
		host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions) =>
			literals.map((literal) => {
				if (corePackage.test(literal.text)) return { resolvedModule: undefined };
				const fromFile = containingFile.startsWith(workDir)
					? path.join(packageRoot, "src", path.relative(workDir, containingFile))
					: containingFile;
				const local = literal.text.startsWith(".");
				return ts.resolveModuleName(
					literal.text,
					local ? containingFile : fromFile,
					compilerOptions,
					host,
					undefined,
					redirected,
				);
			});
		const program = ts.createProgram([consumer], options, host);
		const diagnostics = ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

		expect(diagnostics).toEqual([]);
	}, 120_000);
});

function bareImportsReachableFrom(entry: string): { file: string; specifier: string }[] {
	const seen = new Set<string>();
	const found: { file: string; specifier: string }[] = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022);
		for (const specifier of moduleSpecifiers(source)) {
			if (specifier.startsWith(".")) {
				queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".d.ts")));
			} else {
				found.push({ file, specifier });
			}
		}
	}
	return found;
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
	const specifiers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			specifiers.push(node.argument.literal.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return specifiers;
}
