#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
]);
const ignoredDirectories = new Set([
	".convex",
	".vite",
	"coverage",
	"dist",
	"node_modules",
	"playwright-report",
	"test-results",
]);
const forbiddenPersistencePackages = [
	"@libsql/client",
	"@prisma/client",
	"@giggabit/agent-native-convex/drizzle",
	"better-sqlite3",
	"drizzle-orm",
	"fs",
	"mysql2",
	"node:fs",
	"pg",
	"postgres",
	"sequelize",
	"sql.js",
	"sqlite3",
	"typeorm",
];
const directStorageIdentifiers = new Map([
	["localStorage", "localStorage"],
	["indexedDB", "indexedDB"],
	["sessionStorage", "sessionStorage"],
	["caches", "Cache API"],
	["cookieStore", "cookies"],
]);
const allowedCapabilitySessionStorageMethods = new Set(["getItem", "removeItem", "setItem"]);

function isForbiddenPersistencePackage(specifier) {
	return forbiddenPersistencePackages.some(
		(packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
	);
}

function lexicalTokens(source) {
	const tokens = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		const next = source[index + 1];
		if (/\s/u.test(character)) {
			index += 1;
			continue;
		}
		if (character === "/" && next === "/") {
			index = source.indexOf("\n", index + 2);
			if (index === -1) break;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const quote = character;
			const start = index;
			let value = "";
			index += 1;
			while (index < source.length) {
				if (source[index] === "\\") {
					value += source.slice(index, index + 2);
					index += 2;
					continue;
				}
				if (source[index] === quote) {
					index += 1;
					break;
				}
				value += source[index];
				index += 1;
			}
			tokens.push({ kind: quote === "`" ? "template" : "string", value, index: start });
			continue;
		}
		if (/[A-Za-z_$]/u.test(character)) {
			const start = index;
			index += 1;
			while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) index += 1;
			tokens.push({ kind: "identifier", value: source.slice(start, index), index: start });
			continue;
		}
		tokens.push({ kind: "punctuation", value: character, index });
		index += 1;
	}
	return tokens;
}

function importedModuleSpecifiers(tokens) {
	const matches = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind !== "identifier") continue;
		if (token.value === "require") {
			if (tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
				matches.push(tokens[index + 2]);
			}
			continue;
		}
		if (token.value !== "import" && token.value !== "export") continue;
		if (tokens[index + 1]?.kind === "string") {
			matches.push(tokens[index + 1]);
			continue;
		}
		if (token.value === "import" && tokens[index + 1]?.value === "(") {
			if (tokens[index + 2]?.kind === "string") matches.push(tokens[index + 2]);
			continue;
		}
		for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
			if (tokens[cursor]?.value === ";") break;
			if (tokens[cursor]?.value === "from" && tokens[cursor + 1]?.kind === "string") {
				matches.push(tokens[cursor + 1]);
				break;
			}
		}
	}
	return matches.sort((left, right) => left.index - right.index).map(({ value }) => value);
}

function isAllowedCapabilitySessionStorageUse(tokens, index, relativeFile) {
	if (relativeFile.split(path.sep).join("/") !== "src/convexDemoClient.ts") return false;
	const method = tokens[index + 2];
	const key = tokens[index + 4];
	return (
		tokens[index + 1]?.value === "." &&
		method?.kind === "identifier" &&
		allowedCapabilitySessionStorageMethods.has(method.value) &&
		tokens[index + 3]?.value === "(" &&
		key?.kind === "string" &&
		key.value === "convex-agent-native.demo-capability.v1"
	);
}

function durableBrowserStorageNames(tokens, relativeFile) {
	const names = new Set();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.kind !== "identifier") continue;
		const directName = directStorageIdentifiers.get(token.value);
		if (
			directName &&
			(token.value !== "sessionStorage" ||
				!isAllowedCapabilitySessionStorageUse(tokens, index, relativeFile))
		) {
			names.add(directName);
		}
		let propertyIndex = index + 1;
		if (tokens[propertyIndex]?.value === "?") propertyIndex += 1;
		if (tokens[propertyIndex]?.value !== ".") continue;
		const property = tokens[propertyIndex + 1]?.value;
		if (token.value === "navigator" && property === "storage") names.add("OPFS");
		if (token.value === "document" && property === "cookie") names.add("cookies");
	}
	return ["localStorage", "indexedDB", "sessionStorage", "Cache API", "OPFS", "cookies"].filter(
		(name) => names.has(name),
	);
}

async function sourceFiles(root, relative = "") {
	const directory = path.join(root, relative);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}

	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (ignoredDirectories.has(entry.name)) continue;
		const child = relative ? path.join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) files.push(...(await sourceFiles(root, child)));
		else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(child);
	}
	return files;
}

export async function findDemoBoundaryViolations(repositoryRoot) {
	const demoRoot = path.join(repositoryRoot, "demo");
	const files = await sourceFiles(demoRoot);
	const violations = [];
	try {
		const packageJson = JSON.parse(await readFile(path.join(demoRoot, "package.json"), "utf8"));
		for (const dependencyGroup of [
			packageJson.dependencies,
			packageJson.devDependencies,
			packageJson.optionalDependencies,
			packageJson.peerDependencies,
		]) {
			for (const packageName of Object.keys(dependencyGroup ?? {}).sort()) {
				if (isForbiddenPersistencePackage(packageName)) {
					violations.push(
						`demo/package.json: forbidden persistence dependency ${packageName}`,
					);
				}
			}
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	for (const file of files) {
		const source = await readFile(path.join(demoRoot, file), "utf8");
		const tokens = lexicalTokens(source);
		for (const specifier of importedModuleSpecifiers(tokens)) {
			if (isForbiddenPersistencePackage(specifier)) {
				violations.push(
					`demo/${file.split(path.sep).join("/")}: forbidden persistence import ${specifier}`,
				);
			}
		}
		for (const name of durableBrowserStorageNames(tokens, file)) {
			violations.push(
				`demo/${file.split(path.sep).join("/")}: forbidden durable browser storage ${name}`,
			);
		}
	}
	return violations;
}

const isMain = process.argv[1]
	? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
	: false;

if (isMain) {
	const violations = await findDemoBoundaryViolations(process.cwd());
	if (violations.length > 0) {
		process.stderr.write(`${violations.join("\n")}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write("demo persistence boundary verified\n");
	}
}
