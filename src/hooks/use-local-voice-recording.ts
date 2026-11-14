import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState, Platform } from "react-native";

import { createExpoVoiceDependencies } from "@/services/expo-voice-recording";
import { createLocalVoiceRecording } from "@/services/local-voice-recording";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { AssistantInputUi } from "@/utils/assistant-voice-ui";
import { useLocalAudioPlayback } from "@/hooks/use-local-audio-playback";

export function useLocalVoiceRecording(canStart: () => boolean, onInput: (input: AssistantInputUi) => void) {
  const callbacks = useRef({ canStart, onInput });
  const supported = Platform.OS === "ios" || Platform.OS === "android";
  const controllerRef = useRef<ReturnType<typeof createLocalVoiceRecording> | null>(null);
  const [busy, setBusy] = useState(false);
  const playback = useLocalAudioPlayback(() => supported && !(controllerRef.current?.isBusy() ?? false));
  useLayoutEffect(() => { callbacks.current = { canStart, onInput }; }, [canStart, onInput]);

  useEffect(() => {
    const controller = createLocalVoiceRecording(createExpoVoiceDependencies(() => supported && callbacks.current.canStart()));
    controllerRef.current = controller;
    const consume = (value: ReturnType<typeof controller.getSnapshot>) => {
      setBusy(value.busy);
      callbacks.current.onInput(value.input);
    };
    const unsubscribe = controller.subscribe(consume);
    consume(controller.getSnapshot());
    const app = AppState.addEventListener("change", value => controller.appState(value));
    const mode = scheduleDataModeStore.subscribe((current, previous) => {
      if (current.generation !== previous.generation) void controller.cancel();
    });
    return () => { controllerRef.current = null; unsubscribe(); app.remove(); mode(); controller.focus(false); };
  }, [supported]);
  useFocusEffect(useCallback(() => {
    const controller = controllerRef.current;
    controller?.focus(true);
    return () => controller?.focus(false);
  }, []));
  useEffect(() => { controllerRef.current?.checkAvailability(); });

  return {
    playback,
    busy, supported,
    isBusy: () => controllerRef.current?.isBusy() ?? false,
    start: () => controllerRef.current?.start() ?? Promise.resolve(),
    stop: () => controllerRef.current?.stop() ?? Promise.resolve(),
    discard: () => controllerRef.current?.discard(),
  };
}
