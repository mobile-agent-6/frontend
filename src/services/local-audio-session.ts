// 녹음/재생 한 건의 예약과 native 세션 소유권만 공유한다. 실패한 정리는 소유권을 넘기지 않는다.
export function createLocalAudioSession() {
  let recording: symbol | null = null;
  let playback: { owner: symbol; stop: () => Promise<boolean> } | null = null;
  let session: symbol | null = null;
  return {
    beginRecording(owner: symbol) {
      if (recording) throw new Error("local-audio-busy");
      recording = owner; // 권한 요청 및 재생 중단을 기다리기 전에 새 재생을 차단한다.
      return (async () => {
        if (playback && !await playback.stop()) throw new Error("local-audio-cleanup");
        if (playback || session) throw new Error("local-audio-busy");
      })();
    },
    endRecording(owner: symbol, safe: boolean) { if (recording === owner && safe) recording = null; },
    beginPlayback(owner: symbol, stop: () => Promise<boolean>) {
      if (recording || playback || session) throw new Error("local-audio-busy");
      playback = { owner, stop };
    },
    endPlayback(owner: symbol, safe: boolean) { if (playback?.owner === owner && safe) playback = null; },
    async activate(owner: symbol, activate: () => Promise<void>) {
      if (session && session !== owner) throw new Error("local-audio-session-busy");
      session = owner;
      await activate();
    },
    async reset(owner: symbol, reset: () => Promise<void>) {
      if (session !== owner) return;
      await reset(); // 실패하면 session을 유지하여 다른 작업의 시작을 막는다.
      session = null;
    },
  };
}

export const localAudioSession = createLocalAudioSession();
