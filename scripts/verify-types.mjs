#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const packageName = process.env.PACKAGE_NAME ?? "@giggabit/agent-native-convex";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const output = [];
let index = 0;
for (const subpath of Object.keys(packageJson.exports).sort()) {
	const specifier = subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
	if (subpath === "./package.json") {
		output.push(`import metadata from ${JSON.stringify(specifier)} with { type: "json" };`);
		output.push(`void metadata.name;`);
	} else {
		output.push(`import * as export${index} from ${JSON.stringify(specifier)};`);
		output.push(`void export${index};`);
		index += 1;
	}
}
await writeFile(process.argv[2] ?? "all-exports.ts", `${output.join("\n")}\n`, "utf8");
