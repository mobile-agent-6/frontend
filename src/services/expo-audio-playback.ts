import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioStatus } from "expo-audio";
import { File } from "expo-file-system";
import { AppState } from "react-native";

import { LOCAL_AUDIO_PLAYBACK_FORMATS, LOCAL_AUDIO_PLAYBACK_OPTIONS } from "@/constants/audio-playback";
import { localAudioSession } from "@/services/local-audio-session";
import type { LocalPlaybackDependencies, LocalPlaybackStatus } from "@/services/local-audio-playback";

export function createExpoPlaybackDependencies(canPlay: () => boolean): LocalPlaybackDependencies {
  const owner = Symbol("local-playback");
  return {
    canPlay, readAppState: () => AppState.currentState ?? null,
    reserve: stop => localAudioSession.beginPlayback(owner, stop),
    relinquish: safe => localAudioSession.endPlayback(owner, safe),
    async validate(source) {
      if (source.kind === "asset") {
        if (!Number.isInteger(source.asset) || source.asset <= 0) throw new Error("invalid-local-asset");
      } else {
        if (!LOCAL_AUDIO_PLAYBACK_FORMATS.includes(source.format) || !source.uri.startsWith("file://")) throw new Error("invalid-local-source");
        const file = new File(source.uri);
        if (!file.exists || file.size <= 0) throw new Error("missing-local-audio");
      }
    },
    activate: () => localAudioSession.activate(owner, () => setIsAudioActiveAsync(true)),
    configure: () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, interruptionMode: "doNotMix",
      shouldPlayInBackground: false, allowsBackgroundRecording: false }),
    reset: () => localAudioSession.reset(owner, async () => {
      let failed = false;
      try { await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false, allowsBackgroundRecording: false }); } catch { failed = true; }
      try { await setIsAudioActiveAsync(false); } catch { failed = true; }
      if (failed) throw new Error("local-playback-cleanup");
    }),
    create(source, listener) {
      const player = createAudioPlayer(source.kind === "asset" ? source.asset : { uri: source.uri }, LOCAL_AUDIO_PLAYBACK_OPTIONS);
      let removed = false, released = false, unsubscribed = false;
      const status = (value: AudioStatus): LocalPlaybackStatus => ({
        playing: value.playing && player.playing, isLoaded: value.isLoaded,
        didJustFinish: value.didJustFinish, failed: Boolean(value.error) || value.playbackState === "failed" || value.playbackState === "error",
      });
      let subscription: ReturnType<typeof player.addListener> | undefined;
      return {
        play() {
          player.loop = false;
          subscription = player.addListener("playbackStatusUpdate", value => { if (value.id === player.id) listener(status(value)); });
          player.play();
        },
        pause() {
          // SDK의 foreground 자동 재개가 남은 source를 다시 재생하지 않도록 정리 await 전에 분리한다.
          try { player.pause(); } finally { player.replace(null); }
        },
        status: () => status(player.currentStatus),
        release() {
          let failed = false;
          try { if (!unsubscribed) { subscription?.remove(); unsubscribed = true; } } catch { failed = true; }
          try { if (!removed) { player.remove(); removed = true; } } catch { failed = true; }
          try { if (!released) { player.release(); released = true; } } catch { failed = true; }
          if (failed) throw new Error("local-player-release");
        },
      };
    },
    observe(phase, issue) { if (__DEV__) console.info("[local-playback]", phase, issue ? { issue } : {}); },
  };
}
