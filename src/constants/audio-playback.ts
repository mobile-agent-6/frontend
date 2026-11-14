// TTS 최종 규격이 아니다. 녹음용 15초/1MiB 제한과 분리하고 native decoder로 재생한다.
export const LOCAL_AUDIO_PLAYBACK_FORMATS = ["wav", "mp3", "m4a"] as const;
export const LOCAL_AUDIO_PLAYBACK_OPTIONS = {
  updateInterval: 100,
  downloadFirst: false,
  keepAudioSessionActive: true,
  allowsExternalPlayback: false,
} as const;
