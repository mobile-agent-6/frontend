export type MockSettingsScenario =
  | "connected"
  | "time-sync-required"
  | "connection-failed";

// 개발 시 이 값으로 시나리오를 선택한다. IP 문자열과는 무관하다.
export const SETTINGS_MOCK_SCENARIO: MockSettingsScenario = "time-sync-required";

export type MockConnectionResult =
  | { outcome: "failed"; ip: string; message: string }
  | {
      outcome: "success";
      ip: string;
      piTime: number;
      phoneTime: number;
      timeDifferenceSeconds: number;
    };

// UI 로딩 확인용 지연이며 실제 API timeout/RTT 계약이 아니다.
export async function checkMockSettingsConnection(
  ip: string,
  scenario: MockSettingsScenario = SETTINGS_MOCK_SCENARIO,
  delayMs = 600,
): Promise<MockConnectionResult> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

  if (scenario === "connection-failed") {
    return {
      outcome: "failed",
      ip,
      message: "Pi에 연결하지 못했습니다. 주소를 확인한 뒤 다시 시도하세요.",
    };
  }

  // 동일한 고정 기준 시점의 두 시각이다. 실제 휴대폰/서버 시각을 읽지 않는다.
  const phoneTime = new Date(2026, 8, 14, 17, 42).getTime();
  const piTime = phoneTime + (scenario === "connected" ? 0 : -120_000);

  return {
    outcome: "success",
    ip,
    piTime,
    phoneTime,
    timeDifferenceSeconds: (piTime - phoneTime) / 1000,
  };
}

export type MockTimeSyncScenario = "adjusted" | "not-adjusted" | "failed";
export type MockReverificationScenario =
  | "connected"
  | "time-sync-required"
  | "connection-failed";

// 동기화/재검증 fixture 선택. 최초 연결 시나리오는 변경하지 않는다.
export const SETTINGS_MOCK_SYNC_SCENARIO: MockTimeSyncScenario = "adjusted";
export const SETTINGS_MOCK_REVERIFICATION_SCENARIO: MockReverificationScenario =
  "connected";

export type MockTimeSyncResult =
  | { outcome: "failed"; ip: string; message: string }
  | {
      outcome: "success";
      ip: string;
      adjusted: boolean;
      referenceTime: number;
      piTimeAtReference: number;
    };

export async function syncMockSettingsTime(
  ip: string,
  currentTime: number,
  scenario: MockTimeSyncScenario = SETTINGS_MOCK_SYNC_SCENARIO,
  delayMs = 600,
): Promise<MockTimeSyncResult> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  if (scenario === "failed") {
    return {
      outcome: "failed",
      ip,
      message: "Pi 시간 맞추기에 실패했습니다. 다시 시도하세요.",
    };
  }
  // not-adjusted fixture는 명령 없이 이미 시간이 일치하는 결과를 재현한다.
  // 실제 기기 시각은 변경하지 않으며 이 결과만으로 검증 성공을 판정하지 않는다.
  return {
    outcome: "success",
    ip,
    adjusted: scenario === "adjusted",
    referenceTime: currentTime,
    piTimeAtReference: currentTime,
  };
}

export async function reverifyMockSettingsConnection(
  syncResult: Extract<MockTimeSyncResult, { outcome: "success" }>,
  scenario: MockReverificationScenario = SETTINGS_MOCK_REVERIFICATION_SCENARIO,
  delayMs = 600,
): Promise<MockConnectionResult> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  const ip = syncResult.ip;
  if (scenario === "connection-failed") {
    return {
      outcome: "failed",
      ip,
      message: "시간 맞추기 후 연결을 확인하지 못했습니다. 다시 연결 확인을 해주세요.",
    };
  }
  // 재검증 시점의 휴대폰 시각과 같은 기준 시점의 Mock Pi 시각을 생성한다.
  // RTT 측정이 아니며 동기화 결과에 기록된 기준 시각으로 Mock 시각을 진행시킨다.
  const phoneTime = Date.now();
  const elapsed = phoneTime - syncResult.referenceTime;
  const piTime =
    syncResult.piTimeAtReference + elapsed +
    (scenario === "time-sync-required" ? -120_000 : 0);
  return {
    outcome: "success",
    ip,
    piTime,
    phoneTime,
    timeDifferenceSeconds: (piTime - phoneTime) / 1000,
  };
}
