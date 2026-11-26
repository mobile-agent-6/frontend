// 공개 음성 입력은 WAV/PCM S16LE·16kHz·mono·16-bit다. AAC는 Android 로컬 녹음 전용이다.
export const VOICE_RECORDING_PROFILES = {
  wav: { container: "wav", extension: ".wav", codec: "PCM_S16LE", sampleRate: 16000, channels: 1, bitDepth: 16, bitRate: 256000 },
  aac: { container: "m4a", extension: ".m4a", codec: "aac", sampleRate: 16000, channels: 1, bitDepth: null, bitRate: 64000 },
} as const;

// iPhone은 확정 WAV 입력 규격을 사용한다. 형식 선택용 제품 UI는 없다.
export const LOCAL_VOICE_PROFILE: keyof typeof VOICE_RECORDING_PROFILES = "wav";
// 확정 입력 제한이며 TTS 출력에 강제하지 않는다. 실제 전송·재생 연결은 후속 단계다.
export const LOCAL_VOICE_LIMITS = { durationSeconds: 15, maxBytes: 1_048_576 } as const;
export type VoiceRecordingProfile = (typeof VOICE_RECORDING_PROFILES)[keyof typeof VOICE_RECORDING_PROFILES];

export function localVoiceProfile(platform: string): VoiceRecordingProfile {
  // Android MediaRecorder의 공개 옵션에는 WAV/PCM 출력 조합이 없다. AAC로 명시적으로 시험한다.
  return VOICE_RECORDING_PROFILES[platform === "android" ? "aac" : LOCAL_VOICE_PROFILE];
}
