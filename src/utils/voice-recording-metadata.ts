import { LOCAL_VOICE_LIMITS, type VoiceRecordingProfile } from "@/constants/voice-recording";

export type LocalVoiceFileInfo = {
  container: "wav" | "m4a";
  codec: "PCM_S16LE" | "unverified";
  size: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  durationMillis?: number;
};

// 크기를 제한한 로컬 시험 파일만 검사한다. 변환이나 음성 내용 분석은 하지 않는다.
export function inspectVoiceBytes(bytes: Uint8Array, profile: VoiceRecordingProfile): LocalVoiceFileInfo {
  if (!(bytes instanceof Uint8Array) || bytes.length > LOCAL_VOICE_LIMITS.maxBytes) throw new Error("file-too-large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, length = 4) => String.fromCharCode(...bytes.slice(at, at + length));
  const invalid = () => { throw new Error("invalid-recording-file"); };
  if (profile.container === "wav") {
    if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) return invalid();
    let format: { sampleRate: number; channels: number; bitDepth: number; alignment: number; byteRate: number } | undefined;
    let dataSize: number | undefined;
    for (let offset = 12; offset < bytes.length;) {
      if (bytes.length - offset < 8) return invalid();
      const size = view.getUint32(offset + 4, true), start = offset + 8;
      if (size > bytes.length - start || size % 2 && start + size === bytes.length) return invalid();
      if (tag(offset) === "fmt ") {
        if (format || size < 16) return invalid();
        const code = view.getUint16(start, true);
        const pcmGuid = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (code === 1) {
          // PCM can use WAVEFORMAT (16 bytes) or WAVEFORMATEX with a bounded extension.
          if (size !== 16 && (size < 18 || view.getUint16(start + 16, true) !== size - 18)) return invalid();
        } else if (code === 65534) {
          if (size < 40 || view.getUint16(start + 16, true) < 22 || view.getUint16(start + 16, true) !== size - 18 ||
            view.getUint16(start + 18, true) !== 16 || !pcmGuid.every((value, i) => bytes[start + 24 + i] === value)) return invalid();
        } else return invalid();
        format = { sampleRate: view.getUint32(start + 4, true), channels: view.getUint16(start + 2, true),
          bitDepth: view.getUint16(start + 14, true), alignment: view.getUint16(start + 12, true), byteRate: view.getUint32(start + 8, true) };
      } else if (tag(offset) === "data") {
        if (dataSize !== undefined) return invalid();
        dataSize = size;
      }
      offset = start + size + (size % 2);
    }
    if (!format || dataSize === undefined || dataSize <= 0 || format.sampleRate !== profile.sampleRate || format.channels !== profile.channels ||
      format.bitDepth !== profile.bitDepth || format.alignment !== format.channels * format.bitDepth / 8 ||
      format.byteRate !== format.sampleRate * format.alignment || dataSize % format.alignment !== 0) return invalid();
    const durationMillis = dataSize / format.alignment / format.sampleRate * 1000;
    if (durationMillis > LOCAL_VOICE_LIMITS.durationSeconds * 1000) throw new Error("file-too-long");
    return { container: "wav", codec: "PCM_S16LE", size: bytes.length, sampleRate: format.sampleRate, channels: format.channels,
      bitDepth: format.bitDepth, durationMillis };
  }
  // MP4 컨테이너만 확인한다. 실제 AAC 코덱·sample rate·channels는 미검증으로 구분한다.
  let ftyp = false, moov = false, mdat = false;
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset), end = size === 0 ? bytes.length : offset + size;
    if (size === 1 || end > bytes.length || end < offset + 8) return invalid();
    const type = tag(offset + 4);
    if (type === "ftyp" && end - offset >= 16) ftyp = true;
    if (type === "moov" && end - offset > 8) moov = true;
    if (type === "mdat" && end - offset > 8) mdat = true;
    offset = end;
  }
  if (!ftyp || !moov || !mdat) return invalid();
  return { container: "m4a", codec: "unverified", size: bytes.length };
}
