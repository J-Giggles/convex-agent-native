#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(await readFile(path.join(scriptsRoot, "release-policy.json"), "utf8"));
const installRoot = path.resolve(process.argv[2] ?? ".");
const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
	cwd: installRoot,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
let audit;
try {
	audit = JSON.parse(result.stdout);
} catch {
	throw new Error(`npm audit did not return JSON:\n${result.stderr}\n${result.stdout}`);
}

const accepted = new Set(
	policy.unreachableHighAdvisories.map((item) => `${item.package}@${item.version}:${item.source}`),
);
const observed = new Set();
const violations = [];
for (const [packageName, vulnerability] of Object.entries(audit.vulnerabilities ?? {})) {
	for (const advisory of vulnerability.via ?? []) {
		if (!advisory || typeof advisory !== "object") continue;
		if (!["high", "critical"].includes(advisory.severity)) continue;
		for (const node of vulnerability.nodes ?? []) {
			const packageJson = JSON.parse(
				await readFile(path.join(installRoot, node, "package.json"), "utf8"),
			);
			const key = `${packageName}@${packageJson.version}:${advisory.source}`;
			observed.add(key);
			if (!accepted.has(key)) violations.push(key);
		}
	}
}
for (const expected of accepted) {
	if (!observed.has(expected)) {
		throw new Error(`stale advisory acceptance (remove or re-review): ${expected}`);
	}
}
if (violations.length) {
	throw new Error(`reachable or unreviewed high advisory:\n${violations.join("\n")}`);
}
process.stdout.write(
	`advisory gate passed: ${observed.size} exact high advisories accepted as unreachable; emitted runtime contains no @agent-native/core imports\n`,
);
