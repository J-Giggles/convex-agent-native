import { taskActionDefinitions, type Task } from "../actions/task-actions.js";
import { interpretDemoPrompt, type DeterministicPlan } from "./deterministic.js";

/**
 * Server-only provider plug-in contract. Implementations are registered in the
 * Convex backend and receive bounded prompts plus public task fields only.
 * Provider credentials must remain in server environment variables and must
 * never be added to this input or to persisted chat messages.
 */
export interface DemoAgentProvider {
  plan(
    prompt: string,
    tasks: readonly Task[],
    actions: typeof taskActionDefinitions,
  ): Promise<DeterministicPlan>;
}

export type DemoAgentProviderRegistry = Readonly<Record<string, DemoAgentProvider>>;

interface DemoAgentProviderEnvironment {
  readonly DEMO_AGENT_PROVIDER?: string | undefined;
  readonly DEMO_AGENT_PROVIDER_ENABLED?: string | undefined;
}

const deterministicProvider: DemoAgentProvider = {
  plan: async (prompt, tasks) => interpretDemoPrompt(prompt, tasks),
};

export function planDemoAgentTurn(
  provider: DemoAgentProvider,
  prompt: string,
  tasks: readonly Task[],
) {
  return provider.plan(prompt, tasks, taskActionDefinitions);
}

/**
 * Deterministic parsing is the fail-closed default. A provider-backed planner
 * requires both an explicit server flag and a code-registered implementation;
 * merely setting a provider name cannot activate paid model traffic.
 */
export function resolveDemoAgentProvider(
  environment: DemoAgentProviderEnvironment,
  providers: DemoAgentProviderRegistry = {},
): DemoAgentProvider {
  const name = environment.DEMO_AGENT_PROVIDER?.trim();
  if (!name || name === "deterministic") return deterministicProvider;
  if (environment.DEMO_AGENT_PROVIDER_ENABLED !== "true") {
    throw new Error("Provider-backed demo chat is disabled");
  }
  const provider = providers[name];
  if (!provider) throw new Error("Configured demo agent provider is unavailable");
  return provider;
}
