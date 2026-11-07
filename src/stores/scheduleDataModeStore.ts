import { createStore } from "zustand/vanilla";

export type ScheduleDataMode = "mock" | "server";

// 실행 환경 URL·Settings·요청 성공 여부와 독립적인 명시적 경계다.
// 서버 화면과 모든 로컬 mutation 경로가 준비되기 전에는 기본값을 변경하지 않는다.
export const scheduleDataModeStore = createStore<{
  mode: ScheduleDataMode;
  generation: number;
  setMode: (mode: ScheduleDataMode) => void;
}>((set) => ({
  mode: "mock",
  generation: 0,
  setMode: (mode) => set((state) => state.mode === mode ? state : {
    mode, generation: state.generation + 1,
  }),
}));

export function isMockScheduleMode(generation?: number) {
  const current = scheduleDataModeStore.getState();
  return current.mode === "mock" && (generation === undefined || generation === current.generation);
}

export const ASSISTANT_NOT_CONNECTED_MESSAGE =
  "일정 비서의 실제 서버 연동은 아직 준비 중입니다. 일정 목록에서 직접 일정을 관리해 주세요.";
