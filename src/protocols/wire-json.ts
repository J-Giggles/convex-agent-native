/** True only for values that can have arrived in a parsed JSON request. */
export function isJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.every((entry) => isJsonValue(entry, seen));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		return Object.values(value as Record<string, unknown>).every((entry) =>
			isJsonValue(entry, seen),
		);
	} catch {
		return false;
	} finally {
		seen.delete(value);
	}
}

export function jsonUtf8ByteLength(value: unknown): number | null {
	if (!isJsonValue(value)) return null;
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return null;
	}
}

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
		.join(",")}}`;
}
