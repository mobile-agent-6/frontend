import type { VoiceRequest, VoiceRequestAcceptedResponse } from "@/types/voice-api";
import { isAssistantUuidV4, parseAssistantInput } from "@/utils/assistant-validation";

export function validVoiceRequest(value: VoiceRequest): boolean {
  return !!value && isAssistantUuidV4(value.requestId) &&
    (value.conversationId === undefined && value.questionId === undefined ||
      isAssistantUuidV4(value.conversationId) && isAssistantUuidV4(value.questionId)) &&
    value.bytes instanceof Uint8Array && value.bytes.byteLength > 0 && value.bytes.byteLength <= 1_048_576;
}

export function parseVoiceRequestAcceptedResponse(value: unknown): VoiceRequestAcceptedResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ["requestId", "conversationId", "status", "transcript", "input"];
  return Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key)) &&
    isAssistantUuidV4(v.requestId) && isAssistantUuidV4(v.conversationId) && v.status === "accepted" &&
    typeof v.transcript === "string" && parseAssistantInput(v.input) !== null ? v as VoiceRequestAcceptedResponse : null;
}

// Status/code classification only: a rejection candidate is never metadata cleanup authority.
// Correlation, earlier attempts, acceptance evidence, and storage must be checked by future orchestration.
export function classifyVoiceProblem(status: number, code: string, speech = false): "rejection-candidate" | "expired" | "not-found" | "unconfirmed" {
  if (code === "REQUEST_EXPIRED" && status === (speech ? 410 : 409)) return "expired";
  if (code === "ASSISTANT_REQUEST_NOT_FOUND" && status === 404) return "not-found";
  if (!speech && (status === 422 && ["AUDIO_UNSUPPORTED", "SPEECH_NOT_RECOGNIZED", "VOICE_ANSWER_UNCLEAR", "VALIDATION_ERROR"].includes(code) ||
    status === 413 && code === "REQUEST_BODY_TOO_LARGE" || status === 400 && code === "MALFORMED_REQUEST" ||
    status === 409 && ["STALE_QUESTION", "QUESTION_EXPIRED", "CONVERSATION_EXPIRED", "CONVERSATION_BUSY", "UNRESOLVED_UNCERTAIN", "ACKNOWLEDGEMENT_NOT_APPLICABLE"].includes(code))) return "rejection-candidate";
  return "unconfirmed";
}

/** Known voice error codes must carry their documented HTTP status. Unknown errors stay unconfirmed. */
export function validVoiceProblemStatus(status: number, code: string, speech: boolean): boolean {
  const expected: Record<string, number> = {
    AUDIO_UNSUPPORTED: 422, REQUEST_BODY_TOO_LARGE: 413, SPEECH_NOT_RECOGNIZED: 422,
    VOICE_ANSWER_UNCLEAR: 422, VOICE_UNAVAILABLE: 503, VOICE_BUSY: 409,
    STALE_QUESTION: 409, QUESTION_EXPIRED: 409, SPEECH_NOT_READY: 409,
    REQUEST_ID_CONFLICT: 409, CONVERSATION_BUSY: 409, UNRESOLVED_UNCERTAIN: 409,
    ACKNOWLEDGEMENT_NOT_APPLICABLE: 409, CONVERSATION_EXPIRED: 409,
    ASSISTANT_CONVERSATION_NOT_FOUND: 404, ASSISTANT_TARGET_NOT_FOUND: 404,
    ROUTE_NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, MALFORMED_REQUEST: 400,
    VALIDATION_ERROR: 422, ASSISTANT_UNAVAILABLE: 503, DATABASE_UNAVAILABLE: 503, INTERNAL_ERROR: 500,
    TTS_UNAVAILABLE: 503, REQUEST_EXPIRED: speech ? 410 : 409, ASSISTANT_REQUEST_NOT_FOUND: 404,
  };
  return !Object.hasOwn(expected, code) || expected[code] === status;
}
