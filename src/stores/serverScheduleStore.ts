import { createStore } from "zustand/vanilla";

import { scheduleHttpClient, type HttpError } from "@/services/api/http";
import { listSchedules } from "@/services/api/schedules";
import type { Schedule } from "@/types/schedule";
import { parseScheduleApiDateTime } from "@/utils/schedule-mapper";
import { buildScheduleListQuery, type ScheduleListQuery } from "@/utils/schedule-query";

export type ScheduleQueryEntry = {
  query: ScheduleListQuery;
  ids: string[];
  status: "idle" | "loading" | "success" | "error";
  hasSuccess: boolean;
  stale: boolean;
  error: HttpError | null;
  sequence: number;
};
type ServerCache = {
  entities: Record<string, Schedule>;
  entityVersions: Record<string, number>;
  queries: Record<string, ScheduleQueryEntry>;
};
type QueryState = { serverId: string | null; generation: number; servers: Record<string, ServerCache> };
const emptyCache = (): ServerCache => ({ entities: {}, entityVersions: {}, queries: {} });

export function normalizeScheduleQuery(query: ScheduleListQuery): ScheduleListQuery {
  const params = buildScheduleListQuery(query);
  const canonical = (value: string) => value.replace(/(\.\d*?[1-9])0+Z$/, "$1Z").replace(/\.0+Z$/, "Z");
  return { from: canonical(params.get("from")!), to: canonical(params.get("to")!),
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.completed === undefined ? {} : { completed: query.completed }) };
}

export function scheduleQueryKey(serverId: string, query: ScheduleListQuery): string {
  const normalized = normalizeScheduleQuery(query);
  return JSON.stringify([serverId, normalized.from, normalized.to, normalized.category ?? null, normalized.completed ?? null]);
}

/** Mock store에 의존하지 않는 화면 연결 전 서버 전용 조회 기반. */
export function createServerScheduleStore({
  readServerId = scheduleHttpClient.getServerId,
  list = listSchedules,
}: { readServerId?: () => string | null; list?: typeof listSchedules } = {}) {
  const store = createStore<QueryState>(() => ({ serverId: null, generation: 0, servers: {} }));
  let sequence = 0;
  type Flight = { controller: AbortController; promise: Promise<void>; sequence: number };
  const flights = new Map<string, Flight>();
  const consumers = new Map<string, Set<symbol>>();

  function update(serverId: string, change: (cache: ServerCache) => ServerCache) {
    store.setState((state) => ({ servers: { ...state.servers,
      [serverId]: change(state.servers[serverId] ?? emptyCache()) } }));
  }
  function cancel(key: string) {
    const flight = flights.get(key);
    if (!flight) return;
    flights.delete(key);
    flight.controller.abort();
    const serverId = store.getState().serverId;
    if (serverId) update(serverId, (cache) => {
      const entry = cache.queries[key];
      if (!entry) return cache;
      return { ...cache, queries: { ...cache.queries, [key]: { ...entry, stale: true, status: "error",
        error: { kind: "aborted", requestState: "unconfirmed" } } } };
    });
  }
  /** 설정 변경 시 호출한다. HTTP 계층의 완료 시점 검사와 함께 이전 응답을 차단한다. */
  function syncServer() {
    const serverId = readServerId();
    if (serverId === store.getState().serverId) return serverId;
    for (const key of flights.keys()) cancel(key);
    store.setState((state) => ({ serverId, generation: state.generation + 1,
      servers: Object.fromEntries(Object.entries(state.servers).map(([id, cache]) => [id, {
        ...cache, queries: Object.fromEntries(Object.entries(cache.queries).map(([key, entry]) =>
          [key, { ...entry, stale: true }])) }])) }));
    return serverId;
  }
  /** 향후 mutation 시작 전에 호출할 조회 장벽. mutation 자체는 실행하지 않는다. */
  function invalidate() {
    for (const key of flights.keys()) cancel(key);
    store.setState((state) => ({ generation: state.generation + 1 }));
    const id = store.getState().serverId;
    if (id) update(id, (cache) => ({ ...cache,
      queries: Object.fromEntries(Object.entries(cache.queries).map(([key, entry]) => [key, { ...entry, stale: true }])) }));
  }

  function fetchQuery(input: ScheduleListQuery, force = false): Promise<void> {
    const serverId = syncServer();
    if (!serverId) return Promise.resolve();
    const query = normalizeScheduleQuery(input);
    const key = scheduleQueryKey(serverId, query);
    const existing = flights.get(key);
    if (existing) return existing.promise;
    const entry = store.getState().servers[serverId]?.queries[key];
    if (!force && entry?.hasSuccess && !entry.stale) return Promise.resolve();
    const requestSequence = ++sequence;
    const generation = store.getState().generation;
    const controller = new AbortController();
    update(serverId, (cache) => ({ ...cache, queries: { ...cache.queries, [key]: {
      query, ids: entry?.ids ?? [], hasSuccess: entry?.hasSuccess ?? false,
      status: "loading", error: null, stale: true, sequence: requestSequence,
    } } }));
    // 마이크로태스크에서 시작해 동기 중복 소비자도 하나의 실행을 공유한다.
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const result = await list(query, controller.signal);
      syncServer();
      if (controller.signal.aborted || store.getState().generation !== generation ||
        store.getState().serverId !== serverId || flights.get(key)?.sequence !== requestSequence) return;
      update(serverId, (cache) => {
        const previous = cache.queries[key];
        if (!result.ok) return { ...cache, queries: { ...cache.queries,
          [key]: { ...previous, status: "error", error: result.error } } };
        if (result.serverId !== serverId) return { ...cache, queries: { ...cache.queries,
          [key]: { ...previous, status: "error", stale: true,
            error: { kind: "aborted", requestState: "response-received" } } } };
        const entities: Record<string, Schedule> = Object.assign(Object.create(null), cache.entities);
        const entityVersions = { ...cache.entityVersions };
        const queries = { ...cache.queries };
        let stale = false;
        for (const item of result.data) {
          // 응답 도착 순서가 아니라 요청 시작 순서를 사용한다. 서버 revision을 추정하지 않는다.
          if ((entityVersions[item.id] ?? 0) > requestSequence) { stale = true; continue; }
          if (entities[item.id] && JSON.stringify(entities[item.id]) !== JSON.stringify(item)) {
            for (const [otherKey, other] of Object.entries(queries)) {
              if (otherKey !== key && other.ids.includes(item.id)) queries[otherKey] = { ...other, stale: true };
            }
          }
          entities[item.id] = { ...item };
          entityVersions[item.id] = requestSequence;
        }
        // 한 query에서 빠진 객체를 전역 삭제하지 않는다. 순서와 소속은 query별로 유지한다.
        queries[key] = { ...previous, ids: result.data.map((item) => item.id),
          hasSuccess: true, status: "success", error: null, stale };
        return { entities, entityVersions, queries };
      });
    }).catch(() => {
      // 주입된 서비스의 예상 밖 예외도 빈 성공으로 처리하지 않는다.
      syncServer();
      if (!controller.signal.aborted && store.getState().generation === generation &&
        flights.get(key)?.sequence === requestSequence) update(serverId, (cache) => ({ ...cache,
        queries: { ...cache.queries, [key]: { ...cache.queries[key], status: "error",
          error: { kind: "response", requestState: "unconfirmed" } } } }));
    }).finally(() => { if (flights.get(key)?.sequence === requestSequence) flights.delete(key); });
    flights.set(key, { controller, promise, sequence: requestSequence });
    return promise;
  }

  function acquire(query: ScheduleListQuery) {
    const snapshot = normalizeScheduleQuery(query);
    const serverId = syncServer();
    const key = serverId ? scheduleQueryKey(serverId, snapshot) : null;
    const token = Symbol();
    if (key) {
      const owners = consumers.get(key) ?? new Set<symbol>();
      owners.add(token); consumers.set(key, owners);
    }
    let released = false;
    return { promise: fetchQuery(snapshot), retry: () => released ? Promise.resolve() : fetchQuery(snapshot, true), release() {
      if (released || !key) return;
      released = true;
      const owners = consumers.get(key);
      owners?.delete(token);
      if (owners?.size === 0) { consumers.delete(key); cancel(key); }
    } };
  }
  return { store, syncServer, acquire, invalidate,
    retry: (query: ScheduleListQuery) => fetchQuery(query, true) };
}

/** 성공한 정확한 query의 범위만 coverage로 인정한다. stale 데이터는 표시할 수 있지만 확정하지 않는다. */
export function getScheduleCoverage(entry: ScheduleQueryEntry | undefined, from: string, to: string) {
  if (!entry?.hasSuccess) return "unknown" as const;
  buildScheduleListQuery({ from, to });
  const compare = (a: string, b: string) => {
    const first = parseScheduleApiDateTime(a), second = parseScheduleApiDateTime(b);
    return first.milliseconds - second.milliseconds || first.microseconds - second.microseconds;
  };
  if (compare(from, entry.query.from) < 0 || compare(to, entry.query.to) > 0) return "unknown" as const;
  return entry.stale ? "stale" as const : "covered" as const;
}

// 생성만으로 조회하지 않는다. 기존 Mock 화면에서는 import하지 않는다.
export const serverScheduleStore = createServerScheduleStore();
