import { scheduleHttpClient, type HttpError } from "@/services/api/http";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { scheduleQueryKey, serverScheduleStore } from "@/stores/serverScheduleStore";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import type { ScheduleListQuery } from "@/utils/schedule-query";
import { isAssistantUuidV4, parseAssistantRequestStatusResponse } from "@/utils/assistant-validation";

export type AssistantScheduleSyncEntry = Readonly<{
  reference: Readonly<AssistantRecoveryReference>;
  phase: "refreshing" | "synchronized" | "refresh-error" | "interrupted";
  failedQueries: readonly ScheduleListQuery[];
  errors: readonly { query: ScheduleListQuery; error: HttpError | null }[];
}>;
const keyOf = (reference: AssistantRecoveryReference) => JSON.stringify([reference.serverId, reference.requestId.toLowerCase()]);
function immutable<T>(value: T): T {
  const freeze = (item: unknown) => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  const copy: T = JSON.parse(JSON.stringify(value)); freeze(copy); return copy;
}

// 채팅·복구 metadata와 별개인 실행 세션의 GET 동기화 상태다. 서버 write·영속 저장은 수행하지 않는다.
export function createAssistantScheduleSync({ cache = serverScheduleStore, readServerId = scheduleHttpClient.getServerId,
  mode = scheduleDataModeStore }: {
  cache?: Pick<typeof serverScheduleStore, "refreshAfterExternalChange" | "store">;
  readServerId?: () => string | null;
  mode?: Pick<typeof scheduleDataModeStore, "getState">;
} = {}) {
  const entries = new Map<string, AssistantScheduleSyncEntry>();
  const changes = new Map<string, readonly string[]>();
  const flights = new Map<string, Promise<AssistantScheduleSyncEntry>>();
  const subscribers = new Set<() => void>();
  let snapshot: readonly AssistantScheduleSyncEntry[] = Object.freeze([]);
  let tail: Promise<unknown> = Promise.resolve();
  function publish(entry: AssistantScheduleSyncEntry) {
    const saved = immutable(entry);
    entries.set(keyOf(entry.reference), saved);
    snapshot = Object.freeze([...entries.values()]);
    for (const listener of [...subscribers]) { try { listener(); } catch {} }
    return saved;
  }
  function refresh(reference: AssistantRecoveryReference, retry = false) {
    const ref = Object.freeze({ serverId: reference.serverId, requestId: reference.requestId.toLowerCase() });
    const key = keyOf(ref), previous = entries.get(key), flight = flights.get(key);
    if (flight) return flight;
    if ((!retry && previous) || !changes.has(key)) return Promise.resolve(previous ?? null);
    const generation = mode.getState().generation;
    const current = () => readServerId() === ref.serverId && mode.getState().mode === "server" && mode.getState().generation === generation;
    if (!current()) return Promise.resolve(previous ?? null);
    // publish 구독자의 동기 재진입도 같은 Promise를 사용하도록 실행을 마이크로태스크로 예약한다.
    const promise = tail.then(async () => {
      publish({ reference: ref, phase: "refreshing", failedQueries: previous?.failedQueries ?? [], errors: previous?.errors ?? [] });
      try {
        const result = await cache.refreshAfterExternalChange(ref.serverId, changes.get(key)!, {
          isCurrent: current, ...(retry && previous?.failedQueries.length ? { retryQueries: [...previous.failedQueries] } : {}),
        });
        const interrupted = result.interrupted || !current();
        const entry: AssistantScheduleSyncEntry = { reference: ref,
          phase: interrupted ? "interrupted" : result.ok ? "synchronized" : "refresh-error",
          failedQueries: result.failedQueries.map(query => ({ ...query })),
          errors: result.failedQueries.map(query => ({ query: { ...query },
            error: cache.store.getState().servers[ref.serverId]?.queries[scheduleQueryKey(ref.serverId, query)]?.error ?? null })) };
        return publish(entry);
      } catch {
        const entry: AssistantScheduleSyncEntry = { reference: ref, phase: current() ? "refresh-error" : "interrupted",
          failedQueries: previous?.failedQueries ?? [], errors: previous?.errors ?? [] };
        return publish(entry);
      }
    }).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
    tail = promise.catch(() => undefined);
    flights.set(key, promise);
    return promise;
  }
  function observe(reference: AssistantRecoveryReference, value: unknown) {
    const data = parseAssistantRequestStatusResponse(value);
    if (!isAssistantUuidV4(reference.requestId) || !data || data.requestId.toLowerCase() !== reference.requestId.toLowerCase() ||
      data.status !== "completed" || data.result.kind !== "outcome" || data.result.outcome !== "success" ||
      data.result.operation === "list" || !data.result.schedulesChanged || readServerId() !== reference.serverId || mode.getState().mode !== "server")
      return Promise.resolve(null);
    const key = keyOf(reference);
    if (!changes.has(key)) changes.set(key, Object.freeze([...data.result.affectedScheduleIds]));
    return refresh(reference);
  }
  return { observe, retry: (reference: AssistantRecoveryReference) => refresh(reference, true),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; } };
}

export const assistantScheduleSync = createAssistantScheduleSync();
