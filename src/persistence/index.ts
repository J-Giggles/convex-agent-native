export * from "./audit.js";
export * from "./invocations.js";

import type { InvocationAuditReader } from "./audit.js";
import type { AtomicInvocationPersistence } from "./invocations.js";

/** Context-bound capabilities exposed to one trusted host operation. */
export interface AgentNativePersistence {
	invocations: AtomicInvocationPersistence;
	audit: InvocationAuditReader;
}
