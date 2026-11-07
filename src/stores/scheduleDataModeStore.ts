import { createStore } from "zustand/vanilla";

export type ScheduleDataMode = "mock" | "server";

export function resolveScheduleDataMode(value: string | undefined): ScheduleDataMode {
  return value === "server" ? "server" : "mock";
}

// 실행 환경 URL·Settings·요청 성공 여부와 독립적인 명시적 경계다.
// 서버 화면과 모든 로컬 mutation 경로가 준비되기 전에는 기본값을 변경하지 않는다.
export const scheduleDataModeStore = createStore<{
  mode: ScheduleDataMode;
  generation: number;
  setMode: (mode: ScheduleDataMode) => void;
}>((set) => ({
  // effect 이전에 결정해 첫 화면부터 올바른 원본을 사용한다. Expo 정적 치환 표기법을 유지한다.
  mode: resolveScheduleDataMode(process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE),
  generation: 0,
  setMode: (mode) => set((state) => state.mode === mode ? state : {
    mode, generation: state.generation + 1,
  }),
}));

export function isMockScheduleMode(generation?: number) {
  const current = scheduleDataModeStore.getState();
  return current.mode === "mock" && (generation === undefined || generation === current.generation);
}

// E-0의 백엔드 GET 전용 허용 범위다. CRUD 허용 후 이 정책과 화면 잠금을 함께 교체한다.
// 서버 모드 자체는 개발/배포 빌드 모두 사용할 수 있다.
export function isScheduleRequestAllowed(method: string) {
  return method === "GET" || isMockScheduleMode();
}

export const ASSISTANT_NOT_CONNECTED_MESSAGE =
  "일정 비서의 실제 서버 연동은 아직 준비 중입니다. 일정 목록에서 직접 일정을 관리해 주세요.";
