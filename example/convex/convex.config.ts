import agent from "@convex-dev/agent/convex.config";
import agentNative from "@giggabit/agent-native-convex/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();

// Threads, messages, and stream deltas live in this Convex deployment.
app.use(agent, { name: "agent" });
app.use(agentNative, {
	name: "agentNative",
	env: { HOST_SCOPE_POLICY: "host-derived-v1" },
});

export default app;
