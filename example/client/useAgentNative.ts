"use client";

import { useThreadMessages } from "@convex-dev/agent/react";
import { createActionClient } from "@giggabit/agent-native-convex/client";
import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo } from "react";

import { api } from "../convex/_generated/api";

export function useExampleActionClient() {
	const invoke = useAction(api.actions.invoke);
	return useMemo(() => createActionClient((request) => invoke(request)), [invoke]);
}

export function useExampleWidget() {
	return useQuery(api.actions.getWidget);
}

export function useExampleThread(threadId?: string) {
	const createThread = useMutation(api.threads.createThread);
	const streamReply = useAction(api.threads.streamReply);
	const messages = useThreadMessages(
		api.threads.listThreadMessages,
		threadId ? { threadId } : "skip",
		{ initialNumItems: 20, stream: true },
	);

	return { createThread, messages, streamReply };
}
