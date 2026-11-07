import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";

import { getDevelopmentServerConfig } from "@/services/api/config";
import { getScheduleCoverage, normalizeScheduleQuery, scheduleQueryKey, serverScheduleStore } from "@/stores/serverScheduleStore";
import type { ScheduleDateRange, ScheduleListQuery } from "@/utils/schedule-query";

/** 명시적으로 활성화한 소비자만 조회하며 선택 날짜는 기존 성공 coverage를 재사용한다. */
export function useServerScheduleData(query: ScheduleListQuery, enabled = false, coverageRange?: ScheduleDateRange) {
  const state = useStore(serverScheduleStore.store);
  const subscription = useRef<{ release: () => void; retry: () => Promise<void> } | null>(null);
  const config = getDevelopmentServerConfig();
  const serverId = config.status === "ready" ? config.config.serverId : null;
  const { category, completed } = query;
  const cache = serverId && state.serverId === serverId ? state.servers[serverId] : undefined;
  // 선택 날짜는 전체 카테고리의 성공한 범위를 재사용할 수 있다. 자체 성공/오류 이력은 유지한다.
  let ownKey: string | null = null;
  try { ownKey = serverId ? scheduleQueryKey(serverId, query) : null; } catch { /* 아래에서 요청 오류로 반환한다. */ }
  const own = ownKey ? cache?.queries[ownKey] : undefined;
  const covered = coverageRange && !own?.hasSuccess ? Object.values(cache?.queries ?? {}).find((entry) =>
    entry.query.category === category && entry.query.completed === completed &&
    getScheduleCoverage(entry, coverageRange.from, coverageRange.to) !== "unknown") : undefined;
  const chosen = covered?.query ?? query;
  const chosenFrom = chosen.from, chosenTo = chosen.to;
  const prepared = useMemo(() => {
    try { return { query: normalizeScheduleQuery({ from: chosenFrom, to: chosenTo, category, completed }), invalid: false }; }
    catch { return { query: null, invalid: true }; }
  }, [chosenFrom, chosenTo, category, completed]);
  useEffect(() => {
    if (!enabled) return;
    serverScheduleStore.syncServer();
    if (!prepared.query || !serverId) return;
    const consumer = serverScheduleStore.acquire(prepared.query);
    subscription.current = consumer;
    return consumer.release;
  }, [enabled, serverId, prepared]);
  const key = serverId && prepared.query ? scheduleQueryKey(serverId, prepared.query) : null;
  // effect가 서버 세대를 전환하기 전 렌더에서는 이전 서버의 성공 이력을 노출하지 않는다.
  const entry = key ? cache?.queries[key] : undefined;
  const schedules = (entry?.ids ?? []).map((id) => cache!.entities[id]);
  const localError = enabled && (config.status !== "ready" ? {
    kind: "configuration" as const, configurationStatus: config.status, requestState: "not-sent" as const,
  } : prepared.invalid ? { kind: "request" as const, requestState: "not-sent" as const } : null);
  const error = localError || entry?.error || null;
  const hasSuccessfulRead = entry?.hasSuccess ?? false;
  return {
    serverId, query: entry?.query, schedules, error, hasSuccessfulRead,
    initialLoading: enabled && !error && !hasSuccessfulRead,
    isFetching: entry?.status === "loading",
    success: hasSuccessfulRead && !error && entry?.status === "success" && !entry.stale,
    empty: hasSuccessfulRead && !error && !entry?.stale && schedules.length === 0,
    initialError: Boolean(error) && !hasSuccessfulRead,
    refetchError: Boolean(error) && hasSuccessfulRead,
    stale: entry?.stale ?? true,
    coverage: (from: string, to: string) => getScheduleCoverage(entry, from, to),
    retryRead: () => enabled ? subscription.current?.retry() ?? Promise.resolve() : Promise.resolve(),
    cancel: () => subscription.current?.release(),
  };
}

/** 단건 성공은 공유 객체에만 반영하며 목록 coverage를 만들지 않는다. */
export function useServerScheduleDetail(scheduleId: string | undefined, enabled = false) {
  const state = useStore(serverScheduleStore.store);
  const subscription = useRef<{ release: () => void; retry: () => Promise<void> } | null>(null);
  const config = getDevelopmentServerConfig();
  const serverId = config.status === "ready" ? config.config.serverId : null;
  useEffect(() => {
    if (!enabled) return;
    serverScheduleStore.syncServer();
    if (!serverId || !scheduleId) return;
    const consumer = serverScheduleStore.acquireDetail(scheduleId);
    subscription.current = consumer;
    return consumer.release;
  }, [enabled, serverId, scheduleId]);
  const cache = serverId && state.serverId === serverId ? state.servers[serverId] : undefined;
  const entry = scheduleId ? cache?.details[scheduleId] : undefined;
  const localError = enabled && (config.status !== "ready" ? {
    kind: "configuration" as const, configurationStatus: config.status, requestState: "not-sent" as const,
  } : !scheduleId ? { kind: "request" as const, requestState: "not-sent" as const } : null);
  const error = localError || entry?.error || null;
  const notFound = error?.kind === "http" && error.status === 404 && error.problem?.code === "SCHEDULE_NOT_FOUND";
  const schedule = !localError && !notFound && scheduleId ? cache?.entities[scheduleId] : undefined;
  return { serverId, schedule, error, notFound,
    hasDetailSuccess: entry?.hasSuccess ?? false,
    initialLoading: enabled && !schedule && !error,
    isFetching: entry?.status === "loading",
    hasSuccessfulRead: Boolean(schedule),
    stale: entry?.stale ?? true,
    retryRead: () => enabled ? subscription.current?.retry() ?? Promise.resolve() : Promise.resolve(),
  };
}
