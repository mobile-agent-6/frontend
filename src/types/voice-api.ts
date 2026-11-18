import type { AssistantInput, AssistantRequestAcceptedResponse, AssistantRequestStatusResponse } from "@/types/assistant-api";

export type VoiceRequest = { requestId: string; conversationId?: string; questionId?: string; bytes: Uint8Array };
export type VoiceRequestAcceptedResponse = AssistantRequestAcceptedResponse & { transcript: string; input: AssistantInput };
export type VoicePostResponse = { state: AssistantRequestStatusResponse; acceptance?: VoiceRequestAcceptedResponse };
