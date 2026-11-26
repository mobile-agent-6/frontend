import { fetch as expoFetch } from "expo/fetch";

import type { TransportKind } from "@/services/api/config";

/** 기존 client의 fetchImpl에도 같은 함수를 주입한다. 정책·DTO 검증은 서비스에 남긴다. */
export type ApiTransport = Readonly<{ kind: TransportKind; fetchImpl: typeof fetch }>;
export type ApiTimers = {
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

// 명시적인 HTTP 선택만 허용한다. 생성·import는 I/O가 없으며 Mock fallback으로 사용하지 않는다.
export function createHttpTransport(): ApiTransport {
  return Object.freeze({ kind: "http", fetchImpl: expoFetch });
}
