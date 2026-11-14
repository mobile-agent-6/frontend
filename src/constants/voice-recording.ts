// BE-PROPOSED 로컬 시험 설정. 공개 STT/TTS 계약·Content-Type·제품 제한이 아니다.
export const VOICE_RECORDING_PROFILES = {
  wav: { container: "wav", extension: ".wav", codec: "PCM_S16LE", sampleRate: 16000, channels: 1, bitDepth: 16, bitRate: 256000 },
  aac: { container: "m4a", extension: ".m4a", codec: "aac", sampleRate: 16000, channels: 1, bitDepth: null, bitRate: 64000 },
} as const;

// iPhone 대체 후보 시험은 이 값만 "aac"로 바꾼다. 형식 선택용 제품 UI는 없다.
export const LOCAL_VOICE_PROFILE: keyof typeof VOICE_RECORDING_PROFILES = "wav";
// 최신 제안의 STT/TTS Content-Type은 audio/wav다. 이 단계에는 헤더 전송·TTS 구현이 없다.
export const LOCAL_VOICE_LIMITS = { durationSeconds: 15, maxBytes: 1_048_576 } as const;
export type VoiceRecordingProfile = (typeof VOICE_RECORDING_PROFILES)[keyof typeof VOICE_RECORDING_PROFILES];

export function localVoiceProfile(platform: string): VoiceRecordingProfile {
  // Android MediaRecorder의 공개 옵션에는 WAV/PCM 출력 조합이 없다. AAC로 명시적으로 시험한다.
  return VOICE_RECORDING_PROFILES[platform === "android" ? "aac" : LOCAL_VOICE_PROFILE];
}
