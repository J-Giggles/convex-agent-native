#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(await readFile(path.join(scriptsRoot, "release-policy.json"), "utf8"));
const installRoot = path.resolve(process.argv[2] ?? ".");
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const lifecycleNames = ["preinstall", "install", "postinstall"];

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function licenseExpression(packageJson) {
	if (typeof packageJson.license === "string" && packageJson.license.trim()) {
		return packageJson.license.trim();
	}
	if (packageJson.license && typeof packageJson.license.type === "string") {
		return packageJson.license.type.trim();
	}
	return "UNKNOWN";
}

async function packageDirectories(nodeModulesRoot) {
	const entries = await readdir(nodeModulesRoot, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const directories = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name === ".bin" || !entry.isDirectory()) continue;
		if (entry.name.startsWith("@")) {
			const scoped = await readdir(path.join(nodeModulesRoot, entry.name), { withFileTypes: true });
			for (const child of scoped.sort((left, right) => left.name.localeCompare(right.name))) {
				if (child.isDirectory())
					directories.push(path.join(nodeModulesRoot, entry.name, child.name));
			}
		} else {
			directories.push(path.join(nodeModulesRoot, entry.name));
		}
	}
	return directories;
}

async function collectPackages(root, found = new Map()) {
	for (const directory of await packageDirectories(path.join(root, "node_modules"))) {
		const manifestPath = path.join(directory, "package.json");
		const state = await lstat(manifestPath).catch(() => null);
		if (!state?.isFile()) continue;
		const packageJson = JSON.parse(await readFile(manifestPath, "utf8"));
		const key = `${packageJson.name}@${packageJson.version}`;
		if (!found.has(key)) {
			const lifecycleScripts = Object.fromEntries(
				lifecycleNames
					.filter((name) => typeof packageJson.scripts?.[name] === "string")
					.map((name) => [name, packageJson.scripts[name]]),
			);
			found.set(key, {
				name: packageJson.name,
				version: packageJson.version,
				license: licenseExpression(packageJson),
				lifecycleScripts,
			});
		}
		await collectPackages(directory, found);
	}
	return found;
}

const packages = [...(await collectPackages(installRoot)).values()].sort((left, right) =>
	`${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
const licenseViolations = [];
for (const dependency of packages) {
	if (policy.allowedLicenses.includes(dependency.license)) continue;
	const accepted = policy.residualLicenseAcceptances.some(
		(item) =>
			item.license === dependency.license &&
			new RegExp(item.packagePattern, "u").test(dependency.name),
	);
	if (!accepted)
		licenseViolations.push(`${dependency.name}@${dependency.version}: ${dependency.license}`);
}

const lifecycleScripts = packages
	.flatMap((dependency) =>
		Object.entries(dependency.lifecycleScripts).map(([stage, command]) => ({
			package: `${dependency.name}@${dependency.version}`,
			stage,
			commandSha256: sha256(command),
		})),
	)
	.sort((left, right) =>
		`${left.package}:${left.stage}`.localeCompare(`${right.package}:${right.stage}`),
	);
const allowedLifecycle = new Set(
	policy.allowedLifecycleScripts.map(
		(item) => `${item.package}:${item.stage}:${item.commandSha256}`,
	),
);
const lifecycleViolations = lifecycleScripts.filter(
	(item) => !allowedLifecycle.has(`${item.package}:${item.stage}:${item.commandSha256}`),
);

const spdxPackages = packages.map((dependency, index) => ({
	SPDXID: `SPDXRef-Package-${index + 1}`,
	name: dependency.name,
	versionInfo: dependency.version,
	downloadLocation: "NOASSERTION",
	filesAnalyzed: false,
	licenseConcluded: dependency.license,
	licenseDeclared: dependency.license,
}));
const report = {
	spdxVersion: "SPDX-2.3",
	dataLicense: "CC0-1.0",
	SPDXID: "SPDXRef-DOCUMENT",
	name: "agent-native-convex-full-peer-install",
	documentNamespace: `https://spdx.invalid/agent-native-convex/${sha256(
		packages.map((item) => `${item.name}@${item.version}:${item.license}`).join("\n"),
	)}`,
	creationInfo: {
		created: "2000-01-01T00:00:00Z",
		creators: ["Tool: scripts/analyze-install.mjs"],
	},
	packages: spdxPackages,
	annotations: [
		{
			annotationType: "OTHER",
			annotator: "Tool: scripts/analyze-install.mjs",
			annotationDate: "2000-01-01T00:00:00Z",
			comment: `Lifecycle scripts were disabled during installation; ${lifecycleScripts.length} declared lifecycle scripts were reviewed by exact package, stage, and command digest.`,
		},
	],
};
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serializedReport, "utf8");
if (licenseViolations.length || lifecycleViolations.length) {
	throw new Error(
		[
			...licenseViolations.map((item) => `unaccepted license: ${item}`),
			...lifecycleViolations.map(
				(item) =>
					`unreviewed lifecycle script: ${item.package} ${item.stage} ${item.commandSha256}`,
			),
		].join("\n"),
	);
}
process.stdout.write(
	`SBOM/license closure verified: ${packages.length} packages, ${lifecycleScripts.length} disabled lifecycle scripts, sha256 ${sha256(serializedReport)}\n`,
);
