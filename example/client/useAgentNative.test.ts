import { beforeEach, describe, expect, it, vi } from "vitest";

const useAction = vi.fn();
const useMutation = vi.fn();
const useQuery = vi.fn();
const useThreadMessages = vi.fn();

vi.mock("convex/react", () => ({ useAction, useMutation, useQuery }));
vi.mock("@convex-dev/agent/react", () => ({ useThreadMessages }));
vi.mock("react", () => ({ useMemo: (factory: () => unknown) => factory() }));

describe("accepted reactive client coverage", () => {
	beforeEach(() => vi.resetAllMocks());

	it("CLIEN-N01 observes action results and the generated reactive query", async () => {
		useAction.mockReturnValue(
			vi.fn(async () => ({ invocationId: "inv-1", replayed: false, result: { value: 2 } })),
		);
		useQuery.mockReturnValue({ id: "counter", value: 2 });
		const { useExampleActionClient, useExampleWidget } = await import("./useAgentNative.js");
		await expect(
			useExampleActionClient().callAction(
				"increment-counter",
				{ amount: 1 },
				{ idempotencyKey: "request-1" },
			),
		).resolves.toEqual({ invocationId: "inv-1", replayed: false, result: { value: 2 } });
		expect(useExampleWidget()).toEqual({ id: "counter", value: 2 });
		expect(useQuery).toHaveBeenCalledOnce();
	});

	it("CLIEN-F01 preserves typed failure without fabricating reactive state", async () => {
		const rejection = Object.assign(new Error("denied"), { code: "FORBIDDEN" });
		useAction.mockReturnValue(vi.fn(async () => Promise.reject(rejection)));
		useQuery.mockReturnValue(undefined);
		const { useExampleActionClient, useExampleWidget } = await import("./useAgentNative.js");
		await expect(useExampleActionClient().callAction("private", {})).rejects.toBe(rejection);
		expect(useExampleWidget()).toBeUndefined();
	});

	it("CLIEN-I01 generated hook requests contain no client scope authority", async () => {
		const invoke = vi.fn(async () => ({ replayed: false, result: { value: 1 } }));
		useAction.mockReturnValue(invoke);
		const { useExampleActionClient } = await import("./useAgentNative.js");
		await useExampleActionClient().callAction("increment-counter", { amount: 1 });
		expect(invoke).toHaveBeenCalledWith({
			actionName: "increment-counter",
			input: { amount: 1 },
		});
		expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/scopeKey|subjectId|organizationId/u);
	});
});
