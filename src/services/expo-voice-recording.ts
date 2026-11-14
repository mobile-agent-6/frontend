import { AudioModule, AudioQuality, IOSOutputFormat, getRecordingPermissionsAsync, requestRecordingPermissionsAsync,
  setAudioModeAsync, setIsAudioActiveAsync, type RecordingOptions } from "expo-audio";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { AppState, Platform } from "react-native";

import { LOCAL_VOICE_LIMITS, localVoiceProfile, type VoiceRecordingProfile } from "@/constants/voice-recording";
import type { LocalVoiceDependencies, LocalVoiceDiagnostic } from "@/services/local-voice-recording";
import { inspectVoiceBytes } from "@/utils/voice-recording-metadata";

const ownedBase = /^assistant-voice-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownedFile = /^assistant-voice-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-result)?\.(wav|m4a)$/i;
let audioOwner: symbol | null = null;

function diagnose(event: string, detail: LocalVoiceDiagnostic) {
  if (__DEV__) console.info("[local-voice]", event, detail);
}

export function recordingOptions(profile: VoiceRecordingProfile, name: string): RecordingOptions {
  return {
    directory: "cache", fileName: name, extension: profile.extension, sampleRate: profile.sampleRate,
    numberOfChannels: profile.channels, bitRate: profile.bitRate, isMeteringEnabled: false,
    ios: { outputFormat: profile.codec === "PCM_S16LE" ? IOSOutputFormat.LINEARPCM : IOSOutputFormat.MPEG4AAC,
      audioQuality: AudioQuality.HIGH, linearPCMBitDepth: profile.bitDepth ?? undefined, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
    android: { outputFormat: "mpeg4", audioEncoder: "aac" },
    web: {}, // 파일 소유권/정리 계약이 다른 Web 녹음은 이번 단계에서 활성화하지 않는다.
  };
}

export function createVoiceFileStore(profile: VoiceRecordingProfile, platform: string) {
  const directory = new Directory(Paths.cache, platform === "ios" ? "ExpoAudio" : "Audio");
  // 오직 이 작업에서 만든 native recorder가 반환한 cache URI만 등록한다. 외부 입력 URI는 소유 근거가 아니다.
  const nativeFiles = new Map<string, Set<string>>();
  const normalized = (uri: string) => decodeURIComponent(uri).replace(/\/$/, "");
  const fileFor = (name: string) => {
    if (!ownedBase.test(name)) throw new Error("unowned-recording-file");
    // native 원본과 이름을 다르게 하여 /var ↔ /private/var 같은 별칭에서도 자기 자신으로 이동하지 않는다.
    return new File(directory, name + "-result" + profile.extension);
  };
  const store = {
    captureNativeFile(name: string, uri: string | null) {
      fileFor(name);
      if (!uri || !uri.startsWith("file://")) return false;
      const path = normalized(uri), root = normalized(Paths.cache.uri) + "/";
      if (path.includes("\0") || /\/(\.\.?)(\/|$)/.test(path) ||
        !(path.startsWith(root) || (platform === "ios" && path.includes("/Library/Caches/")))) return false;
      const files = nativeFiles.get(name) ?? new Set<string>();
      files.add(new File(uri).uri); nativeFiles.set(name, files);
      return true;
    },
    probe(name: string, uri: string | null) {
      const expected = new File(directory, name + profile.extension);
      const source = uri?.startsWith("file://") ? new File(uri) : null;
      return { hasUri: Boolean(uri), uriMatchesExpected: Boolean(uri && normalized(uri) === normalized(expected.uri)),
        sourceExists: source?.exists ?? false, sourceSize: source?.exists ? source.size : 0, expectedExists: expected.exists };
    },
    sweep() {
      for (const name of [...nativeFiles.keys()]) store.remove(name);
      if (!directory.exists) return;
      for (const entry of directory.list()) if (entry instanceof File && ownedFile.test(entry.name)) {
        entry.delete();
        if (entry.exists) throw new Error("recording-file-not-deleted");
      }
    },
    async inspect(name: string, uri: string | null) {
      const file = fileFor(name);
      const registered = Boolean(uri && [...(nativeFiles.get(name) ?? [])].some(value => normalized(value) === normalized(uri)));
      diagnose("file-source", { ...store.probe(name, registered ? uri : null), hasUri: Boolean(uri), registered });
      if (!registered) throw new Error(uri ? "unowned-recording-file" : "missing-file");
      const source = new File(uri!);
      if (!source.exists) throw new Error("missing-file");
      if (source.size > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
      if (!source.size) throw new Error("invalid-file");
      if (file.exists) throw new Error("recording-destination-exists");
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const sourceUri = source.uri;
      diagnose("file-move-started", { sourceExists: source.exists, sourceSize: source.size, destinationExists: file.exists });
      try { await source.move(file); }
      catch { diagnose("file-move-failed", { sourceExists: new File(sourceUri).exists, destinationExists: file.exists }); throw new Error("file-move"); }
      diagnose("file-move-completed", { sourceExists: new File(sourceUri).exists, destinationExists: file.exists, destinationSize: file.size });
      if (!file.exists) throw new Error("missing-file");
      // prepare가 교체한 초기 recorder의 빈 파일도 함께 정리한다. 관리 파일은 별도 이름이므로 삭제하지 않는다.
      try {
        for (const original of nativeFiles.get(name) ?? []) {
          const abandoned = new File(original);
          if (abandoned.exists) abandoned.delete();
          if (abandoned.exists) throw new Error("cleanup");
        }
      } catch { diagnose("file-cleanup-failed", { hasError: true }); throw new Error("cleanup"); }
      if (file.size > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
      let bytes: Uint8Array;
      try { bytes = await file.bytes(); }
      catch { diagnose("file-read-failed", { fileExists: file.exists }); throw new Error("file-read"); }
      if (bytes.length > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
      if (bytes.length !== file.size) throw new Error("invalid-file");
      return inspectVoiceBytes(bytes, profile);
    },
    remove(name: string) {
      const file = fileFor(name);
      let deletedCount = 0;
      for (const uri of new Set([file.uri, ...(nativeFiles.get(name) ?? [])])) {
        const owned = new File(uri);
        if (owned.exists) { owned.delete(); deletedCount++; }
        if (owned.exists) throw new Error("recording-file-not-deleted");
      }
      nativeFiles.delete(name);
      return { existedBeforeDelete: deletedCount > 0, deletedCount, existsAfterDelete: false as const };
    },
  };
  return store;
}

export function createExpoVoiceDependencies(canStart: () => boolean): LocalVoiceDependencies {
  const profile = localVoiceProfile(Platform.OS), owner = Symbol("local-audio-session");
  let fileStore: ReturnType<typeof createVoiceFileStore> | undefined;
  const files = () => fileStore ??= createVoiceFileStore(profile, Platform.OS);
  return {
    canStart, readAppState: () => AppState.currentState ?? null,
    permission: getRecordingPermissionsAsync, requestPermission: requestRecordingPermissionsAsync,
    async activate() {
      if (audioOwner && audioOwner !== owner) throw new Error("local-audio-session-busy");
      audioOwner = owner;
      await setIsAudioActiveAsync(true);
    },
    configure: () => setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: "doNotMix",
      shouldPlayInBackground: false, allowsBackgroundRecording: false }),
    async reset() {
      if (audioOwner !== owner) return;
      let failed = false;
      try { await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false, allowsBackgroundRecording: false }); } catch { failed = true; }
      try { await setIsAudioActiveAsync(false); } catch { failed = true; }
      audioOwner = null;
      if (failed) throw new Error("audio-session-cleanup");
    },
    create(name, listener) {
      const options = recordingOptions(profile, name);
      // 공개 AudioModule의 SharedObject를 작업별로 소유한다. prepare shim과 같은 플랫폼 옵션을 생성자에 전달한다.
      const nativeAudio: typeof AudioModule = AudioModule;
      const recorder = new nativeAudio.AudioRecorder({ ...options, ...(Platform.OS === "ios" ? options.ios : options.android) });
      let finishedUri: string | null = null;
      const capture = (event: string) => {
        try {
          const uri = finishedUri ?? recorder.uri;
          const registered = files().captureNativeFile(name, uri);
          diagnose(event, { ...files().probe(name, registered ? uri : null), hasUri: Boolean(uri), registered });
          return uri;
        } catch { diagnose(event, { uriLookupFailed: true }); return null; }
      };
      capture("recorder-created");
      let subscription;
      try { subscription = recorder.addListener("recordingStatusUpdate", event => {
        if (event.id !== recorder.id) return;
        if (event.isFinished && !event.hasError && event.url) {
          finishedUri = event.url;
          capture("recorder-finished-event");
        }
        diagnose("recorder-native-event", { isFinished: event.isFinished, hasError: event.hasError });
        listener(event);
      }); }
      catch (error) { recorder.release(); throw error; }
      return {
        async prepare() {
          try { await recorder.prepareToRecordAsync(options); }
          catch (error) { diagnose("recorder-prepare-failed", { hasError: true }); throw error; }
          finally { capture("recorder-prepared"); }
        },
        record: () => recorder.record({ forDuration: LOCAL_VOICE_LIMITS.durationSeconds }),
        status: () => { const state = recorder.getStatus(); return { ...state, isRecording: state.isRecording && recorder.isRecording }; },
        async stop() {
          try { await recorder.stop(); diagnose("recorder-stop-completed", { stopCompleted: true }); }
          catch (error) { diagnose("recorder-stop-failed", { hasError: true }); throw error; }
          finally { capture("recorder-after-stop"); }
        },
        uri: () => capture("recorder-final-uri"),
        release() { subscription.remove(); recorder.release(); },
      };
    },
    newName: () => `assistant-voice-${randomUUID()}`,
    files: {
      sweep: () => files().sweep(),
      inspect: (name, uri) => files().inspect(name, uri),
      remove: name => files().remove(name),
    },
    setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    observe(event, detail) {
      // 경로·파일명·음성 바이트·권한 native 오류 원문을 로그에 남기지 않는다.
      if (__DEV__) console.info("[local-voice]", event, detail ?? {});
    },
  };
}
