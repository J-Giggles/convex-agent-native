const authenticatedExtensionRequests = new WeakSet<object>();

/**
 * Mark the exact request object created by the extension bridge. The marker is
 * deliberately held out-of-band so callers cannot copy or deserialize it.
 */
export function authenticateExtensionRequest<T extends object>(request: T): T {
	authenticatedExtensionRequests.add(request);
	return request;
}

/** Internal execution-boundary check; public callers cannot mint this proof. */
export function isAuthenticatedExtensionRequest(request: object): boolean {
	return authenticatedExtensionRequests.has(request);
}
