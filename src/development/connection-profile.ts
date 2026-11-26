import { createMockTransport, type MockTransportStep } from "@/services/mock/transport";
import type { ApiTransport } from "@/services/api/transport";

export const connectionProfiles = ["local", "normal", "zero", "limit", "over", "health-error", "sync-error", "sync-lost", "final-health-error", "save-error", "not-adjusted", "switch-error"] as const;
export type ConnectionProfile = typeof connectionProfiles[number];
/** Development response scripts only. No validation, persistence or business client lives here. */
export function createConnectionProfile(profile: ConnectionProfile) {
  let wall = Date.now();
  const clock = { now: () => (wall = Date.now()), monotonicNow: () => 0 };
  const counts = new Map<string, number>(), phases = new Map<string, number>();
  const finalHealthFailures = new Map<string, number>();
  let healthCount = 0;
  const trace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const id = "11111111-1111-4111-8111-111111111111", createdId = "22222222-2222-4222-8222-222222222222";
  // Schedule snapshots stay stable across reads/server switches. System API clocks remain dynamic.
  const scheduleTime = new Date().toISOString();
  const json = (body: unknown, status = 200): MockTransportStep => ({ kind: "json", body, status, headers: { "Content-Type": "application/json", "X-Request-ID": trace } });
  const problem = (status: number, code: string): MockTransportStep => ({ kind: "json", status,
    headers: { "Content-Type": "application/problem+json", "X-Request-ID": trace }, body: {
      type: "about:blank", title: "검수 응답", detail: "검수용 오류 응답입니다.", status, code, requestId: trace, instance: "/fixture",
    } });
  const transport: ApiTransport = Object.freeze({ kind: "mock", fetchImpl: (async (input, options) => {
    const url = new URL(String(input)), method = options?.method ?? "GET", key = `${method} ${url.origin}${url.pathname}`;
    if (profile !== "local" && !["192.0.2.10", "192.0.2.20"].includes(url.hostname)) throw new Error("unregistered-profile-target");
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    const label = url.hostname === "192.0.2.20" ? "B" : "A";
    const dto = (scheduleId: string, title: string) => ({ id: scheduleId, title, scheduledAt: scheduleTime,
      completed: false, category: "OTHER", createdAt: scheduleTime, updatedAt: scheduleTime });
    const original = dto(id, `${label} 검수 일정`), created = dto(createdId, `${label} 추가 검수 일정`);
    let step: MockTransportStep;
    if (url.pathname === "/health" && method === "GET") {
      healthCount++;
      const offset = profile === "limit" ? 60_000 : profile === "over" ? 61_000 : profile === "normal" ? 2_000 : 0;
      const finalFailure = profile === "final-health-error" && (finalHealthFailures.get(url.origin) ?? 0) > 0;
      if (finalFailure) finalHealthFailures.set(url.origin, finalHealthFailures.get(url.origin)! - 1);
      step = profile === "health-error" || (profile === "switch-error" && healthCount > 2) || finalFailure
        ? problem(503, "DATABASE_UNAVAILABLE") : json({ status: "ok", apiVersion: "v1", serverTime: new Date(wall + offset).toISOString() });
    } else if (url.pathname === "/api/v1/system/time-sync" && method === "POST") {
      const time = JSON.parse(String(options?.body)).currentTime;
      if (profile === "final-health-error") finalHealthFailures.set(url.origin, 2);
      step = profile === "sync-error" ? problem(503, "TIME_SYNC_UNAVAILABLE") : profile === "sync-lost" && count === 1 ? { kind: "pending" }
        : json({ adjusted: profile !== "not-adjusted", previousServerTime: new Date(wall).toISOString(), serverTime: time });
    } else if (url.pathname === "/api/v1/schedules" && method === "GET") {
      const phase = phases.get(url.origin) ?? 0;
      const items = phase === 1 ? [original, created] : phase === 2 ? [dto(id, `${label} 수정 검수 일정`)] : phase === 3 ? [] : [original];
      step = json({ items });
    } else if (url.pathname === "/api/v1/schedules" && method === "POST") {
      phases.set(url.origin, 1); step = json(created, 201);
    } else if (/^\/api\/v1\/schedules\/[\da-f-]+$/.test(url.pathname)) {
      if (method === "PATCH") { phases.set(url.origin, 2); step = json(dto(url.pathname.split("/").at(-1)!, `${label} 수정 검수 일정`)); }
      else if (method === "DELETE") { phases.set(url.origin, 3); step = json(null, 204); }
      else step = json(original);
    } else if (url.pathname === "/api/v1/assistant/requests" && method === "POST") {
      const request = JSON.parse(String(options?.body)); step = json({ requestId: request.requestId, conversationId: trace, status: "accepted" }, 202);
    } else if (/^\/api\/v1\/assistant\/requests\/[\da-f-]+$/.test(url.pathname) && method === "GET") {
      step = json({ requestId: url.pathname.split("/").at(-1), conversationId: trace, status: "completed",
        result: { kind: "outcome", text: `${label} 검수 일정 조회 결과입니다.`, outcome: "success", operation: "list", schedulesChanged: false,
          items: [{ id: original.id, title: original.title, scheduledAt: original.scheduledAt, category: original.category, completed: original.completed, updatedAt: original.updatedAt }] } });
    } else throw new Error("unregistered-profile-route");
    return createMockTransport([{ method: method as "GET" | "POST" | "PATCH" | "DELETE", url: String(input), steps: [step] }]).fetchImpl(input, options);
  }) as typeof fetch });
  return { transport, clock };
}
