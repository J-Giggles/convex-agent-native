#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const packageName = process.env.PACKAGE_NAME ?? "@giggabit/agent-native-convex";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const minimalSubpaths = new Set([
	".",
	"./action",
	"./persistence",
	"./mcp",
	"./a2a",
	"./cli",
	"./protocols",
	"./convex",
	"./extensions",
	"./automations",
	"./test",
	"./_generated/component.js",
	"./package.json",
]);
const exportSubpaths = Object.keys(packageJson.exports)
	.sort()
	.filter((subpath) => !process.argv.includes("--minimal") || minimalSubpaths.has(subpath));
const output = [];
let index = 0;
const bindings = new Map();
for (const subpath of exportSubpaths) {
	const specifier = subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
	const binding = `export${index}`;
	bindings.set(subpath, binding);
	if (subpath === "./package.json") {
		output.push(`import ${binding} from ${JSON.stringify(specifier)} with { type: "json" };`);
		output.push(
			`if (${binding}.name !== ${JSON.stringify(packageName)}) throw new Error("wrong package metadata");`,
		);
	} else {
		output.push(`import * as ${binding} from ${JSON.stringify(specifier)};`);
		output.push(`void ${binding};`);
	}
	index += 1;
}
if (bindings.has("./convex.config") && bindings.has("./convex.config.js")) {
	output.push(
		`if (${bindings.get("./convex.config")}.default !== ${bindings.get("./convex.config.js")}.default) throw new Error("convex.config aliases diverge");`,
	);
}
output.push(
	`process.stdout.write(${JSON.stringify(`runtime imports passed for ${index} exports${bindings.has(".") ? " including package root" : ""}\n`)});`,
);
await writeFile(process.argv[2] ?? "all-exports.mjs", `${output.join("\n")}\n`, "utf8");
