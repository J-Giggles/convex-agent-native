import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/pages.yml", import.meta.url);

async function workflowSource() {
	return readFile(workflowUrl, "utf8");
}

test("DEP-N-001: Pages publishes only the demo/dist static artifact", async () => {
	const source = await workflowSource();

	assert.match(source, /workflow_run:\n\s+workflows:\s*\[ci\]\n\s+types:\s*\[completed\]/);
	assert.match(
		source,
		/if:\s*github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_repository\.full_name == github\.repository && github\.event\.workflow_run\.head_branch == 'main'/,
	);
	assert.match(source, /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
	assert.match(source, /pnpm install --frozen-lockfile/);
	assert.match(source, /pnpm run build/);
	assert.match(source, /pnpm --dir demo test/);
	assert.match(source, /pnpm --dir demo run build/);
	assert.match(source, /cache-dependency-path:\s*pnpm-lock\.yaml/);
	assert.match(source, /path:\s*demo\/dist/);
	assert.match(source, /persist-credentials: false/);
	assert.match(source, /actions\/deploy-pages@[0-9a-f]{40}/);
	assert.doesNotMatch(source, /(?:pull_request|workflow_dispatch|push):/);
	assert.doesNotMatch(source, /run:\s+npm(?:\s|$)|npm --prefix/);
});

test("DEP-F-001: publish fails closed without approved HTTPS Convex endpoints", async () => {
	const source = await workflowSource();

	assert.match(source, /DEMO_CONVEX_URL:\s*\$\{\{ vars\.DEMO_CONVEX_URL \}\}/);
	assert.match(
		source,
		/DEMO_CONVEX_SITE_URL:\s*\$\{\{ vars\.DEMO_CONVEX_SITE_URL \}\}/,
	);
	assert.match(source, /VITE_CONVEX_URL:\s*\$\{\{ vars\.DEMO_CONVEX_URL \}\}/);
	assert.match(
		source,
		/VITE_CONVEX_SITE_URL:\s*\$\{\{ vars\.DEMO_CONVEX_SITE_URL \}\}/,
	);
	assert.match(source, /VITE_BASE_PATH:\s*\/convex-agent-native\//);
	assert.match(source, /node scripts\/verify-demo-deployment\.mjs/);
});

test("DEP-I-001: deploy authority is isolated and reproducible", async () => {
	const source = await workflowSource();

	assert.match(source, /^permissions:\n\s+contents: read$/m);
	assert.match(source, /deploy:\n\s+needs: build/);
	assert.match(source, /permissions:\n\s+pages: write\n\s+id-token: write/);
	assert.match(source, /environment:\n\s+name: github-pages/);
	assert.match(source, /concurrency:\n\s+group: pages\n\s+cancel-in-progress: true/);
	assert.match(
		source,
		/node scripts\/verify-demo-deployment\.mjs --manifest demo\/dist\/deployment-manifest\.json --source-revision "\$\{\{ github\.event\.workflow_run\.head_sha \}\}"/,
	);
	assert.equal(
		source.split(
			'git ls-remote --exit-code "https://github.com/${GITHUB_REPOSITORY}.git" refs/heads/main',
		).length - 1,
		2,
		"current main tip must be checked before build and immediately before deploy",
	);
	assert.equal(
		source.split(
			'test "$current_main_sha" = "${{ github.event.workflow_run.head_sha }}"',
		).length - 1,
		2,
		"both jobs must reject a stale verified revision",
	);

	const actionReferences = [...source.matchAll(/uses:\s+[^\s]+@([^\s#]+)/g)].map(
		([, revision]) => revision,
	);
	assert.ok(actionReferences.length >= 5);
	assert.ok(actionReferences.every((revision) => /^[0-9a-f]{40}$/.test(revision)));
});
