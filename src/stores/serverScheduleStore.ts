import { createStore } from "zustand/vanilla";

import { scheduleHttpClient, type HttpError } from "@/services/api/http";
import { getSchedule, listSchedules, prepareScheduleDeletion, prepareScheduleUpdate } from "@/services/api/schedules";
import { isScheduleRequestAllowed, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import type { Schedule } from "@/types/schedule";
import { parseScheduleApiDateTime } from "@/utils/schedule-mapper";
import { buildScheduleListQuery, getMainScheduleRange, type ScheduleListQuery } from "@/utils/schedule-query";

export type ScheduleQueryEntry = {
  query: ScheduleListQuery;
  ids: string[];
  status: "idle" | "loading" | "success" | "error";
  hasSuccess: boolean;
  stale: boolean;
  error: HttpError | null;
  sequence: number;
};
export type ScheduleMutationState = {
  kind: "edit" | "completion" | "delete";
  phase: "pending" | "uncertain" | "refresh-error" | "error" | "checked";
  completed?: boolean;
  message?: string;
  failedQueries?: ScheduleListQuery[];
  deleted?: boolean;
};
type ServerCache = {
  entities: Record<string, Schedule>;
  entityVersions: Record<string, number>;
  queries: Record<string, ScheduleQueryEntry>;
  details: Record<string, Omit<ScheduleQueryEntry, "query" | "ids">>;
  mutations: Record<string, ScheduleMutationState>;
  deletedIds: Record<string, number>;
};
type QueryState = { serverId: string | null; generation: number; servers: Record<string, ServerCache> };
const emptyCache = (): ServerCache => ({ entities: {}, entityVersions: {}, queries: {}, details: {}, mutations: {}, deletedIds: {} });

// 목록과 단건이 같은 요청 순번·객체 원본을 사용한다. 서버 revision을 추정하지 않는다.
function mergeEntities(cache: ServerCache, items: Schedule[], sequence: number) {
  const entities: Record<string, Schedule> = Object.assign(Object.create(null), cache.entities);
  const entityVersions = { ...cache.entityVersions }, queries = { ...cache.queries }, details = { ...cache.details };
  let stale = false;
  for (const item of items) {
    if (Object.hasOwn(cache.deletedIds, item.id)) { stale = true; continue; }
    if ((entityVersions[item.id] ?? 0) > sequence) { stale = true; continue; }
    if (entities[item.id] && JSON.stringify(entities[item.id]) !== JSON.stringify(item)) {
      for (const [key, entry] of Object.entries(queries)) {
        if (entry.ids.includes(item.id)) queries[key] = { ...entry, stale: true };
      }
      if (details[item.id]) details[item.id] = { ...details[item.id], stale: true };
    }
    entities[item.id] = { ...item }; entityVersions[item.id] = sequence;
  }
  return { cache: { ...cache, entities, entityVersions, queries, details }, stale };
}

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
  get = getSchedule,
}: { readServerId?: () => string | null; list?: typeof listSchedules; get?: typeof getSchedule } = {}) {
  const store = createStore<QueryState>(() => ({ serverId: null, generation: 0, servers: {} }));
  let sequence = 0;
  type Flight = { controller: AbortController; promise: Promise<void>; sequence: number; detailId?: string };
  const flights = new Map<string, Flight>();
  const consumers = new Map<string, Set<symbol>>();
  const mutationLocks = new Map<string, symbol>();
  const mutationControllers = new Map<symbol, AbortController>();
  const checking = new Set<string>();

  function setMutation(serverId: string, id: string, mutation: ScheduleMutationState | undefined) {
    update(serverId, (cache) => {
      const mutations = { ...cache.mutations };
      if (mutation) mutations[id] = mutation; else delete mutations[id];
      return { ...cache, mutations };
    });
  }
  /** 화면 수명과 독립적인 일정별 잠금. 불확실한 작업은 GET 확인 전까지 보유한다. */
  function beginMutation(serverId: string, id: string, kind: ScheduleMutationState["kind"]) {
    if (syncServer() !== serverId) return null;
    const key = JSON.stringify([serverId, id]);
    if (mutationLocks.has(key) || checking.has(key) || Object.hasOwn(store.getState().servers[serverId]?.deletedIds ?? {}, id)) return null;
    const token = Symbol(), controller = new AbortController();
    mutationLocks.set(key, token); mutationControllers.set(token, controller);
    setMutation(serverId, id, { kind, phase: "pending" });
    return { controller,
      finish(blocked = false) {
        if (mutationLocks.get(key) !== token) return;
        mutationControllers.delete(token);
        if (blocked) setMutation(serverId, id, { kind, phase: "uncertain" });
        else { mutationLocks.delete(key); setMutation(serverId, id, undefined); }
      },
    };
  }

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
      if (flight.detailId !== undefined) {
        const entry = cache.details[flight.detailId];
        return entry ? { ...cache, details: { ...cache.details, [flight.detailId]: { ...entry, stale: true,
          status: "error", error: { kind: "aborted", requestState: "unconfirmed" } } } } : cache;
      }
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
    for (const controller of mutationControllers.values()) controller.abort();
    for (const key of flights.keys()) cancel(key);
    store.setState((state) => ({ serverId, generation: state.generation + 1,
      servers: Object.fromEntries(Object.entries(state.servers).map(([id, cache]) => [id, {
        ...cache, details: Object.fromEntries(Object.entries(cache.details).map(([key, entry]) => [key, { ...entry, stale: true }])),
        queries: Object.fromEntries(Object.entries(cache.queries).map(([key, entry]) =>
          [key, { ...entry, stale: true }])) }])) }));
    return serverId;
  }
  /** 향후 mutation 시작 전에 호출할 조회 장벽. mutation 자체는 실행하지 않는다. */
  function invalidate() {
    for (const key of flights.keys()) cancel(key);
    store.setState((state) => ({ generation: state.generation + 1 }));
    const id = store.getState().serverId;
    if (id) update(id, (cache) => ({ ...cache,
      details: Object.fromEntries(Object.entries(cache.details).map(([key, entry]) => [key, { ...entry, stale: true }])),
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
        const merged = mergeEntities(cache, result.data, requestSequence);
        const { queries } = merged.cache;
        // 한 query에서 빠진 객체를 전역 삭제하지 않는다. 순서와 소속은 query별로 유지한다.
        queries[key] = { ...previous, ids: result.data.filter((item) => !Object.hasOwn(cache.deletedIds, item.id)).map((item) => item.id),
          hasSuccess: true, status: "success", error: null, stale: merged.stale };
        return merged.cache;
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

  function fetchDetail(scheduleId: string, force = false): Promise<void> {
    const serverId = syncServer();
    if (!serverId || !scheduleId) return Promise.resolve();
    const key = JSON.stringify(["detail", serverId, scheduleId]);
    const existing = flights.get(key);
    if (existing) return existing.promise;
    const entry = store.getState().servers[serverId]?.details[scheduleId];
    if (!force && entry?.hasSuccess && !entry.stale) return Promise.resolve();
    const requestSequence = ++sequence, generation = store.getState().generation;
    const controller = new AbortController();
    update(serverId, (cache) => ({ ...cache, details: { ...cache.details, [scheduleId]: {
      status: "loading", hasSuccess: entry?.hasSuccess ?? false, stale: true, error: null, sequence: requestSequence,
    } } }));
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const result = await get(scheduleId, controller.signal);
      syncServer();
      if (controller.signal.aborted || store.getState().generation !== generation ||
        store.getState().serverId !== serverId || flights.get(key)?.sequence !== requestSequence) return;
      update(serverId, (cache) => {
        const previous = cache.details[scheduleId];
        if (!result.ok || result.serverId !== serverId || result.data.id !== scheduleId) {
          const error: HttpError = !result.ok ? result.error : { kind: "response", requestState: "response-received" };
          // 더 늦게 시작한 목록이 이미 새 객체를 확인했다면 이전 404도 확정하지 않는다.
          const currentError: HttpError = (cache.entityVersions[scheduleId] ?? 0) > requestSequence
            ? { kind: "aborted", requestState: "response-received" } : error;
          const queries = { ...cache.queries };
          if (currentError.problem?.code === "SCHEDULE_NOT_FOUND") {
            for (const [key, value] of Object.entries(queries)) {
              if (value.ids.includes(scheduleId)) queries[key] = { ...value, stale: true };
            }
          }
          return { ...cache, queries, details: { ...cache.details, [scheduleId]: {
            ...previous, status: "error", stale: true, error: currentError,
          } } };
        }
        const merged = mergeEntities(cache, [result.data], requestSequence);
        merged.cache.details[scheduleId] = { ...previous, status: "success", hasSuccess: true,
          stale: merged.stale, error: null };
        return merged.cache;
      });
    }).catch(() => {
      syncServer();
      if (!controller.signal.aborted && store.getState().generation === generation && flights.get(key)?.sequence === requestSequence) {
        update(serverId, (cache) => ({ ...cache, details: { ...cache.details, [scheduleId]: {
          ...cache.details[scheduleId], status: "error", error: { kind: "response", requestState: "unconfirmed" },
        } } }));
      }
    }).finally(() => { if (flights.get(key)?.sequence === requestSequence) flights.delete(key); });
    flights.set(key, { controller, promise, sequence: requestSequence, detailId: scheduleId });
    return promise;
  }

  function acquireDetail(scheduleId: string) {
    const serverId = syncServer();
    const key = serverId ? JSON.stringify(["detail", serverId, scheduleId]) : null;
    const token = Symbol();
    if (key) { const owners = consumers.get(key) ?? new Set<symbol>(); owners.add(token); consumers.set(key, owners); }
    let released = false;
    return { promise: fetchDetail(scheduleId), retry: () => released ? Promise.resolve() : fetchDetail(scheduleId, true),
      release() {
        if (released || !key) return;
        released = true;
        const owners = consumers.get(key); owners?.delete(token);
        if (owners?.size === 0) { consumers.delete(key); cancel(key); }
      } };
  }
  /** 성공 write와 GET 실패를 분리한다. 재시도 인자가 있으면 실패한 GET만 실행한다. */
  async function refreshLists(expectedServerId: string, retryQueries?: ScheduleListQuery[]) {
    if (syncServer() !== expectedServerId) return { ok: false,
      failedQueries: retryQueries?.length ? retryQueries : [getMainScheduleRange(new Date())] };
    const cache = store.getState().servers[expectedServerId];
    const active = Object.entries(cache?.queries ?? {}).filter(([key]) => consumers.has(key)).map(([, entry]) => entry.query);
    const queries = retryQueries ?? (active.length ? active : [getMainScheduleRange(new Date())]);
    if (!retryQueries) invalidate();
    await Promise.all(queries.map((query) => fetchQuery(query, true)));
    if (syncServer() !== expectedServerId) return { ok: false, failedQueries: queries };
    const current = store.getState().servers[expectedServerId];
    const failedQueries = queries.filter((query) => {
      const entry = current?.queries[scheduleQueryKey(expectedServerId, query)];
      return entry?.status !== "success" || entry.stale;
    });
    return { ok: failedQueries.length === 0, failedQueries };
  }
  /** 확인된 write 응답만 반영한다. 이전 GET은 취소하고 새 객체 버전 경계를 만든다. */
  function applyScheduleResult(expectedServerId: string, schedule: Schedule) {
    if (syncServer() !== expectedServerId) return false;
    invalidate();
    const version = ++sequence;
    update(expectedServerId, (cache) => {
      const merged = mergeEntities(cache, [schedule], version).cache;
      merged.details[schedule.id] = { status: "success", hasSuccess: true, stale: false, error: null, sequence: version };
      return merged;
    });
    return true;
  }

  /** 204 또는 단건 GET의 확정 부재만 반영한다. ID는 재사용하지 않으며 이전/상충 GET에서 복원하지 않는다. */
  function applyScheduleDeletion(expectedServerId: string, id: string) {
    if (syncServer() !== expectedServerId) return false;
    invalidate();
    const version = ++sequence;
    update(expectedServerId, (cache) => {
      const entities = { ...cache.entities };
      delete entities[id];
      return { ...cache, entities, entityVersions: { ...cache.entityVersions, [id]: version },
        deletedIds: { ...cache.deletedIds, [id]: version },
        queries: Object.fromEntries(Object.entries(cache.queries).map(([key, entry]) =>
          [key, { ...entry, ids: entry.ids.filter((item) => item !== id) }])),
        details: { ...cache.details, [id]: { status: "success", hasSuccess: false, stale: false, error: null, sequence: version } } };
    });
    return true;
  }

  function deletionAllowed(serverId: string | null, id: string) {
    return Boolean(serverId) && scheduleDataModeStore.getState().mode === "server" && readServerId() === serverId &&
      isScheduleRequestAllowed("DELETE", `/schedules/${encodeURIComponent(id)}`);
  }

  async function deleteSchedule(serverId: string | null, id: string, signal?: AbortSignal): Promise<boolean> {
    if (!serverId || signal?.aborted || !deletionAllowed(serverId, id)) return false;
    const previous = store.getState().servers[serverId]?.mutations[id];
    if (previous?.kind === "delete" && (previous.deleted || previous.phase !== "error")) return false;
    const prepared = prepareScheduleDeletion(id);
    if (!prepared.ok) return false;
    const lease = beginMutation(serverId, id, "delete");
    if (!lease) return false;
    const generation = scheduleDataModeStore.getState().generation;
    const current = () => !signal?.aborted && !lease.controller.signal.aborted &&
      generation === scheduleDataModeStore.getState().generation && scheduleDataModeStore.getState().mode === "server" && syncServer() === serverId;
    const abort = () => lease.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const unsubscribe = scheduleDataModeStore.subscribe((next) => { if (next.generation !== generation) { abort(); invalidate(); } });
    let deleted = false, blocked = false;
    let state: ScheduleMutationState = { kind: "delete", phase: "uncertain", message: "삭제 결과를 확인하지 못했어요. GET으로 일정 존재 여부를 확인해 주세요." };
    invalidate();
    try {
      const result = await prepared.operation.submit(lease.controller.signal);
      if ("response" in result && result.response.serverId === serverId && current()) {
        deleted = applyScheduleDeletion(serverId, id);
        setMutation(serverId, id, { kind: "delete", phase: "pending", deleted });
        const refresh = await refreshLists(serverId);
        state = { kind: "delete", deleted, phase: refresh.ok ? "checked" : "refresh-error", failedQueries: refresh.failedQueries,
          message: refresh.ok ? undefined : "일정은 삭제되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요." };
        return deleted && refresh.ok && current();
      }
      blocked = "response" in result || result.requiresReconciliation;
      if (!blocked && !("response" in result)) {
        const code = "problem" in result.error ? result.error.problem?.code : undefined;
        state = { kind: "delete", phase: "error", message: code === "SCHEDULE_NOT_FOUND"
          ? "삭제할 일정을 찾을 수 없어요. 삭제 성공으로 처리하지 않고 GET으로 확인해 주세요."
          : code === "VALIDATION_ERROR" ? "삭제 요청이 거절되었어요. 일정을 다시 확인해 주세요."
          : "일정을 삭제하지 못했어요. 다시 삭제하려면 확인 모달에서 승인해 주세요." };
      }
      return false;
    } catch {
      blocked = !deleted;
      if (deleted) state = { kind: "delete", deleted: true, phase: "refresh-error",
        message: "일정은 삭제되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요." };
      return false;
    } finally {
      signal?.removeEventListener("abort", abort); unsubscribe();
      lease.finish(blocked); setMutation(serverId, id, state);
    }
  }

  /** 수동 복구는 GET만 사용한다. GET 200은 이전 DELETE의 미실행을 증명하지 않는다. */
  async function checkDeletion(serverId: string | null, id: string, signal?: AbortSignal): Promise<boolean> {
    if (!serverId || signal?.aborted || scheduleDataModeStore.getState().mode !== "server" || syncServer() !== serverId) return false;
    const mutation = store.getState().servers[serverId]?.mutations[id];
    const key = JSON.stringify([serverId, id]);
    if (mutation?.kind !== "delete" || mutation.phase === "pending" || checking.has(key)) return false;
    const generation = scheduleDataModeStore.getState().generation;
    const current = () => !signal?.aborted && generation === scheduleDataModeStore.getState().generation &&
      scheduleDataModeStore.getState().mode === "server" && syncServer() === serverId;
    const unsubscribe = scheduleDataModeStore.subscribe((next) => { if (next.generation !== generation) invalidate(); });
    checking.add(key);
    try {
      if (!mutation.deleted) {
        await fetchDetail(id, true);
        if (!current()) return false;
        const detail = store.getState().servers[serverId]?.details[id];
        const absent = detail?.error?.kind === "http" && detail.error.status === 404 && detail.error.problem?.code === "SCHEDULE_NOT_FOUND";
        if (!absent) {
          const found = detail?.status === "success" && !detail.stale;
          setMutation(serverId, id, { ...mutation, message: found
            ? "현재 일정이 조회되었어요. 이전 삭제 요청의 결과는 확정할 수 없어 자동으로 다시 삭제하지 않습니다."
            : "일정 존재 여부를 확인하지 못했어요. 삭제 상태를 확정하지 않고 GET 조회만 다시 시도해 주세요." });
          return false;
        }
        applyScheduleDeletion(serverId, id);
      }
      const refresh = await refreshLists(serverId, mutation.phase === "refresh-error" ? mutation.failedQueries : undefined);
      if (!current()) return false;
      if (mutation.phase === "uncertain") mutationLocks.delete(key);
      setMutation(serverId, id, { kind: "delete", deleted: mutation.deleted,
        phase: refresh.ok ? "checked" : "refresh-error", failedQueries: refresh.failedQueries,
        message: !refresh.ok ? "목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요."
          : mutation.deleted ? undefined : "현재 서버에 일정이 없는 것을 확인했어요. 이전 삭제 요청의 성공 여부를 뜻하지 않아요." });
      return Boolean(mutation.deleted) && refresh.ok;
    } catch {
      if (current()) setMutation(serverId, id, { ...mutation,
        message: "일정 상태를 확인하지 못했어요. GET 조회만 다시 시도해 주세요." });
      return false;
    } finally {
      checking.delete(key); unsubscribe();
    }
  }

  function completionAllowed(serverId: string | null, id: string) {
    return Boolean(serverId) && scheduleDataModeStore.getState().mode === "server" &&
      readServerId() === serverId && isScheduleRequestAllowed("PATCH", `/schedules/${encodeURIComponent(id)}`);
  }
  async function toggleCompleted(serverId: string | null, id: string) {
    if (!completionAllowed(serverId, id) || !serverId) return;
    const original = store.getState().servers[serverId]?.entities[id];
    if (!original) return;
    if (store.getState().servers[serverId]?.mutations[id]?.phase === "refresh-error") return;
    const prepared = prepareScheduleUpdate(id, { completed: !original.completed });
    if (!prepared.ok) return;
    const lease = beginMutation(serverId, id, "completion");
    if (!lease) return;
    const completed = !original.completed;
    const generation = scheduleDataModeStore.getState().generation;
    const current = () => generation === scheduleDataModeStore.getState().generation &&
      scheduleDataModeStore.getState().mode === "server" && syncServer() === serverId;
    const unsubscribe = scheduleDataModeStore.subscribe((next) => {
      if (next.generation !== generation) { lease.controller.abort(); invalidate(); }
    });
    let blocked = false, message: string | undefined, phase: ScheduleMutationState["phase"] = "error";
    let failedQueries: ScheduleListQuery[] | undefined;
    let confirmed = false;
    invalidate();
    setMutation(serverId, id, { kind: "completion", phase: "pending", completed });
    try {
      const result = await prepared.operation.submit(lease.controller.signal);
      if ("response" in result && result.response.serverId === serverId && result.response.data.id === id && current()) {
        confirmed = true;
        applyScheduleResult(serverId, result.response.data);
        // 응답의 실제 boolean을 사용한다. 재조회 중에는 낙관적 목표값을 덧씌우지 않는다.
        setMutation(serverId, id, { kind: "completion", phase: "pending" });
        const refresh = await refreshLists(serverId);
        if (!refresh.ok) {
          phase = "refresh-error"; failedQueries = refresh.failedQueries;
          message = "완료 상태는 변경되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요.";
        }
      } else if ("response" in result || result.requiresReconciliation) {
        blocked = true; phase = "uncertain";
        message = "완료 변경 결과를 확인하지 못했어요. PATCH를 다시 보내지 않고 GET으로 상태를 확인해 주세요.";
      } else {
        // rollback은 이 작업의 completed에만 적용하고 다른 필드·다른 일정은 보존한다.
        update(serverId, (cache) => cache.entities[id] ? { ...cache, entities: { ...cache.entities,
          [id]: { ...cache.entities[id], completed: original.completed } } } : cache);
        const code = "problem" in result.error ? result.error.problem?.code : undefined;
        message = code === "SCHEDULE_NOT_FOUND" ? "변경할 일정을 찾을 수 없어요. GET으로 목록을 확인해 주세요."
          : code === "VALIDATION_ERROR" ? "완료 상태 변경 요청이 거절되었어요. GET으로 상태를 확인해 주세요."
          : "완료 상태를 변경하지 못했어요. GET으로 상태를 확인해 주세요.";
      }
    } catch {
      blocked = !confirmed; phase = confirmed ? "refresh-error" : "uncertain";
      message = confirmed ? "완료 상태는 변경되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요."
        : "완료 변경 결과가 불확실해요. GET으로 상태를 확인해 주세요.";
    } finally {
      unsubscribe();
      lease.finish(blocked);
      if (message) setMutation(serverId, id, { kind: "completion", phase, message, failedQueries });
    }
  }

  /** 완료 변경의 오류 UI는 항상 GET만 실행한다. 불확실한 PATCH를 재전송하지 않는다. */
  async function checkCompletion(serverId: string | null, id: string) {
    if (!serverId || scheduleDataModeStore.getState().mode !== "server" || syncServer() !== serverId) return;
    const mutation = store.getState().servers[serverId]?.mutations[id];
    const key = JSON.stringify([serverId, id]);
    if (!mutation || mutation.kind !== "completion" || mutation.phase === "pending" || checking.has(key)) return;
    const generation = scheduleDataModeStore.getState().generation;
    checking.add(key);
    try {
      // 불확실 결과는 해당 ID의 단건을 먼저 확인하고 현재 목록 조건도 다시 조회한다.
      if (mutation.phase === "uncertain") await fetchDetail(id, true);
      if (generation !== scheduleDataModeStore.getState().generation || syncServer() !== serverId) return;
      const detail = store.getState().servers[serverId]?.details[id];
      const reconciled = mutation.phase !== "uncertain" ||
        (detail?.status === "success" && !detail.stale) ||
        (detail?.error?.kind === "http" && detail.error.status === 404 && detail.error.problem?.code === "SCHEDULE_NOT_FOUND");
      if (!reconciled) return;
      const refresh = await refreshLists(serverId, mutation.phase === "refresh-error" ? mutation.failedQueries : undefined);
      if (generation !== scheduleDataModeStore.getState().generation || syncServer() !== serverId) return;
      if (mutation.phase === "uncertain") mutationLocks.delete(key);
      setMutation(serverId, id, refresh.ok ? (mutation.phase === "uncertain" ? { kind: "completion", phase: "checked",
        message: "서버의 현재 상태를 조회했어요. 이전 PATCH의 성공 여부를 뜻하지 않아요." } : undefined)
        : { kind: "completion", phase: "refresh-error", failedQueries: refresh.failedQueries,
          message: "목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요." });
    } finally { checking.delete(key); }
  }
  return { store, syncServer, acquire, acquireDetail, invalidate, refreshLists, applyScheduleResult,
    beginMutation, completionAllowed, toggleCompleted, checkCompletion,
    deletionAllowed, deleteSchedule, checkDeletion,
    retryDetail: (scheduleId: string) => fetchDetail(scheduleId, true),
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
