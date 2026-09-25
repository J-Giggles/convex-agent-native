import { sha256Hex } from "./fingerprint.js";

const APPROVAL_KEY_PREFIX = "apk_";

/**
 * Content-addressed approval key for one exact call, mirroring the upstream
 * `approval_required` contract: the key is derived from the action name and the
 * canonical validated-input fingerprint, so approving one call never approves
 * a call with different arguments, and the model can neither read nor forge it.
 */
export async function deriveApprovalKey(
	actionName: string,
	requestFingerprint: string,
): Promise<string> {
	return `${APPROVAL_KEY_PREFIX}${await sha256Hex(`${actionName}\n${requestFingerprint}`)}`;
}

export function isApprovalKey(value: unknown): value is string {
	return typeof value === "string" && /^apk_[0-9a-f]{64}$/u.test(value);
}
