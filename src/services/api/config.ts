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
 * 설정이 없더라도 Settings의 Pi IP나 Mock 주소를 대신 사용하지 않는다.
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
  // Pi는 후속 격리·저장 단계 전까지 업무 client에 공개하지 않는다. 개발 주소로 fallback하지 않는다.
  const source = getServerTargetSource();
  if (source !== "development") return { status: source === "pi" ? "missing" : "invalid" };
  // Expo가 공개 환경 변수를 치환할 수 있도록 정적인 점 표기법을 유지한다.
  return parseDevelopmentServerConfig(process.env.EXPO_PUBLIC_DEV_SERVER_BASE_URL);
}

export type ServerTargetSource = "development" | "pi";
export type TransportKind = "http" | "mock";
export type ServerTarget = Readonly<DevelopmentServerConfig & {
  source: ServerTargetSource;
  transport: TransportKind;
}>;

// 기존 실행 명령은 미설정 시 development를 유지한다. 새 선택이 잘못됐으면 자동 대체하지 않는다.
export function parseServerTargetSource(value: string | undefined): ServerTargetSource | "invalid" {
  return value === undefined || value === "development" ? "development" : value === "pi" ? "pi" : "invalid";
}

export function getServerTargetSource() {
  return parseServerTargetSource(process.env.EXPO_PUBLIC_SERVER_TARGET);
}

export function parseCanonicalIpv4(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(input)) return null;
  return input.split(".").every(part => Number(part) <= 255) ? input : null;
}

function target(source: ServerTargetSource, baseUrl: string, transport: TransportKind): ServerTarget {
  return Object.freeze({ source, transport, baseUrl, apiBaseUrl: `${baseUrl}/api/v1`,
    // origin 기반 식별이며 장비·DB의 동일성이나 서버 재시작을 증명하지 않는다.
    serverId: `${transport === "mock" ? "mock:" : ""}${source}:${baseUrl}` });
}

export function createDevelopmentTarget(value: string | undefined, transport: TransportKind = "http"): ServerTarget | null {
  if (transport !== "http" && transport !== "mock") return null;
  const parsed = parseDevelopmentServerConfig(value);
  return parsed.status === "ready" ? target("development", parsed.config.baseUrl, transport) : null;
}

/** 검증 후보 생성일 뿐이다. Health 성공·저장·업무 API 권한을 부여하지 않는다. */
export function createPiCandidate(value: unknown, transport: TransportKind = "http"): ServerTarget | null {
  if (transport !== "http" && transport !== "mock") return null;
  const ip = parseCanonicalIpv4(value);
  return ip === null ? null : target("pi", `http://${ip}:8000`, transport);
}

export function isServerTarget(value: unknown): value is ServerTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.transport !== "http" && item.transport !== "mock") return false;
  let canonical: ServerTarget | null = null;
  if (item.source === "development" && typeof item.baseUrl === "string") {
    canonical = createDevelopmentTarget(item.baseUrl, item.transport);
  } else if (item.source === "pi" && typeof item.baseUrl === "string") {
    const match = /^http:\/\/([^/]+):8000$/.exec(item.baseUrl);
    if (match) canonical = createPiCandidate(match[1], item.transport);
  }
  return canonical !== null && ["baseUrl", "apiBaseUrl", "serverId"].every(key =>
    item[key] === canonical[key as keyof ServerTarget]);
}

export type ConnectionSnapshot = Readonly<{
  environment: "mock" | "development" | "pi" | "verification" | "invalid";
  dataMode: "mock" | "server";
  target: ServerTarget | null;
  generation: number;
  active: boolean;
  businessAccess: "development" | "blocked";
}>;

/** Settings가 맡을 네 역할의 경계만 정의한다. 저장 schema·복원·활성화는 아직 연결하지 않는다. */
export type ConnectionSelection = Readonly<{
  input: string;
  candidate: ServerTarget | null;
  saved: ServerTarget | null;
  active: ConnectionSnapshot;
}>;

export function createConnectionSnapshot({ mode, generation, source, target: candidate = null }: {
  mode: "mock" | "server";
  generation: number;
  source: ServerTargetSource | "invalid";
  target?: ServerTarget | null;
}): ConnectionSnapshot {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("invalid-connection-generation");
  const valid = candidate !== null && isServerTarget(candidate) && candidate.source === source;
  const bound = valid ? Object.freeze({ ...candidate }) : null;
  // 1단계는 기존 development HTTP만 업무 대상으로 허용한다. Pi·검수는 후보 표현만 가능하다.
  const active = mode === "server" && source === "development" && bound?.transport === "http";
  return Object.freeze({ dataMode: mode, generation, target: bound, active,
    businessAccess: active ? "development" : "blocked",
    environment: source === "invalid" || (candidate !== null && !valid) ? "invalid"
      : mode === "mock" ? "mock" : bound?.transport === "mock" ? "verification" : source });
}
