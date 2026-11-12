export type DevelopmentServerConfig = {
  baseUrl: string;
  apiBaseUrl: string;
  serverId: string;
};

export type DevelopmentServerConfigResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ready"; config: DevelopmentServerConfig };

/**
 * EXPO_PUBLIC_DEV_SERVER_BASE_URL에는 HTTP(S) origin만 지정한다.
 * 끝의 슬래시는 제거하며 /api/v1, 인증 정보, 쿼리, 프래그먼트는 허용하지 않는다.
 * Expo 공개 환경 변수는 앱에 포함되므로 비밀 정보를 저장하지 않는다.
 * 실제 검증·저장 주소는 아래 실행 설정으로 복원한다. 과거 Mock Pi IP는 자동으로 사용하지 않는다.
 */
export function parseDevelopmentServerConfig(
  value: string | undefined,
): DevelopmentServerConfigResult {
  const input = value?.trim();
  if (!input) return { status: "missing" };

  // URL 파서가 경로나 역슬래시를 자동 정규화하기 전에 원래 입력을 검사한다.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(input) || input.includes("@")) {
    return { status: "invalid" };
  }

  try {
    const url = new URL(input);
    if (!url.hostname || url.username || url.password) {
      return { status: "invalid" };
    }

    const baseUrl = url.origin;
    return {
      status: "ready",
      config: {
        baseUrl,
        // 서비스는 이 API 기준 주소에 /api/v1을 제외한 하위 경로를 붙인다.
        apiBaseUrl: `${baseUrl}/api/v1`,
        // 향후 캐시·요청을 서버별로 구분하는 값이며 서버 인스턴스 ID는 아니다.
        serverId: `development:${baseUrl}`,
      },
    };
  } catch {
    // 입력된 URL이나 접속 정보를 오류에 포함하지 않는다.
    return { status: "invalid" };
  }
}

export function getDevelopmentServerConfig(): DevelopmentServerConfigResult {
  if (savedConfiguration !== undefined) return savedConfiguration;
  // Expo가 공개 환경 변수를 치환할 수 있도록 정적인 점 표기법을 유지한다.
  return parseDevelopmentServerConfig(process.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL);
}

// 저장 주소의 복원·변경을 모든 HTTP 계층이 같은 시점에 관측한다.
let savedConfiguration: DevelopmentServerConfigResult | undefined;
const configurationListeners = new Set<() => void>();
export function setServerConfiguration(baseUrl: string | null) {
  const next = parseDevelopmentServerConfig(baseUrl ?? undefined);
  const previous = getDevelopmentServerConfig();
  savedConfiguration = next;
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    for (const listener of [...configurationListeners]) listener();
  }
}
export function subscribeServerConfiguration(listener: () => void) {
  configurationListeners.add(listener);
  return () => { configurationListeners.delete(listener); };
}
