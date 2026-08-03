import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CVX-I-001 keeps every Convex entry graph independent of upstream SQL runtime modules", async () => {
	const [actions, http, httpActions, chatStorage, chatAction] = await Promise.all([
		readFile(new URL("../demo/convex/actions.ts", import.meta.url), "utf8"),
		readFile(new URL("../demo/convex/http.ts", import.meta.url), "utf8"),
		readFile(new URL("../demo/convex/httpActions.ts", import.meta.url), "utf8"),
		readFile(new URL("../demo/convex/chat.ts", import.meta.url), "utf8"),
		readFile(new URL("../demo/convex/chatAction.ts", import.meta.url), "utf8"),
	]);

	assert.equal(actions.startsWith('"use node";'), false);
	assert.equal(http.startsWith('"use node";'), false);
	assert.equal(httpActions.startsWith('"use node";'), false);
	assert.equal(chatAction.startsWith('"use node";'), false);
	for (const source of [actions, http, httpActions, chatStorage, chatAction]) {
		assert.doesNotMatch(source, /from\s+["']@agent-native\/core(?:\/action)?["']/u);
	}
	assert.doesNotMatch(chatStorage, /executeDemoAction|\.\.\/actions\/task-actions/u);
});

test("CVX-N-001 publishes narrow runtime-safe action and scope contract subpaths", async () => {
	const packageJson = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(packageJson.exports["./action"].default, "./dist/action/index.js");
	assert.equal(packageJson.exports["./contracts"].default, "./dist/contracts/index.js");
});
