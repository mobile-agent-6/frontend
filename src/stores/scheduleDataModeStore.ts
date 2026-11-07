import { createStore } from "zustand/vanilla";

export type ScheduleDataMode = "mock" | "server";
export type ScheduleWriteScope = "none" | "create" | "target-patch" | "target-delete";

export function resolveScheduleDataMode(value: string | undefined): ScheduleDataMode {
  return value === "server" ? "server" : "mock";
}

export function resolveScheduleWriteScope(value: string | undefined): ScheduleWriteScope {
  return value === "create" || value === "target-patch" || value === "target-delete" ? value : "none";
}

/** Schedule ID의 UUID 버전은 제한하지 않는다. 공백 제거·대소문자 변환으로 허용 대상을 넓히지 않는다. */
export function resolveScheduleWriteTargetId(value: string | undefined): string | null {
  return value?.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// 공개 실행 설정이며 앱 시작 시 결정한다. 변경 후에는 번들을 다시 로드한다.
const writeScope = resolveScheduleWriteScope(process.env.EXPO_PUBLIC_SCHEDULE_WRITE_SCOPE);
const writeTargetId = resolveScheduleWriteTargetId(process.env.EXPO_PUBLIC_SCHEDULE_WRITE_TARGET_ID);

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
// 클라이언트 시험 범위 제한이며 서버 권한 검사를 대체하지 않는다. Mock CRUD는 기존 동작을 유지한다.
export function isScheduleRequestAllowed(method: string, path: string, query?: string) {
  if (isMockScheduleMode() || method === "GET") return true;
  if (query) return false;
  if (writeScope === "create") return method === "POST" && path === "/schedules";
  if (!writeTargetId || path !== `/schedules/${writeTargetId}`) return false;
  return (writeScope === "target-patch" && method === "PATCH") ||
    (writeScope === "target-delete" && method === "DELETE");
}

export const ASSISTANT_NOT_CONNECTED_MESSAGE =
  "일정 비서의 실제 서버 연동은 아직 준비 중입니다. 일정 목록에서 직접 일정을 관리해 주세요.";
