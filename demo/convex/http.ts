import { httpRouter } from "convex/server";

import {
  directActionPost,
  mcpPost,
  sessionOptions,
  sessionPost,
} from "./httpActions.js";

const http = httpRouter();

http.route({
  path: "/demo/session",
  method: "OPTIONS",
  handler: sessionOptions,
});

http.route({
  path: "/demo/session",
  method: "POST",
  handler: sessionPost,
});

http.route({
  path: "/demo/action",
  method: "POST",
  handler: directActionPost,
});

http.route({
  path: "/mcp",
  method: "POST",
  handler: mcpPost,
});

export default http;
