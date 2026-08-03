/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as bootstrap from "../bootstrap.js";
import type * as capabilities from "../capabilities.js";
import type * as chat from "../chat.js";
import type * as chatAction from "../chatAction.js";
import type * as direct from "../direct.js";
import type * as http from "../http.js";
import type * as httpActions from "../httpActions.js";
import type * as httpErrors from "../httpErrors.js";
import type * as mcp from "../mcp.js";
import type * as quotas from "../quotas.js";
import type * as receipts from "../receipts.js";
import type * as sessions from "../sessions.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  bootstrap: typeof bootstrap;
  capabilities: typeof capabilities;
  chat: typeof chat;
  chatAction: typeof chatAction;
  direct: typeof direct;
  http: typeof http;
  httpActions: typeof httpActions;
  httpErrors: typeof httpErrors;
  mcp: typeof mcp;
  quotas: typeof quotas;
  receipts: typeof receipts;
  sessions: typeof sessions;
  tasks: typeof tasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agentNative: import("@giggabit/agent-native-convex/_generated/component.js").ComponentApi<"agentNative">;
};
