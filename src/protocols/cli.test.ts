import { describe, expect, it, vi } from "vitest";

import { ConvexActionCliAdapter } from "./cli.js";

describe("compatibility CLI adapter", () => {
	it("CLI-N01 implements CliAdapter and accepts official action syntax", async () => {
		const invoke = vi.fn(async () => ({
			replayed: false,
			result: { value: 4 },
		}));
		const cli = new ConvexActionCliAdapter({ invoke });

		await expect(
			cli.execute(["action", "increment-widget", '{"amount":3}', "--idempotency-key", "cli-1"]),
		).resolves.toEqual({
			stdout: '{"value":4}\n',
			stderr: "",
			exitCode: 0,
		});
		expect(invoke).toHaveBeenCalledWith({
			actionName: "increment-widget",
			input: { amount: 3 },
			idempotencyKey: "cli-1",
		});
	});

	it("CLI-F01 reads explicit stdin and returns nonzero on invalid input or transport failure", async () => {
		const invoke = vi
			.fn()
			.mockRejectedValueOnce(new Error("deployment unavailable"))
			.mockResolvedValueOnce({ replayed: false, result: { ok: true } });
		const cli = new ConvexActionCliAdapter({
			invoke,
			readStdin: async () => '{"id":"w1"}',
		});

		expect(await cli.execute(["action", "get-widget", "{"])).toMatchObject({
			exitCode: 2,
		});
		expect(await cli.execute(["action", "get-widget", "{}", "--stdin"])).toMatchObject({
			exitCode: 2,
		});
		expect(await cli.execute(["action", "get-widget", "{}"])).toMatchObject({
			exitCode: 1,
			stderr: "Action execution failed\n",
		});
		expect(await cli.execute(["action", "get-widget", "--stdin"])).toEqual({
			stdout: '{"ok":true}\n',
			stderr: "",
			exitCode: 0,
		});
	});

	it("CLI-I01 rejects credentials in argv and redacts secret-shaped output", async () => {
		const invoke = vi.fn(async () => ({
			replayed: false,
			result: {
				ok: true,
				authorization: "Bearer do-not-print",
				nested: { apiKey: "do-not-print-either" },
			},
		}));
		const cli = new ConvexActionCliAdapter({ invoke });

		const rejected = await cli.execute(["action", "get-widget", "{}", "--token", "do-not-accept"]);
		expect(rejected).toMatchObject({ exitCode: 2 });
		expect(invoke).not.toHaveBeenCalled();
		const inputRejected = await cli.execute([
			"action",
			"get-widget",
			'{"accessToken":"do-not-accept"}',
		]);
		expect(inputRejected).toMatchObject({ exitCode: 2 });
		expect(invoke).not.toHaveBeenCalled();

		const safe = await cli.execute(["get-widget", "{}"]);
		expect(safe.stdout).not.toMatch(/do-not-print|Bearer/i);
		expect(safe.stdout).toContain("[redacted]");
	});
});
