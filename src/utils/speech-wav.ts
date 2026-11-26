import { SPEECH_MAX_BYTES } from "@/services/api/voice";

/** Output PCM validation. No recording sample-rate, duration or 1 MiB assumptions. */
export function inspectSpeechWav(bytes: Uint8Array) {
  const invalid = (): never => { throw new Error("invalid-speech-wav"); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length > SPEECH_MAX_BYTES) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) return invalid();
  let format: { sampleRate: number; channels: number; bitDepth: number; blockAlign: number; byteRate: number } | undefined;
  let dataSize: number | undefined;
  for (let at = 12; at < bytes.length;) {
    if (bytes.length - at < 8) return invalid();
    const size = view.getUint32(at + 4, true), start = at + 8;
    if (size > bytes.length - start || size % 2 && start + size === bytes.length) return invalid();
    if (tag(at) === "fmt ") {
      if (format || size < 16) return invalid();
      const code = view.getUint16(start, true), bits = view.getUint16(start + 14, true);
      if (code === 1) {
        if (size !== 16 && (size < 18 || view.getUint16(start + 16, true) !== size - 18)) return invalid();
      } else if (code === 65534) {
        const guid = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (size < 40 || view.getUint16(start + 16, true) !== size - 18 || view.getUint16(start + 16, true) < 22 ||
          view.getUint16(start + 18, true) !== bits || !guid.every((n, i) => bytes[start + 24 + i] === n)) return invalid();
      } else return invalid();
      format = { channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true), blockAlign: view.getUint16(start + 12, true), bitDepth: bits };
    } else if (tag(at) === "data") {
      if (dataSize !== undefined) return invalid();
      dataSize = size;
    }
    at = start + size + size % 2;
  }
  if (!format || !dataSize || !format.channels || !format.sampleRate || ![8, 16, 24, 32].includes(format.bitDepth) ||
    format.blockAlign !== format.channels * format.bitDepth / 8 || format.byteRate !== format.sampleRate * format.blockAlign ||
    dataSize % format.blockAlign) return invalid();
  return { ...format, size: bytes.length, durationMillis: dataSize / format.byteRate * 1000 };
}
