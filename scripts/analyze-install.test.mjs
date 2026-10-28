import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./analyze-install.mjs", import.meta.url));

test("license scan accepts the reviewed compound expression without widening other gates", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "agent-native-license-policy-"));
	try {
		const dependencyRoot = path.join(root, "node_modules", "fixture");
		await mkdir(dependencyRoot, { recursive: true });
		for (const { license, scripts, accepted, error } of [
			{ license: "MIT", accepted: true },
			{ license: "MIT AND ISC AND BSD-3-Clause", accepted: true },
			{
				license: "MIT AND ISC AND GPL-3.0-only",
				accepted: false,
				error: /unaccepted license: fixture@1\.0\.0: MIT AND ISC AND GPL-3\.0-only/,
			},
			{
				license: "MIT AND ISC AND BSD-3-Clause AND UNKNOWN",
				accepted: false,
				error: /unaccepted license: fixture@1\.0\.0/,
			},
			{
				license: "MIT AND ISC AND BSD-3-Clause",
				scripts: { postinstall: "node install.js" },
				accepted: false,
				error: /unreviewed lifecycle script: fixture@1\.0\.0 postinstall/,
			},
		]) {
			await writeFile(
				path.join(dependencyRoot, "package.json"),
				JSON.stringify({ name: "fixture", version: "1.0.0", license, scripts }),
			);
			const result = spawnSync(process.execPath, [scriptPath, root], { encoding: "utf8" });
			assert.ifError(result.error);
			assert.equal(result.status, accepted ? 0 : 1, `${license}: ${result.stderr}`);
			if (accepted) assert.match(result.stdout, /SBOM\/license closure verified/);
			else assert.match(result.stderr, error);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
