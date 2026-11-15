import { createStore } from "zustand/vanilla";

import { createConnectionSnapshot, createDevelopmentTarget, getDevelopmentServerConfig, getServerTargetSource } from "@/services/api/config";

export type ScheduleDataMode = "mock" | "server";

export function resolveScheduleDataMode(value: string | undefined): ScheduleDataMode {
  return value === "mock" ? "mock" : "server";
}

// 공개 실행 설정이며 앱 시작 시 결정한다. 변경 후에는 번들을 다시 로드한다.
const readOnly = process.env.EXPO_PUBLIC_SCHEDULE_READ_ONLY === "true";

// 실행 환경 URL·Settings·요청 성공 여부와 독립적인 명시적 경계다.
// 일반 앱은 서버를 원본으로 사용한다. Mock은 명시적인 개발·테스트 선택에 한정한다.
export const scheduleDataModeStore = createStore<{
  mode: ScheduleDataMode;
  generation: number;
  setMode: (mode: ScheduleDataMode) => void;
  resetConnectionAuthority: () => void;
}>((set) => ({
  // effect 이전에 결정해 첫 화면부터 올바른 원본을 사용한다. Expo 정적 치환 표기법을 유지한다.
  mode: resolveScheduleDataMode(process.env.EXPO_PUBLIC_SCHEDULE_DATA_MODE),
  generation: 0,
  setMode: (mode) => set((state) => state.mode === mode ? state : {
    mode, generation: state.generation + 1,
  }),
  // 동일 대상으로 돌아와도 이전 callback의 권한은 되살리지 않는다. 대상 활성화는 수행하지 않는다.
  resetConnectionAuthority: () => set(state => ({ generation: state.generation + 1 })),
}));

/** 기존 mode generation이 공통 연결 권한이다. Schedule cache 무효화 generation과 별개다. */
export function getConnectionSnapshot() {
  const state = scheduleDataModeStore.getState(), source = getServerTargetSource();
  const config = getDevelopmentServerConfig();
  return createConnectionSnapshot({ mode: state.mode, generation: state.generation, source,
    target: source === "development" && config.status === "ready" ? createDevelopmentTarget(config.config.baseUrl) : null });
}

export function isMockScheduleMode(generation?: number) {
  const current = scheduleDataModeStore.getState();
  return current.mode === "mock" && (generation === undefined || generation === current.generation);
}

// HTTP client는 /api/v1을 제외한 경로를 전달한다. 부분 일치나 경로 정규화로 허용을 넓히지 않는다.
// 허용하는 쓰기는 Schedule CRUD뿐이며 서버 권한 검사를 대체하지 않는다. Mock CRUD는 HTTP를 사용하지 않는다.
export function isScheduleRequestAllowed(method: string, path: string, query?: string) {
  if (method === "GET") return true;
  if (isMockScheduleMode() || readOnly || query || /\s/.test(path)) return false;
  if (method === "POST") return path === "/schedules";
  // ID는 기존 서비스처럼 원문을 사용한다. 경로 구분자·인코딩 우회가 없는 단일 segment만 허용한다.
  return (method === "PATCH" || method === "DELETE") && /^\/schedules\/[A-Za-z0-9_-]+$/.test(path);
}

export const ASSISTANT_NOT_CONNECTED_MESSAGE =
  "일정 비서의 실제 서버 연동은 아직 준비 중입니다. 일정 목록에서 직접 일정을 관리해 주세요.";
