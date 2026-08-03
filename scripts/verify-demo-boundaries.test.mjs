import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDemoBoundaryViolations } from "./verify-demo-boundaries.mjs";

const temporaryRoots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
	);
});

async function demoFixture(files) {
	const root = await mkdtemp(path.join(os.tmpdir(), "convex-demo-boundaries-"));
	temporaryRoots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = path.join(root, "demo", relativePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents, "utf8");
	}
	return root;
}

test("PST-N-001 accepts a Convex-only demo", async () => {
	const root = await demoFixture({
		"src/convexDemoClient.ts": [
			'const capability = sessionStorage.getItem("convex-agent-native.demo-capability.v1");',
			'if (capability) sessionStorage.setItem("convex-agent-native.demo-capability.v1", capability);',
		].join("\n"),
		"src/documentation.ts": [
			'const migrationNote = \'Do not import "drizzle-orm" or use localStorage.\';',
			'// import "better-sqlite3"; caches.open("old");',
			"/* document.cookie and navigator.storage are intentionally forbidden. */",
			"void migrationNote;",
		].join("\n"),
		"src/tasks.ts": [
			'import { useQuery } from "convex/react";',
			'import { defineAction } from "@agent-native/core";',
			"void useQuery;",
			"void defineAction;",
		].join("\n"),
	});

	assert.deepEqual(await findDemoBoundaryViolations(root), []);
});

test("PST-F-001 refuses SQL and Drizzle imports in the demo", async () => {
	const root = await demoFixture({
		"src/database.ts": [
			'import { drizzle } from "drizzle-orm/better-sqlite3";',
			'import Database from "better-sqlite3";',
			"void drizzle;",
			"void Database;",
		].join("\n"),
	});

	assert.deepEqual(await findDemoBoundaryViolations(root), [
		"demo/src/database.ts: forbidden persistence import drizzle-orm/better-sqlite3",
		"demo/src/database.ts: forbidden persistence import better-sqlite3",
	]);
});

test("PST-F-001 closes hidden, CommonJS, and package-owned Drizzle bypasses", async () => {
	const root = await demoFixture({
		".hidden/database.ts": 'import "better-sqlite3";',
		"persistence.cts": 'require("sqlite3");',
		"src/adapter.ts": 'import "@giggabit/agent-native-convex/drizzle";',
	});

	assert.deepEqual(await findDemoBoundaryViolations(root), [
		"demo/.hidden/database.ts: forbidden persistence import better-sqlite3",
		"demo/persistence.cts: forbidden persistence import sqlite3",
		"demo/src/adapter.ts: forbidden persistence import @giggabit/agent-native-convex/drizzle",
	]);
});

test("PST-I-001 refuses durable browser storage in the demo", async () => {
	const root = await demoFixture({
		"package.json": JSON.stringify({
			dependencies: {
				"@prisma/client": "1.0.0",
			},
		}),
		"src/taskCache.ts": [
			'window.localStorage["setItem"]("tasks", JSON.stringify([]));',
			"const { indexedDB: taskDatabase } = globalThis;",
			'globalThis.caches.open("task-responses");',
			"void navigator.storage.getDirectory();",
			'document.cookie = "tasks=shadow-copy";',
		].join("\n"),
	});

	assert.deepEqual(await findDemoBoundaryViolations(root), [
		"demo/package.json: forbidden persistence dependency @prisma/client",
		"demo/src/taskCache.ts: forbidden durable browser storage localStorage",
		"demo/src/taskCache.ts: forbidden durable browser storage indexedDB",
		"demo/src/taskCache.ts: forbidden durable browser storage Cache API",
		"demo/src/taskCache.ts: forbidden durable browser storage OPFS",
		"demo/src/taskCache.ts: forbidden durable browser storage cookies",
	]);
});

test("PST-F-001 refuses session storage outside the anonymous capability adapter", async () => {
	const root = await demoFixture({
		"src/convexDemoClient.ts": 'sessionStorage.setItem("tasks", "shadow-copy");',
		"src/otherClient.ts":
			'sessionStorage.setItem("convex-agent-native.demo-capability.v1", "misplaced-capability");',
	});

	assert.deepEqual(await findDemoBoundaryViolations(root), [
		"demo/src/convexDemoClient.ts: forbidden durable browser storage sessionStorage",
		"demo/src/otherClient.ts: forbidden durable browser storage sessionStorage",
	]);
});

test("PST-I-001 keeps the real demo inside the Convex-only persistence boundary", async () => {
	assert.deepEqual(await findDemoBoundaryViolations(repositoryRoot), []);
});
