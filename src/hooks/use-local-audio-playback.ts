import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";

import { createExpoPlaybackDependencies } from "@/services/expo-audio-playback";
import { createLocalAudioPlayback, type LocalPlaybackSnapshot, type LocalPlaybackSource } from "@/services/local-audio-playback";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";

export function useLocalAudioPlayback(canPlay: () => boolean) {
  const callback = useRef(canPlay), controller = useRef<ReturnType<typeof createLocalAudioPlayback> | null>(null);
  const [snapshot, setSnapshot] = useState<LocalPlaybackSnapshot>({ phase: "idle", blocked: false });
  useLayoutEffect(() => { callback.current = canPlay; }, [canPlay]);
  useEffect(() => {
    const current = createLocalAudioPlayback(createExpoPlaybackDependencies(() => callback.current()));
    controller.current = current;
    const unsubscribe = current.subscribe(setSnapshot);
    setSnapshot(current.getSnapshot());
    const app = AppState.addEventListener("change", value => current.appState(value));
    const mode = scheduleDataModeStore.subscribe((value, previous) => { if (value.generation !== previous.generation) void current.stop(); });
    return () => { controller.current = null; unsubscribe(); app.remove(); mode(); current.focus(false); };
  }, []);
  useFocusEffect(useCallback(() => {
    const current = controller.current; current?.focus(true);
    return () => current?.focus(false);
  }, []));
  return { snapshot, play: (source: LocalPlaybackSource) => controller.current?.play(source) ?? Promise.resolve(),
    stop: () => controller.current?.stop() ?? Promise.resolve(true) };
}
