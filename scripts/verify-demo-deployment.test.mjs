import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	createDeploymentManifest,
	deploymentEnvironmentViolations,
} from "./verify-demo-deployment.mjs";

const validEnvironment = {
	DEMO_CONVEX_URL: "https://builder-demo.convex.cloud",
	DEMO_CONVEX_SITE_URL: "https://builder-demo.convex.site",
	VITE_BASE_PATH: "/convex-agent-native/",
	VITE_CONVEX_URL: "https://builder-demo.convex.cloud",
	VITE_CONVEX_SITE_URL: "https://builder-demo.convex.site",
};
const scriptPath = fileURLToPath(new URL("./verify-demo-deployment.mjs", import.meta.url));

test("DEP-N-001 accepts the dedicated HTTPS Convex and Pages build targets", () => {
	assert.deepEqual(deploymentEnvironmentViolations(validEnvironment), []);
});

test("DEP-F-001 refuses missing, unsafe, or mismatched deployment targets", () => {
	assert.deepEqual(deploymentEnvironmentViolations({}), [
		"DEMO_CONVEX_URL is required",
		"DEMO_CONVEX_SITE_URL is required",
		"VITE_CONVEX_URL is required",
		"VITE_CONVEX_SITE_URL is required",
		"VITE_BASE_PATH is required",
	]);

	assert.deepEqual(
		deploymentEnvironmentViolations({
			...validEnvironment,
			DEMO_CONVEX_URL: "http://builder-demo.convex.cloud/path?token=secret",
			DEMO_CONVEX_SITE_URL: "https://other-demo.convex.site/path",
			VITE_BASE_PATH: "/",
			VITE_CONVEX_URL: "https://different-demo.convex.cloud",
			VITE_CONVEX_SITE_URL: "https://other-demo.convex.site",
		}),
		[
			"DEMO_CONVEX_URL must be an HTTPS origin on *.convex.cloud without credentials, port, path, query, or fragment",
			"DEMO_CONVEX_SITE_URL must be a matching HTTPS origin on *.convex.site without credentials, port, path, query, or fragment",
			"VITE_CONVEX_URL must exactly match DEMO_CONVEX_URL",
			"VITE_CONVEX_SITE_URL must exactly match DEMO_CONVEX_SITE_URL",
			"VITE_BASE_PATH must equal /convex-agent-native/",
		],
	);
});

test("DEP-I-001 creates a reproducible secret-free deployment manifest", async () => {
	const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
	const expected = `${JSON.stringify(
		{
			schemaVersion: 1,
			sourceRevision,
			convexUrl: "https://builder-demo.convex.cloud",
			convexSiteUrl: "https://builder-demo.convex.site",
			demoUrl: "https://j-giggles.github.io/convex-agent-native/",
		},
		null,
		2,
	)}\n`;

	assert.equal(
		createDeploymentManifest(
			{ ...validEnvironment, GITHUB_TOKEN: "must-not-leak", CONVEX_DEPLOY_KEY: "secret-a" },
			sourceRevision,
		),
		expected,
	);
	assert.equal(
		createDeploymentManifest(
			{ ...validEnvironment, GITHUB_TOKEN: "different", CONVEX_DEPLOY_KEY: "secret-b" },
			sourceRevision,
		),
		expected,
	);

	const root = await mkdtemp(path.join(os.tmpdir(), "convex-demo-deployment-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"--manifest",
				"demo/dist/deployment-manifest.json",
				"--source-revision",
				sourceRevision,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, ...validEnvironment, GITHUB_TOKEN: "must-not-leak" },
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			await readFile(path.join(root, "demo/dist/deployment-manifest.json"), "utf8"),
			expected,
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
