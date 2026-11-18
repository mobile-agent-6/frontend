import { AudioModule, AudioQuality, IOSOutputFormat, getRecordingPermissionsAsync, requestRecordingPermissionsAsync,
  setAudioModeAsync, setIsAudioActiveAsync, type RecordingOptions } from "expo-audio";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { AppState, Platform } from "react-native";

import { LOCAL_VOICE_LIMITS, localVoiceProfile, type VoiceRecordingProfile } from "@/constants/voice-recording";
import type { LocalVoiceDependencies, LocalVoiceDiagnostic } from "@/services/local-voice-recording";
import { createVoiceRequestFile } from "@/services/voice-request-file";
import type { LocalVoiceFileInfo } from "@/utils/voice-recording-metadata";
import { inspectVoiceBytes } from "@/utils/voice-recording-metadata";
import { localAudioSession } from "@/services/local-audio-session";

const ownedBase = /^assistant-voice-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownedFile = /^assistant-voice-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-result)?\.(wav|m4a)$/i;

type FileClaim = { token: object; registrationOpen: boolean; phase: "recorder" | "request" | "cleanup" | "deleting"; inspecting: boolean;
  verified?: { info: LocalVoiceFileInfo; bytes: Uint8Array } };
// Shared across file-store instances in this runtime; no persisted paths or payloads.
const liveNames = new Map<string, FileClaim>();
const livePaths = new Map<string, FileClaim>();
// Only failed recorder cleanup is transferable to another store's sweep. Request owners keep their own handles.
const recorderCleanup = new Map<FileClaim, () => void>();
// A receipt only acknowledges one exact, completed recorder claim. It grants no deletion rights.
// Weak keys let facts disappear with the old reservation; no permanent/enumerable tombstone registry.
const completedRecorderCleanup = new WeakMap<object, string>();

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
  const normalized = (uri: string) => decodeURIComponent(uri).replace(/^file:\/\/\/private\/var\//, "file:///var/").replace(/\/$/, "");
  const fileFor = (name: string) => {
    if (!ownedBase.test(name)) throw new Error("unowned-recording-file");
    // native 원본과 이름을 다르게 하여 /var ↔ /private/var 같은 별칭에서도 자기 자신으로 이동하지 않는다.
    return new File(directory, name + "-result" + profile.extension);
  };
  const claims = new Map<string, FileClaim>();
  const claim = (name: string) => {
    const file = fileFor(name), existing = liveNames.get(name.toLowerCase());
    if (existing) throw new Error("recording-file-owned");
    const next: FileClaim = { token: Object.freeze({}), registrationOpen: true, phase: "recorder", inspecting: false };
    const paths = [normalized(file.uri), normalized(new File(directory, name + profile.extension).uri)];
    if (paths.some(path => livePaths.has(path))) throw new Error("recording-file-owned");
    claims.set(name, next); liveNames.set(name.toLowerCase(), next);
    for (const path of paths) livePaths.set(path, next);
    return next;
  };
  function removeOwned(name: string, authority?: FileClaim, requestOwner = false) {
    const file = fileFor(name), live = liveNames.get(name.toLowerCase());
    if (live && (claims.get(name) !== live || live.inspecting || live.phase === "request" && (!requestOwner || authority !== live))) throw new Error("recording-file-owned");
    if (authority && live !== authority) throw new Error("recording-file-owned");
    if (live) { live.phase = "deleting"; live.registrationOpen = false; }
    let deletedCount = 0;
    try {
      for (const uri of new Set([file.uri, ...(nativeFiles.get(name) ?? [])])) {
        const other = livePaths.get(normalized(uri));
        if (other && other !== live) throw new Error("recording-file-owned");
        const owned = new File(uri);
        if (owned.exists) { owned.delete(); deletedCount++; }
        if (owned.exists) throw new Error("recording-file-not-deleted");
      }
    } catch (error) {
      if (live) {
        live.phase = requestOwner ? "request" : "cleanup";
        live.verified = undefined; // Cleanup never needs to retain the audio snapshot.
        if (!requestOwner) recorderCleanup.set(live, () => {
          if (liveNames.get(name.toLowerCase()) !== live || claims.get(name) !== live || live.phase !== "cleanup") { recorderCleanup.delete(live); return; }
          if (live.inspecting) return;
          removeOwned(name, live);
        });
      }
      throw error;
    }
    nativeFiles.delete(name);
    if (live) {
      if (liveNames.get(name.toLowerCase()) === live) liveNames.delete(name.toLowerCase());
      for (const [path, owner] of livePaths) if (owner === live) livePaths.delete(path);
      claims.delete(name); live.verified = undefined; recorderCleanup.delete(live);
      if (!requestOwner) completedRecorderCleanup.set(live.token, name.toLowerCase());
    }
    return { existedBeforeDelete: deletedCount > 0, deletedCount, existsAfterDelete: false as const };
  }
  const store = {
    reserve(name: string) { return claim(name).token; },
    hasCompletedCleanup(name: string, token: object) {
      return completedRecorderCleanup.get(token) === name.toLowerCase();
    },
    isRecorderClaim(name: string, token: object) {
      const record = claims.get(name);
      return !!record && record.token === token && liveNames.get(name.toLowerCase()) === record && record.phase === "recorder";
    },
    captureNativeFile(name: string, uri: string | null, token?: object) {
      fileFor(name);
      if (!uri || !uri.startsWith("file://")) return false;
      const path = normalized(uri), root = normalized(Paths.cache.uri) + "/";
      if (path.includes("\0") || /\/(\.\.?)(\/|$)/.test(path) ||
        !(path.startsWith(root) || (platform === "ios" && path.includes("/Library/Caches/")))) return false;
      let record = claims.get(name);
      if (token !== undefined) {
        if (!record || record.token !== token || liveNames.get(name.toLowerCase()) !== record) return false;
      } else {
        // Initial direct store registration is retained for synchronous file-store consumers.
        // Native callbacks always carry the reservation token and can never allocate a new claim.
        const existing = liveNames.get(name.toLowerCase());
        if (existing && existing !== record) throw new Error("recording-file-owned");
        if (record) return false;
        record = claim(name);
      }
      if (record.phase !== "recorder" || !record.registrationOpen || record.verified) return false;
      const other = livePaths.get(path);
      if (other && other !== record) throw new Error("recording-file-owned");
      livePaths.set(path, record);
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
      for (const retry of [...recorderCleanup.values()]) retry();
      if (!directory.exists) return;
      for (const entry of directory.list()) if (entry instanceof File && ownedFile.test(entry.name)) {
        // A collected list is stale: recheck live ownership immediately before synchronous deletion.
        const path = normalized(entry.uri), root = normalized(directory.uri) + "/";
        if (path !== root + entry.name || path.includes("\0") || /\/(\.\.?)(\/|$)/.test(path)) continue;
        const base = entry.name.replace(/(-result)?\.(wav|m4a)$/i, "").toLowerCase();
        if (liveNames.has(base) || livePaths.has(normalized(entry.uri))) continue;
        entry.delete();
        if (entry.exists) throw new Error("recording-file-not-deleted");
      }
    },
    async inspect(name: string, uri: string | null, token?: object) {
      const file = fileFor(name);
      const record = claims.get(name);
      if (token !== undefined && record?.token !== token) throw new Error("recording-file-owned");
      if (record && (record.phase !== "recorder" || record.inspecting || record.verified)) throw new Error("recording-file-owned");
      const registered = Boolean(uri && [...(nativeFiles.get(name) ?? [])].some(value => normalized(value) === normalized(uri)));
      diagnose("file-source", { ...store.probe(name, registered ? uri : null), hasUri: Boolean(uri), registered });
      if (!registered) throw new Error(uri ? "unowned-recording-file" : "missing-file");
      if (!record || liveNames.get(name.toLowerCase()) !== record) throw new Error("recording-file-owned");
      record.inspecting = true;
      try {
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
        // All native URI changes observed before move completion are included below.
        // Close registration before source cleanup, not after the asynchronous bytes read.
        record.registrationOpen = false;
        // prepare가 교체한 초기 recorder의 빈 파일도 함께 정리한다. 관리 파일은 별도 이름이므로 삭제하지 않는다.
        try {
          for (const original of nativeFiles.get(name) ?? []) {
            if (normalized(original) === normalized(file.uri)) continue;
            const abandoned = new File(original);
            if (abandoned.exists) abandoned.delete();
            if (abandoned.exists) throw new Error("cleanup");
          }
        } catch { diagnose("file-cleanup-failed", { hasError: true }); throw new Error("cleanup"); }
        // Native source files are now absent. Do not retain their old paths as deletion authority:
        // a later recorder may legitimately reuse one of them.
        for (const original of nativeFiles.get(name) ?? []) {
          const path = normalized(original);
          if (path !== normalized(file.uri) && livePaths.get(path) === record) livePaths.delete(path);
        }
        nativeFiles.delete(name);
        if (file.size > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
        let bytes: Uint8Array;
        try { bytes = await file.bytes(); }
        catch { diagnose("file-read-failed", { fileExists: file.exists }); throw new Error("file-read"); }
        if (bytes.length > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
        if (bytes.length !== file.size) throw new Error("invalid-file");
        const info = Object.freeze(inspectVoiceBytes(bytes, profile));
        record.verified = { info, bytes: new Uint8Array(bytes) };
        return info;
      } finally { record.inspecting = false; }
    },
    handoff(name: string, info: LocalVoiceFileInfo) {
      const record = claims.get(name), file = fileFor(name);
      if (platform !== "ios" || profile.container !== "wav" || !record || record.phase !== "recorder" || record.inspecting ||
        liveNames.get(name.toLowerCase()) !== record || record.verified?.info !== info || !file.exists || file.size !== info.size) throw new Error("recording-file-handoff");
      let original: Uint8Array | null = record.verified.bytes;
      record.verified = undefined; // From here only the request owner holds payload bytes.
      const owner = createVoiceRequestFile({
        async read() {
          if (!original || liveNames.get(name.toLowerCase()) !== record || record.phase !== "request") throw new Error("recording-file-owned");
          if (!file.exists) throw new Error("missing-file");
          if (file.size > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
          if (file.size !== original.length) throw new Error("recording-file-changed");
          const snapshot = original;
          const bytes = await file.bytes();
          if (liveNames.get(name.toLowerCase()) !== record || record.phase !== "request" || !file.exists || file.size !== snapshot.length ||
            bytes.length !== snapshot.length || bytes.some((value, i) => value !== snapshot[i])) throw new Error("recording-file-changed");
          inspectVoiceBytes(bytes, profile);
          return bytes;
        },
        remove: () => { original = null; removeOwned(name, record, true); },
      });
      record.phase = "request";
      return owner;
    },
    remove(name: string, token?: object) {
      const record = claims.get(name);
      if (token !== undefined && (!record || record.token !== token)) throw new Error("recording-file-owned");
      return removeOwned(name, token === undefined ? undefined : record);
    },
  };
  return store;
}

export function createExpoVoiceDependencies(canStart: () => boolean): LocalVoiceDependencies {
  const profile = localVoiceProfile(Platform.OS), owner = Symbol("local-audio-session");
  let reservation: symbol | null = null;
  let fileStore: ReturnType<typeof createVoiceFileStore> | undefined;
  const files = () => fileStore ??= createVoiceFileStore(profile, Platform.OS);
  return {
    beforeStart() {
      const next = Symbol("local-recording-job"), pending = localAudioSession.beginRecording(next);
      reservation = next;
      return pending;
    },
    afterEnd(safe) {
      if (reservation) localAudioSession.endRecording(reservation, safe);
      reservation = null;
    },
    canStart, readAppState: () => AppState.currentState ?? null,
    permission: getRecordingPermissionsAsync, requestPermission: requestRecordingPermissionsAsync,
    activate: () => localAudioSession.activate(owner, () => setIsAudioActiveAsync(true)),
    configure: () => setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: "doNotMix",
      shouldPlayInBackground: false, allowsBackgroundRecording: false }),
    reset: () => localAudioSession.reset(owner, async () => {
      let failed = false;
      try { await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false, allowsBackgroundRecording: false }); } catch { failed = true; }
      try { await setIsAudioActiveAsync(false); } catch { failed = true; }
      if (failed) throw new Error("audio-session-cleanup");
    }),
    create(name, listener, reservation) {
      const fileToken = reservation ?? files().reserve(name);
      if (!files().isRecorderClaim(name, fileToken)) throw new Error("recording-file-owned"); // Reserve before native creation can create or overwrite a path.
      const options = recordingOptions(profile, name);
      // 공개 AudioModule의 SharedObject를 작업별로 소유한다. prepare shim과 같은 플랫폼 옵션을 생성자에 전달한다.
      const nativeAudio: typeof AudioModule = AudioModule;
      const recorder = new nativeAudio.AudioRecorder({ ...options, ...(Platform.OS === "ios" ? options.ios : options.android) });
      let finishedUri: string | null = null, released = false, pathConflict = false;
      const capture = (event: string) => {
        if (released || !files().isRecorderClaim(name, fileToken)) return null;
        try {
          const uri = finishedUri ?? recorder.uri;
          const registered = files().captureNativeFile(name, uri, fileToken);
          diagnose(event, { ...files().probe(name, registered ? uri : null), hasUri: Boolean(uri), registered });
          return uri;
        } catch (error) {
          if (error instanceof Error && error.message === "recording-file-owned") pathConflict = true;
          diagnose(event, { uriLookupFailed: true }); return null;
        }
      };
      capture("recorder-created");
      if (pathConflict) { released = true; recorder.release(); throw new Error("recording-file-owned"); }
      let subscription;
      try { subscription = recorder.addListener("recordingStatusUpdate", event => {
        if (released || !files().isRecorderClaim(name, fileToken) || event.id !== recorder.id) return;
        if (event.isFinished && !event.hasError && event.url) {
          finishedUri = event.url;
          capture("recorder-finished-event");
        }
        diagnose("recorder-native-event", { isFinished: event.isFinished, hasError: event.hasError });
        listener({ ...event, hasError: event.hasError || pathConflict });
      }); }
      catch (error) { released = true; recorder.release(); throw error; }
      const checkRecorder = () => {
        if (pathConflict || released || !files().isRecorderClaim(name, fileToken)) throw new Error("recording-file-owned");
      };
      return {
        async prepare() {
          checkRecorder();
          try { await recorder.prepareToRecordAsync(options); }
          catch (error) { diagnose("recorder-prepare-failed", { hasError: true }); throw error; }
          finally { capture("recorder-prepared"); }
          checkRecorder();
        },
        record: () => {
          checkRecorder();
          recorder.record({ forDuration: LOCAL_VOICE_LIMITS.durationSeconds });
        },
        status: () => { const state = recorder.getStatus(); return { ...state, isRecording: state.isRecording && recorder.isRecording }; },
        async stop() {
          checkRecorder();
          try { await recorder.stop(); diagnose("recorder-stop-completed", { stopCompleted: true }); }
          catch (error) { diagnose("recorder-stop-failed", { hasError: true }); throw error; }
          finally { capture("recorder-after-stop"); }
        },
        uri: () => capture("recorder-final-uri"),
        release() { released = true; subscription.remove(); recorder.release(); },
      };
    },
    newName: () => `assistant-voice-${randomUUID()}`,
    files: {
      sweep: () => files().sweep(),
      reserve: name => files().reserve(name),
      hasCompletedCleanup: (name, token) => files().hasCompletedCleanup(name, token),
      inspect: (name, uri, token) => files().inspect(name, uri, token),
      remove: (name, token) => files().remove(name, token),
      handoff: (name, info) => files().handoff(name, info),
    },
    setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    observe(event, detail) {
      // 경로·파일명·음성 바이트·권한 native 오류 원문을 로그에 남기지 않는다.
      if (__DEV__) console.info("[local-voice]", event, detail ?? {});
    },
  };
}
