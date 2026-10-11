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
