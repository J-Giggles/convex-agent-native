#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredKeys = [
	"DEMO_CONVEX_URL",
	"DEMO_CONVEX_SITE_URL",
	"VITE_CONVEX_URL",
	"VITE_CONVEX_SITE_URL",
	"VITE_BASE_PATH",
];

function isConvexOrigin(value) {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === value &&
			url.port === "" &&
			/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.convex\.cloud$/u.test(url.hostname)
		);
	} catch {
		return false;
	}
}

function convexDeploymentName(value, suffix) {
	try {
		const url = new URL(value);
		const hostnamePattern = new RegExp(
			`^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.${suffix.replace(".", "\\.")}$`,
			"u",
		);
		const match = hostnamePattern.exec(url.hostname);
		if (url.protocol !== "https:" || url.origin !== value || url.port !== "" || !match) {
			return undefined;
		}
		return match[1];
	} catch {
		return undefined;
	}
}

export function deploymentEnvironmentViolations(environment) {
	const violations = [];
	for (const key of requiredKeys) {
		if (typeof environment[key] !== "string" || environment[key].trim() === "") {
			violations.push(`${key} is required`);
		}
	}
	if (violations.length > 0) return violations;

	if (!isConvexOrigin(environment.DEMO_CONVEX_URL)) {
		violations.push(
			"DEMO_CONVEX_URL must be an HTTPS origin on *.convex.cloud without credentials, port, path, query, or fragment",
		);
	}
	const deploymentName = convexDeploymentName(environment.DEMO_CONVEX_URL, "convex.cloud");
	const siteDeploymentName = convexDeploymentName(
		environment.DEMO_CONVEX_SITE_URL,
		"convex.site",
	);
	if (!siteDeploymentName || siteDeploymentName !== deploymentName) {
		violations.push(
			"DEMO_CONVEX_SITE_URL must be a matching HTTPS origin on *.convex.site without credentials, port, path, query, or fragment",
		);
	}
	if (environment.VITE_CONVEX_URL !== environment.DEMO_CONVEX_URL) {
		violations.push("VITE_CONVEX_URL must exactly match DEMO_CONVEX_URL");
	}
	if (environment.VITE_CONVEX_SITE_URL !== environment.DEMO_CONVEX_SITE_URL) {
		violations.push("VITE_CONVEX_SITE_URL must exactly match DEMO_CONVEX_SITE_URL");
	}
	if (environment.VITE_BASE_PATH !== "/convex-agent-native/") {
		violations.push("VITE_BASE_PATH must equal /convex-agent-native/");
	}
	return violations;
}

export function createDeploymentManifest(environment, sourceRevision) {
	const violations = deploymentEnvironmentViolations(environment);
	if (violations.length > 0) {
		throw new Error(`Invalid demo deployment configuration:\n${violations.join("\n")}`);
	}
	if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
		throw new Error("source revision must be a full lowercase Git commit SHA");
	}
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			sourceRevision,
			convexUrl: environment.DEMO_CONVEX_URL,
			convexSiteUrl: environment.DEMO_CONVEX_SITE_URL,
			demoUrl: `https://j-giggles.github.io${environment.VITE_BASE_PATH}`,
		},
		null,
		2,
	)}\n`;
}

const isMain = process.argv[1]
	? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
	: false;

if (isMain) {
	try {
		const violations = deploymentEnvironmentViolations(process.env);
		if (violations.length > 0) throw new Error(violations.join("\n"));

		const manifestIndex = process.argv.indexOf("--manifest");
		const revisionIndex = process.argv.indexOf("--source-revision");
		if (manifestIndex !== -1 || revisionIndex !== -1) {
			const manifestPath = process.argv[manifestIndex + 1];
			const sourceRevision = process.argv[revisionIndex + 1];
			if (manifestIndex === -1 || !manifestPath) {
				throw new Error("--manifest requires a destination under demo/dist");
			}
			if (revisionIndex === -1 || !sourceRevision) {
				throw new Error("--source-revision requires a full Git commit SHA");
			}
			const allowedRoot = path.resolve(process.cwd(), "demo/dist");
			const destination = path.resolve(process.cwd(), manifestPath);
			const relativeDestination = path.relative(allowedRoot, destination);
			if (
				relativeDestination.startsWith("..") ||
				path.isAbsolute(relativeDestination) ||
				relativeDestination === ""
			) {
				throw new Error("--manifest destination must be a file under demo/dist");
			}

			await mkdir(path.dirname(destination), { recursive: true });
			const temporaryPath = path.join(
				path.dirname(destination),
				`.${path.basename(destination)}.${process.pid}.tmp`,
			);
			try {
				await writeFile(
					temporaryPath,
					createDeploymentManifest(process.env, sourceRevision),
					{ encoding: "utf8", mode: 0o644 },
				);
				await rename(temporaryPath, destination);
			} finally {
				await rm(temporaryPath, { force: true });
			}
		}
		process.stdout.write("demo deployment configuration verified\n");
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "deployment verification failed"}\n`);
		process.exitCode = 1;
	}
}
