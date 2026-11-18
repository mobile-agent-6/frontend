import { useCallback, useEffect, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { AppState, Platform } from "react-native";

import { createAssistantSpeech } from "@/services/assistant-speech";
import { assistantHttpClient } from "@/services/api/assistant";
import { assistantOrchestrator } from "@/services/api/assistant-orchestrator";
import { createVoiceHttpClient } from "@/services/api/voice";
import { createExpoPlaybackDependencies } from "@/services/expo-audio-playback";
import { createLocalAudioPlayback } from "@/services/local-audio-playback";
import { createSpeechFileStore } from "@/services/speech-file";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";

export function useAssistantSpeech() {
  const current = useRef<ReturnType<typeof createAssistantSpeech> | null>(null);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const scope = () => ({ serverId: assistantHttpClient.getServerId(), generation: scheduleDataModeStore.getState().generation,
      allowed: Platform.OS === "ios" && scheduleDataModeStore.getState().mode === "server" });
    const files = createSpeechFileStore();
    try { files.sweep(); } catch { /* Retry safe deletion on the next input/mount. */ }
    const speech = createAssistantSpeech({ scope, files, http: createVoiceHttpClient(),
      playback: createLocalAudioPlayback(createExpoPlaybackDependencies(() => scope().allowed)),
      check: (ref, generation, signal) => {
        if (scope().generation !== generation || scope().serverId !== ref.serverId || signal.aborted) return Promise.resolve();
        return assistantOrchestrator.queryRequestOnce(ref, { signal }).completion;
      },
      observe(event, detail) { if (typeof __DEV__ !== "undefined" && __DEV__) console.info("[assistant-speech]", event, detail ?? {}); },
    });
    current.current = speech;
    speech.appState(AppState.currentState ?? "unknown");
    const app = AppState.addEventListener("change", value => speech.appState(value));
    const mode = scheduleDataModeStore.subscribe((value, previous) => { if (value.generation !== previous.generation) speech.reset(); });
    return () => { current.current = null; app.remove(); mode(); void speech.dispose(); };
  }, []);
  useFocusEffect(useCallback(() => {
    const speech = current.current; speech?.focus(true);
    return () => speech?.focus(false);
  }, []));
  return current;
}
