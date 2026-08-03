import { describe, expect, it, vi } from "vitest";

import { resolveDemoAgentProvider } from "./provider.js";

describe("server-only demo agent provider policy", () => {
  it("CHT-I-001 defaults to deterministic planning and requires explicit enablement plus registration", async () => {
    const plugin = {
      plan: vi.fn(async () => ({
        kind: "reply" as const,
        code: "unsupported" as const,
        text: "provider reply",
      })),
    };

    const deterministic = resolveDemoAgentProvider({}, { paid: plugin });
    await expect(deterministic.plan("add safe demo", [])).resolves.toMatchObject({
      kind: "invoke",
      actionName: "create-task",
      input: { title: "safe demo" },
    });
    expect(plugin.plan).not.toHaveBeenCalled();

    expect(() =>
      resolveDemoAgentProvider({ DEMO_AGENT_PROVIDER: "paid" }, { paid: plugin }),
    ).toThrow("disabled");
    expect(
      resolveDemoAgentProvider(
        { DEMO_AGENT_PROVIDER: "paid", DEMO_AGENT_PROVIDER_ENABLED: "true" },
        { paid: plugin },
      ),
    ).toBe(plugin);
    expect(() =>
      resolveDemoAgentProvider(
        { DEMO_AGENT_PROVIDER: "missing", DEMO_AGENT_PROVIDER_ENABLED: "true" },
        {},
      ),
    ).toThrow("unavailable");
  });
});
