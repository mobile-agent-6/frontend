import { createStore } from "zustand/vanilla";

export type ScheduleDataMode = "mock" | "server";
export type ScheduleWriteScope = "none" | "create";

export function resolveScheduleDataMode(value: string | undefined): ScheduleDataMode {
  return value === "server" ? "server" : "mock";
}

export function resolveScheduleWriteScope(value: string | undefined): ScheduleWriteScope {
  return value === "create" ? "create" : "none";
}

// 공개 실행 설정이며 앱 시작 시 결정한다. 변경 후에는 번들을 다시 로드한다.
const writeScope = resolveScheduleWriteScope(process.env.EXPO_PUBLIC_SCHEDULE_WRITE_SCOPE);

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

// HTTP client는 /api/v1을 제외한 경로를 전달한다. 부분 일치나 경로 정규화로 허용을 넓히지 않는다.
// 생성 외 쓰기는 아직 허용하지 않으며 Mock 모드의 기존 서비스 시험 동작은 유지한다.
export function isScheduleRequestAllowed(method: string, path: string) {
  return isMockScheduleMode() || method === "GET" ||
    (writeScope === "create" && method === "POST" && path === "/schedules");
}

export const ASSISTANT_NOT_CONNECTED_MESSAGE =
  "일정 비서의 실제 서버 연동은 아직 준비 중입니다. 일정 목록에서 직접 일정을 관리해 주세요.";
