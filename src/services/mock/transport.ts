import type { ApiTimers, ApiTransport } from "@/services/api/transport";

export type MockTransportStep = Readonly<{
  delayMs?: number;
  ignoreAbort?: boolean;
} & ({ kind: "json"; body: unknown; status?: number; headers?: Readonly<Record<string, string>> }
  | { kind: "text"; body: string; status?: number; headers?: Readonly<Record<string, string>> }
  | { kind: "network-error" }
  | { kind: "pending" })>;
export type MockTransportRoute = Readonly<{
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  steps: readonly MockTransportStep[];
}>;
export type MockTransportRequest = Readonly<{ method: string; url: string; body: string | null;
  headers: Readonly<Record<string, string>> }>;

export class MockTransportError extends Error {
  constructor(readonly code: "unregistered-route" | "missing-fixture" | "network" | "aborted") {
    // 주소·body·원래 예외를 로그에 노출하지 않는다.
    super(`mock-transport:${code}`);
    this.name = "MockTransportError";
  }
}

/** 응답 순서만 재현한다. 업무 규칙·DB·네트워크 fallback은 없다. 제품에서 자동 등록하지 않는다. */
export function createMockTransport(routes: readonly MockTransportRoute[],
  timers: ApiTimers = { setTimeout, clearTimeout }): ApiTransport & { getRequests: () => readonly MockTransportRequest[] } {
  const table = new Map<string, { index: number; steps: readonly MockTransportStep[] }>();
  for (const route of routes) {
    const key = `${route.method} ${route.url}`;
    if (table.has(key)) throw new Error("duplicate-mock-route");
    const steps = route.steps.map(step => {
      if (step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) throw new Error("invalid-mock-delay");
      // 호출 후 fixture 원본 변경은 이후 응답을 바꾸지 않는다.
      return JSON.parse(JSON.stringify(step)) as MockTransportStep;
    });
    table.set(key, { index: 0, steps });
  }
  const requests: MockTransportRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET", signal = init?.signal;
    if (signal?.aborted) throw new MockTransportError("aborted");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    requests.push(Object.freeze({ method, url, body: typeof init?.body === "string" ? init.body : null, headers: Object.freeze(headers) }));
    const route = table.get(`${method} ${url}`);
    if (!route) throw new MockTransportError("unregistered-route");
    const step = route.steps[route.index++];
    if (!step) throw new MockTransportError("missing-fixture");
    if (step.kind === "pending" || step.delayMs) await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => { if (timer !== undefined) timers.clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => { clean(); reject(new MockTransportError("aborted")); };
      if (!step.ignoreAbort) signal?.addEventListener("abort", abort, { once: true });
      if (step.kind !== "pending") timer = timers.setTimeout(() => { clean(); resolve(); }, step.delayMs ?? 0);
      if (!step.ignoreAbort && signal?.aborted) abort();
    });
    if (!step.ignoreAbort && signal?.aborted) throw new MockTransportError("aborted");
    if (step.kind === "network-error") throw new MockTransportError("network");
    if (step.kind === "pending") throw new Error("unreachable-mock-step");
    const responseHeaders = new Headers({ "Content-Type": step.kind === "json" ? "application/json" : "text/plain" });
    for (const [key, value] of Object.entries(step.headers ?? {})) responseHeaders.set(key, value);
    const status = step.status ?? 200;
    return new Response([204, 205, 304].includes(status) ? null : step.kind === "json" ? JSON.stringify(step.body) : step.body,
      { status, headers: responseHeaders });
  };
  return Object.freeze({ kind: "mock", fetchImpl, getRequests: () => Object.freeze([...requests]) });
}
