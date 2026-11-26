import type { VoiceTransmission } from "@/types/voice-api";
import { createVoiceHttpClient } from "@/services/api/voice";
import { assistantHttpClient, type AssistantPostOptions } from "@/services/api/assistant";
import type { VoiceRequestFile } from "@/services/voice-request-file";
import { VOICE_RECORDING_PROFILES } from "@/constants/voice-recording";
import { inspectVoiceBytes } from "@/utils/voice-recording-metadata";

// Failed disposal remains reachable after the originating screen has unmounted.
// Recorder sweep must never assume responsibility for these request-owned files.
function diagnostic(event: string, detail: Record<string, boolean | number> = {}) {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.info("[assistant-voice]", event, detail);
}
const cleanupOwners = new Set<VoiceRequestFile>();
export async function disposeVoiceFile(owner: VoiceRequestFile) {
  cleanupOwners.add(owner);
  const result = await owner.dispose();
  if (result === "deleted") cleanupOwners.delete(owner);
  diagnostic("cleanup", { deleted: result === "deleted", failed: result === "failed", pending: result === "pending" });
  return result;
}
export async function retryVoiceFileCleanup() {
  await Promise.all([...cleanupOwners].map(async owner => {
    if (await owner.dispose() === "deleted") cleanupOwners.delete(owner);
  }));
}

export type AssistantVoicePayload = ReturnType<typeof createAssistantVoicePayload>;
export function createAssistantVoicePayload(owner: VoiceRequestFile, query: {
  requestId: string; conversationId?: string; questionId?: string;
}, canSend: () => boolean, api = createVoiceHttpClient({ assistant: assistantHttpClient })) {
  const reference = { ...query };
  diagnostic("owner-handoff");
  let closed = false, attempts = 0;
  let postCount = 0, state: VoiceTransmission["state"] = "not-sent";
  const getTransmission = (): VoiceTransmission => Object.freeze({ postCount, state });
  const allowed = () => !closed && attempts < 2 && canSend() && (attempts === 0 || owner.getState().retryEligible);
  const dispose = async () => {
    closed = true;
    await disposeVoiceFile(owner);
  };
  return Object.freeze({
    identity: Object.freeze({}),
    getTransmission,
    rejected() { if (postCount === 1 && state !== "accepted") state = "rejected"; },
    requestId: reference.requestId,
    conversationId: reference.conversationId,
    canSend: allowed,
    async post(options: AssistantPostOptions) {
      if (!allowed() || options.signal?.aborted) throw new Error("voice-authority-lost");
      const use = owner.acquire(attempts ? "retry" : "read");
      diagnostic("lease-acquired", { retry: attempts > 0 });
      try {
        const bytes = await use.readBytes();
        inspectVoiceBytes(bytes, VOICE_RECORDING_PROFILES.wav);
        diagnostic("bytes-validated", { size: bytes.length });
        if (!allowed() || options.signal?.aborted) throw new Error("voice-authority-lost");
        const guard = options.beforeSend;
        return await api.postVoiceRequest({ ...reference, bytes }, { ...options, onDispatch: () => { postCount++; if (state !== "accepted") state = "unconfirmed"; }, beforeSend: saved => {
          if (!allowed() || options.signal?.aborted || guard?.(saved) === false) return false;
          if (!allowed()) return false;
          attempts++;
          return true;
        } });
      } finally {
        await use.release();
        diagnostic("lease-released");
        if (closed) await dispose();
      }
    },
    accepted() { state = "accepted"; diagnostic("retry-revoked"); void owner.revokeRetry(); void owner.requestCleanup(); },
    dispose,
  });
}
