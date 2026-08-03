#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cleanBuild, verifyDist } from "./build.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		encoding: "utf8",
		env: { ...process.env, CI: "1", ...(options.env ?? {}) },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
	}
	return result.stdout.trim();
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-native-convex-consumer-"));
try {
	await cleanBuild();
	await verifyDist();
	const packed = JSON.parse(
		run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot]),
	)[0];
	assert.ok(packed?.filename, "npm pack returned no archive");
	const archivePath = path.join(temporaryRoot, packed.filename);
	const consumerRoot = path.join(temporaryRoot, "consumer");
	const convexRoot = path.join(consumerRoot, "convex");
	await mkdir(convexRoot, { recursive: true });
	await writeFile(
		path.join(consumerRoot, "package.json"),
		JSON.stringify({
			name: "standalone-convex-agent-native-consumer",
			version: "1.0.0",
			private: true,
			type: "module",
			dependencies: {
				[packageJson.name]: `file:${archivePath}`,
				"@convex-dev/agent": "0.6.4",
				convex: "1.43.0",
				typescript: "5.9.3",
			},
		}),
	);
	await writeFile(
		path.join(convexRoot, "convex.config.ts"),
		`import agentNative from "${packageJson.name}/convex.config.js";\n` +
			'import { defineApp } from "convex/server";\n\n' +
			"const app = defineApp();\n" +
			"app.use(agentNative, {\n" +
			'  name: "agentNative",\n' +
			'  env: { HOST_SCOPE_POLICY: "host-derived-v1" },\n' +
			"});\n" +
			"export default app;\n",
	);
	await writeFile(
		path.join(convexRoot, "agentNative.ts"),
		`import { resolveActionScope } from "${packageJson.name}";\n` +
			`import { createConvexPersistence } from "${packageJson.name}/convex";\n` +
			'import { components } from "./_generated/api";\n' +
			'import { action } from "./_generated/server";\n\n' +
			"export const ready = action({\n" +
			"  args: {},\n" +
			"  handler: async (ctx) => {\n" +
			"    const scope = resolveActionScope({\n" +
			'      scopeKey: "consumer:release-gate",\n' +
			'      subjectId: "release-gate",\n' +
			"    });\n" +
			"    createConvexPersistence(ctx, components.agentNative, scope);\n" +
			"    return { agentNative: true };\n" +
			"  },\n" +
			"});\n",
	);
	await writeFile(
		path.join(convexRoot, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				allowJs: true,
				strict: true,
				moduleResolution: "Bundler",
				skipLibCheck: true,
				allowSyntheticDefaultImports: true,
				target: "ESNext",
				lib: ["ES2023", "dom"],
				forceConsistentCasingInFileNames: true,
				module: "ESNext",
				isolatedModules: true,
				noEmit: true,
			},
			include: ["./**/*"],
			exclude: ["./_generated"],
		}),
	);

	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerRoot });
	const convexCli = path.join(consumerRoot, "node_modules", ".bin", "convex");
	const output = run(
		convexCli,
		["dev", "--once", "--typecheck", "disable"],
		{ cwd: consumerRoot },
	);
	run(
		path.join(consumerRoot, "node_modules", ".bin", "tsc"),
		["--noEmit", "-p", path.join(convexRoot, "tsconfig.json")],
		{ cwd: consumerRoot },
	);
	const generatedApi = await readFile(path.join(convexRoot, "_generated", "api.d.ts"), "utf8");
	assert.match(
		generatedApi,
		/from "\.\.\/agentNative\.js"/u,
		"standalone consumer did not generate its action API",
	);
	assert.match(
		generatedApi,
		/ComponentApi<"agentNative">/u,
		"standalone consumer did not generate the agentNative component reference",
	);
	process.stdout.write(`${output}\n`);
	process.stdout.write(
		`standalone Convex consumer verified from ${packageJson.name}@${packageJson.version} tarball\n`,
	);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
	await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
}
