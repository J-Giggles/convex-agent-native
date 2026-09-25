#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cleanBuild, verifyDist } from "./build.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const packOnly = process.argv.includes("--pack-only");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		encoding: "utf8",
		env: { ...process.env, ...(options.env ?? {}) },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
	}
	return result.stdout.trim();
}

async function walk(root, relative = "") {
	const entries = await readdir(path.join(root, relative), { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await walk(root, child)));
		else if (entry.isFile()) files.push(child);
	}
	return files;
}

async function writeConsumerManifest(root, name) {
	await mkdir(root);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }),
	);
}

async function installInventory(root) {
	const files = await walk(path.join(root, "node_modules"));
	let bytes = 0;
	for (const file of files) bytes += (await lstat(path.join(root, "node_modules", file))).size;
	return { files: files.length, bytes };
}

function assertMinimalAudit(root) {
	const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	const audit = JSON.parse(result.stdout);
	const vulnerabilities = audit.metadata?.vulnerabilities ?? {};
	assert.equal(vulnerabilities.high ?? 0, 0, "minimal closure has a high advisory");
	assert.equal(vulnerabilities.critical ?? 0, 0, "minimal closure has a critical advisory");
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-native-convex-release-"));
try {
	await cleanBuild();
	await verifyDist();
	const packJson = JSON.parse(
		run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot]),
	)[0];
	assert.ok(
		packJson?.filename && Array.isArray(packJson.files),
		"npm pack returned no archive inventory",
	);
	const archivePath = path.join(temporaryRoot, packJson.filename);
	const unpackRoot = path.join(temporaryRoot, "unpacked");
	await mkdir(unpackRoot);
	run("tar", ["-xzf", archivePath, "-C", unpackRoot]);
	const archiveFiles = (await walk(path.join(unpackRoot, "package"))).sort();
	const reportedFiles = packJson.files.map((file) => file.path).sort();
	assert.deepEqual(
		archiveFiles,
		reportedFiles,
		"archive contents differ from npm's pack inventory",
	);
	for (const relativePath of archiveFiles) {
		const [packed, source] = await Promise.all([
			readFile(path.join(unpackRoot, "package", relativePath)),
			readFile(path.join(packageRoot, relativePath)),
		]);
		assert.deepEqual(packed, source, `archive content drift: ${relativePath}`);
	}
	for (const required of [
		"CHANGELOG.md",
		"CODE_OF_CONDUCT.md",
		"CONTRIBUTING.md",
		"dist/BUILD_MANIFEST.json",
		"docs/compatibility.md",
		"docs/getting-started.md",
		"LICENSE",
		"README.md",
		"SECURITY.md",
		"SUPPORT.md",
		"THIRD_PARTY_NOTICES.md",
	]) {
		assert.ok(archiveFiles.includes(required), `archive is missing ${required}`);
	}
	assert.ok(!archiveFiles.some((file) => /\.test\.|\.(?:map|tgz|tsbuildinfo)$/u.test(file)));
	process.stdout.write(
		`pack verified: ${archiveFiles.length} files ${packJson.integrity} ${packJson.shasum}\n`,
	);
	if (!packOnly) {
		const minimalRoot = path.join(temporaryRoot, "minimal-consumer");
		await writeConsumerManifest(minimalRoot, "minimal-release-consumer");
		run(
			"npm",
			["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
			{ cwd: minimalRoot },
		);
		const minimalPackage = path.join(minimalRoot, "node_modules", ...packageJson.name.split("/"));
		run(
			process.execPath,
			[path.join(minimalPackage, "scripts/verify-exports.mjs"), "all-exports.mjs", "--minimal"],
			{ cwd: minimalRoot, env: { PACKAGE_NAME: packageJson.name } },
		);
		process.stdout.write(`${run(process.execPath, ["all-exports.mjs"], { cwd: minimalRoot })}\n`);
		const minimalSbomPath = path.join(temporaryRoot, "minimal-SBOM.spdx.json");
		process.stdout.write(
			`${run(process.execPath, [path.join(minimalPackage, "scripts/analyze-install.mjs"), minimalRoot, minimalSbomPath])}\n`,
		);
		assertMinimalAudit(minimalRoot);
		const minimalSbom = JSON.parse(await readFile(minimalSbomPath, "utf8"));
		const minimalInventory = await installInventory(minimalRoot);
		process.stdout.write(
			`minimal consumer closure verified without optional peers: ${minimalSbom.packages.length} packages, ${minimalInventory.files} files, ${minimalInventory.bytes} bytes\n`,
		);

		const compatibilityRoot = path.join(temporaryRoot, "compatibility-consumer");
		await writeConsumerManifest(compatibilityRoot, "compatibility-release-consumer");
		const compatibilityPeers = {
			"@agent-native/core": "0.189.0",
			"@convex-dev/agent": "0.6.4",
			convex: "1.43.0",
			"drizzle-orm": "0.45.2",
			react: process.env.REACT_VERSION ?? "19.2.7",
			"react-dom": process.env.REACT_VERSION ?? "19.2.7",
			typescript: "5.9.3",
		};
		run(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				archivePath,
				...Object.entries(compatibilityPeers).map(([name, version]) => `${name}@${version}`),
			],
			{ cwd: compatibilityRoot },
		);
		const installedPackage = path.join(
			compatibilityRoot,
			"node_modules",
			...packageJson.name.split("/"),
		);
		run(
			process.execPath,
			[path.join(installedPackage, "scripts/verify-exports.mjs"), "all-exports.mjs"],
			{ cwd: compatibilityRoot, env: { PACKAGE_NAME: packageJson.name } },
		);
		process.stdout.write(
			`${run(process.execPath, ["all-exports.mjs"], { cwd: compatibilityRoot })}\n`,
		);
		run(
			process.execPath,
			[path.join(installedPackage, "scripts/verify-types.mjs"), "all-exports.ts"],
			{ cwd: compatibilityRoot, env: { PACKAGE_NAME: packageJson.name } },
		);
		await writeFile(
			path.join(compatibilityRoot, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					skipLibCheck: true,
					resolveJsonModule: true,
				},
				include: ["all-exports.ts"],
			}),
		);
		run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], {
			cwd: compatibilityRoot,
		});
		const fullSbomPath = path.join(temporaryRoot, "compatibility-SBOM.spdx.json");
		process.stdout.write(
			`${run(process.execPath, [path.join(installedPackage, "scripts/analyze-install.mjs"), compatibilityRoot, fullSbomPath])}\n`,
		);
		process.stdout.write(
			`${run(process.execPath, [path.join(installedPackage, "scripts/verify-advisories.mjs"), compatibilityRoot])}\n`,
		);
		const fullSbom = JSON.parse(await readFile(fullSbomPath, "utf8"));
		const fullInventory = await installInventory(compatibilityRoot);
		process.stdout.write(
			`optional compatibility peer closure verified without legacy peer resolution: ${fullSbom.packages.length} packages, ${fullInventory.files} files, ${fullInventory.bytes} bytes; Node ${process.versions.node}, React ${compatibilityPeers.react}, lifecycle scripts disabled\n`,
		);
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
	await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
}
