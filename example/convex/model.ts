import type { Agent } from "@convex-dev/agent";

export type ExampleLanguageModel = ConstructorParameters<typeof Agent>[1]["languageModel"];

/**
 * Replace this function with the model provider chosen by the host app. Keeping
 * provider construction outside the example makes the extracted build
 * reproducible and avoids implying that credentials belong in source files.
 */
export function requireExampleLanguageModel(): ExampleLanguageModel {
	throw new Error("Configure a server-side language model in convex/model.ts");
}
