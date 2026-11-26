// 표시와 입력 차단만 위한 UI 값이다. AssistantStatus·API 상태·녹음 실행 상태 머신이 아니다.
export type AssistantInputUi =
  | { source: "text" }
  | { source: "voice"; phase: "recording" | "stopping" | "recorded" | "permission-error" |
      "recording-error" | "recognizing" | "processing" | "stt-error" };

export function isVoiceInputBusy(input: AssistantInputUi): boolean {
  return input.source === "voice" && ["recording", "stopping", "recognizing", "processing"].includes(input.phase);
}
