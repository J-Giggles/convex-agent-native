#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const manifestPath = path.join(distRoot, "BUILD_MANIFEST.json");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function walk(root, relative = "") {
	const directory = path.join(root, relative);
	const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${child}`);
		if (entry.isDirectory()) files.push(...(await walk(root, child)));
		else if (entry.isFile()) files.push(child);
		else throw new Error(`unsupported filesystem entry: ${child}`);
	}
	return files;
}

async function digestFiles(root, paths) {
	const files = [];
	for (const relativePath of [...paths].sort()) {
		const bytes = await readFile(path.join(root, relativePath));
		files.push({ path: relativePath, sha256: sha256(bytes), size: bytes.length });
	}
	return files;
}

function treeDigest(files) {
	return sha256(files.map((file) => `${file.path}\0${file.sha256}\0${file.size}`).join("\n"));
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function collectExportTargets(value, targets = []) {
	if (typeof value === "string" && value.startsWith("./dist/")) targets.push(value.slice(2));
	else if (value && typeof value === "object") {
		for (const child of Object.values(value)) collectExportTargets(child, targets);
	}
	return targets;
}

function importsAgentNativeRuntime(source) {
	return /(?:\bfrom\s*|\bimport\s*\(\s*)["']@agent-native\/core(?:\/[^"']*)?["']/u.test(source);
}

async function buildInputs() {
	const sourcePaths = (await walk(path.join(packageRoot, "src"))).filter(
		(file) => !/\.test\.[cm]?[jt]sx?$/u.test(file),
	);
	const sourceFiles = await digestFiles(path.join(packageRoot, "src"), sourcePaths);
	const configFiles = await digestFiles(packageRoot, [
		"package.json",
		"tsconfig.build.json",
		"tsconfig.json",
	]);
	return [...configFiles, ...sourceFiles.map((file) => ({ ...file, path: `src/${file.path}` }))];
}

export async function verifyDist() {
	const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
	const buildManifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (buildManifest.schemaVersion !== 1) throw new Error("unsupported dist build manifest");
	if (treeDigest(await buildInputs()) !== buildManifest.inputTreeSha256) {
		throw new Error("dist is stale: source or build configuration changed");
	}

	const artifactPaths = (await walk(distRoot)).filter((file) => file !== "BUILD_MANIFEST.json");
	if (artifactPaths.some((file) => /\.test\.|\.(?:map|tsbuildinfo)$/u.test(file))) {
		throw new Error("dist contains tests, source maps, or compiler state");
	}
	for (const artifactPath of artifactPaths.filter((file) => file.endsWith(".js"))) {
		const runtime = await readFile(path.join(distRoot, artifactPath), "utf8");
		if (importsAgentNativeRuntime(runtime)) {
			throw new Error(`@agent-native/core leaked into runtime artifact: ${artifactPath}`);
		}
	}
	const artifacts = await digestFiles(distRoot, artifactPaths);
	if (
		JSON.stringify(artifacts) !== JSON.stringify(buildManifest.artifacts) ||
		treeDigest(artifacts) !== buildManifest.artifactTreeSha256
	) {
		throw new Error("dist contents differ from the clean-build manifest");
	}
	for (const target of new Set(collectExportTargets(packageJson.exports))) {
		const state = await lstat(path.join(packageRoot, target)).catch(() => null);
		if (!state?.isFile()) throw new Error(`package export target is missing: ${target}`);
	}
	return buildManifest;
}

export async function cleanBuild() {
	await rm(distRoot, { recursive: true, force: true });
	run(process.execPath, [
		path.join(packageRoot, "node_modules/typescript/bin/tsc"),
		"-p",
		"tsconfig.build.json",
	]);
	const inputs = await buildInputs();
	const artifactPaths = (await walk(distRoot)).filter((file) => file !== "BUILD_MANIFEST.json");
	for (const artifactPath of artifactPaths.filter((file) => file.endsWith(".js"))) {
		const runtime = await readFile(path.join(distRoot, artifactPath), "utf8");
		if (importsAgentNativeRuntime(runtime)) {
			throw new Error(`@agent-native/core leaked into runtime artifact: ${artifactPath}`);
		}
	}
	const artifacts = await digestFiles(distRoot, artifactPaths);
	const buildManifest = {
		schemaVersion: 1,
		generatedBy: "scripts/build.mjs",
		inputTreeSha256: treeDigest(inputs),
		artifactTreeSha256: treeDigest(artifacts),
		inputs,
		artifacts,
	};
	await mkdir(distRoot, { recursive: true });
	await writeFile(manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`, "utf8");
	await verifyDist();
	process.stdout.write(
		`clean build verified: ${artifacts.length} artifacts ${buildManifest.artifactTreeSha256}\n`,
	);
	return buildManifest;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
	if (process.argv.includes("--clean-only")) await rm(distRoot, { recursive: true, force: true });
	else await cleanBuild();
}
