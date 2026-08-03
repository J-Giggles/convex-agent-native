import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isIgnored(relativePath) {
	const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", relativePath], {
		cwd: repositoryRoot,
	});
	assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed for ${relativePath}`);
	return result.status === 0;
}

test("repository excludes credentials and generated outputs without excluding public inputs", () => {
	for (const generatedOrSecret of [
		".env",
		"demo/.env.local",
		"demo/dist/index.html",
		"demo/node_modules/.modules.yaml",
		"coverage/coverage-final.json",
		"demo/test-results/results.json",
	]) {
		assert.equal(isIgnored(generatedOrSecret), true, `${generatedOrSecret} must be ignored`);
	}

	for (const publicInput of ["demo/.env.example", "pnpm-lock.yaml"]) {
		assert.equal(isIgnored(publicInput), false, `${publicInput} must remain trackable`);
	}
});

test("dependency installs are pinned and frozen across every workspace", async () => {
	const [
		rootPackageSource,
		demoPackageSource,
		examplePackageSource,
		workspaceSource,
		lockSource,
		ciSource,
	] =
		await Promise.all(
			[
				"package.json",
				"demo/package.json",
				"example/package.json",
				"pnpm-workspace.yaml",
				"pnpm-lock.yaml",
				".github/workflows/ci.yml",
			].map((relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8")),
		);
	const rootPackage = JSON.parse(rootPackageSource);
	const demoPackage = JSON.parse(demoPackageSource);
	const examplePackage = JSON.parse(examplePackageSource);

	assert.equal(rootPackage.packageManager, "pnpm@10.24.0");
	assert.ok(
		rootPackage.files.includes("!scripts/**/*.test.mjs"),
		"repository-only script tests must not enter the public package",
	);
	assert.deepEqual(
		rootPackage.pnpm?.onlyBuiltDependencies,
		["better-sqlite3"],
		"only the reviewed root SQLite test binding may run lifecycle scripts",
	);
	assert.doesNotMatch(workspaceSource, /exclude:/);
	for (const workspace of ['"."', '"demo"', '"example"']) {
		assert.match(workspaceSource, new RegExp(`- ${workspace.replaceAll(".", "\\.")}`));
	}
	for (const importer of ["  .:", "  demo:", "  example:"]) {
		assert.match(lockSource, new RegExp(`^${importer}`, "m"));
	}
	for (const [name, version] of Object.entries(demoPackage.devDependencies)) {
		assert.notEqual(version, "latest", `${name} must be pinned`);
	}
	for (const workspacePackage of [demoPackage, examplePackage]) {
		assert.equal(
			workspacePackage.dependencies["@giggabit/agent-native-convex"],
			"link:..",
			`${workspacePackage.name} must resolve clean package builds through the live workspace link`,
		);
	}
	assert.match(ciSource, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.doesNotMatch(ciSource, /npm install --ignore-scripts --no-package-lock/);
});

test("DEP-I-002: demo deployment rebuilds package subpath artifacts from a clean checkout", async () => {
	const demoPackage = JSON.parse(
		await readFile(path.join(repositoryRoot, "demo/package.json"), "utf8"),
	);

	assert.equal(demoPackage.scripts.predeploy, "pnpm --dir .. build");
	assert.equal(demoPackage.scripts.deploy, "convex deploy --typecheck enable");
});
