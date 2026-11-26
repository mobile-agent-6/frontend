import type { VoiceRequestFile } from "@/services/voice-request-file";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState, Platform } from "react-native";

import { createExpoVoiceDependencies } from "@/services/expo-voice-recording";
import { createLocalVoiceRecording } from "@/services/local-voice-recording";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { AssistantInputUi } from "@/utils/assistant-voice-ui";
import { useLocalAudioPlayback } from "@/hooks/use-local-audio-playback";

export type VoiceRecordingSubmission = { isCurrent(): boolean; complete(owner: VoiceRequestFile): void; invalidate(updateUi?: boolean): void };
export function useLocalVoiceRecording(canStart: () => boolean, onInput: (input: AssistantInputUi) => void,
  beginSubmission?: () => VoiceRecordingSubmission | undefined, onFocus?: (focused: boolean) => void) {
  const callbacks = useRef({ canStart, onInput, beginSubmission, onFocus });
  const submission = useRef<VoiceRecordingSubmission | undefined>(undefined);
  const invalidate = useCallback((updateUi = true) => { submission.current?.invalidate(updateUi); submission.current = undefined; }, []);
  const supported = Platform.OS === "ios" || Platform.OS === "android";
  const controllerRef = useRef<ReturnType<typeof createLocalVoiceRecording> | null>(null);
  const [busy, setBusy] = useState(false);
  const playback = useLocalAudioPlayback(() => supported && !(controllerRef.current?.isBusy() ?? false));
  useLayoutEffect(() => { callbacks.current = { canStart, onInput, beginSubmission, onFocus }; }, [canStart, onInput, beginSubmission, onFocus]);

  useEffect(() => {
    const controller = createLocalVoiceRecording(createExpoVoiceDependencies(() => supported && callbacks.current.canStart() && (submission.current?.isCurrent() ?? true)));
    controllerRef.current = controller;
    const consume = (value: ReturnType<typeof controller.getSnapshot>) => {
      setBusy(value.busy);
      callbacks.current.onInput(value.input);
      if (value.file && value.input.source === "voice" && value.input.phase === "recorded" && submission.current) {
        const request = submission.current;
        if (!request.isCurrent()) { invalidate(); controller.discard(); return; }
        // The controller event, rather than a React effect, owns this exact retained identity.
        const owner = controller.handoff(value.file);
        if (owner) {
          try { request.complete(owner); } catch { void owner.dispose(); invalidate(); }
        } else { invalidate(); controller.discard(); }
      }
    };
    const unsubscribe = controller.subscribe(consume);
    consume(controller.getSnapshot());
    const app = AppState.addEventListener("change", value => { if (value !== "active" && !(value === "inactive" && controller.isPermissionDialog())) invalidate(); controller.appState(value); });
    const mode = scheduleDataModeStore.subscribe((current, previous) => {
      if (current.generation !== previous.generation) { invalidate(); void controller.cancel(); }
    });
    return () => { invalidate(false); controllerRef.current = null; unsubscribe(); app.remove(); mode(); controller.focus(false); };
  }, [supported, invalidate]);
  useFocusEffect(useCallback(() => {
    const controller = controllerRef.current;
    controller?.focus(true);
    callbacks.current.onFocus?.(true);
    return () => { invalidate(); controller?.focus(false); callbacks.current.onFocus?.(false); };
  }, [invalidate]));
  useEffect(() => { controllerRef.current?.checkAvailability(); });

  return {
    playback,
    busy, supported,
    isBusy: () => controllerRef.current?.isBusy() ?? false,
    start: () => {
      if (controllerRef.current?.isBusy() || !callbacks.current.canStart()) return Promise.resolve();
      invalidate();
      submission.current = callbacks.current.beginSubmission?.();
      return controllerRef.current?.start() ?? Promise.resolve();
    },
    stop: () => controllerRef.current?.stop() ?? Promise.resolve(),
    discard: () => controllerRef.current?.discard(),
  };
}
