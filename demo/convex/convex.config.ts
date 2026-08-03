import agentNative from "@giggabit/agent-native-convex/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(agentNative, {
  name: "agentNative",
  env: { HOST_SCOPE_POLICY: "host-derived-v1" },
});
export default app;
