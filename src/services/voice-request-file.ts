/** In-memory ownership only. No HTTP, persistence, filesystem paths, or playback. */
export type VoiceFileCleanup = "retained" | "pending" | "deleted" | "failed";
export type VoiceFileUse = { readBytes(): Promise<Uint8Array>; release(): Promise<VoiceFileCleanup> };
export type VoiceRequestFile = ReturnType<typeof createVoiceRequestFile>;

export function createVoiceRequestFile(port: { read(): Promise<Uint8Array>; remove(): void | Promise<void> }) {
  const uses = new Set<object>();
  let cleanupFailed = false;
  let reads = 0, retryEligible = true, closing = false, cleanupRequested = false, deleted = false;
  let deletion: Promise<VoiceFileCleanup> | null = null;
  function cleanup(): Promise<VoiceFileCleanup> {
    if (deleted) return Promise.resolve("deleted");
    if (deletion) return deletion;
    if (!cleanupRequested || retryEligible) return Promise.resolve("retained");
    if (uses.size || reads) return Promise.resolve("pending");
    const pending = Promise.resolve().then(async (): Promise<VoiceFileCleanup> => {
      try { await port.remove(); deleted = true; cleanupFailed = false; return "deleted"; }
      catch { cleanupFailed = true; return "failed"; }
    });
    deletion = pending;
    void pending.then(() => { if (deletion === pending) deletion = null; });
    return pending;
  }
  return Object.freeze({
    acquire(kind: "read" | "retry" = "read"): VoiceFileUse {
      if (kind !== "read" && kind !== "retry") throw new Error("voice-file-unavailable");
      if (closing || deleted || deletion || cleanupRequested && kind !== "retry" || kind === "retry" && !retryEligible) throw new Error("voice-file-unavailable");
      const token = {}; uses.add(token); let released = false;
      return Object.freeze({
        async readBytes() {
          if (released || closing || deleted || !uses.has(token)) throw new Error("voice-file-unavailable");
          reads++;
          try {
            const bytes = await port.read();
            if (released || closing || deleted || !uses.has(token)) throw new Error("voice-file-unavailable");
            return new Uint8Array(bytes);
          } finally { reads--; void cleanup(); }
        },
        release() {
          if (released) return Promise.resolve(deleted ? "deleted" as const : deletion ? "pending" as const :
            cleanupFailed ? "failed" as const : cleanupRequested && !retryEligible && (uses.size || reads) ? "pending" as const : "retained" as const);
          released = true; uses.delete(token); return cleanup();
        },
      });
    },
    requestCleanup() { cleanupRequested = true; return cleanup(); },
    revokeRetry() { retryEligible = false; return cleanup(); },
    dispose() { closing = true; retryEligible = false; cleanupRequested = true; return cleanup(); },
    getState() { return { cleanupFailed, activeUses: uses.size, activeReads: reads, retryEligible, closing, deleting: deletion !== null, deleted }; },
  });
}
