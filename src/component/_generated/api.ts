/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex codegen --component-dir ./src/component`.
 * @module
 */

import type { ComponentApi as AgentComponentApi } from "@convex-dev/agent/_generated/component.js";
import {
	anyApi,
	componentsGeneric,
	type ApiFromModules,
	type FilterApi,
	type FunctionReference,
} from "convex/server";

import type * as audit from "../audit.js";
import type * as extensions from "../extensions.js";
import type * as invocations from "../invocations.js";

const fullApi: ApiFromModules<{
	audit: typeof audit;
	extensions: typeof extensions;
	invocations: typeof invocations;
}> = anyApi as any;

export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

export const internal: FilterApi<
	typeof fullApi,
	FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
	agent: AgentComponentApi<"agent">;
};
