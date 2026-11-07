import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";

import { getDevelopmentServerConfig } from "@/services/api/config";
import { getScheduleCoverage, normalizeScheduleQuery, scheduleQueryKey, serverScheduleStore } from "@/stores/serverScheduleStore";
import type { ScheduleListQuery } from "@/utils/schedule-query";

/** 명시적으로 활성화한 소비자만 조회한다. Mock Hook과 화면은 변경하지 않는다. */
export function useServerScheduleData(query: ScheduleListQuery, enabled = false) {
  const state = useStore(serverScheduleStore.store);
  const subscription = useRef<{ release: () => void; retry: () => Promise<void> } | null>(null);
  const config = getDevelopmentServerConfig();
  const serverId = config.status === "ready" ? config.config.serverId : null;
  const { from, to, category, completed } = query;
  const prepared = useMemo(() => {
    try { return { query: normalizeScheduleQuery({ from, to, category, completed }), invalid: false }; }
    catch { return { query: null, invalid: true }; }
  }, [from, to, category, completed]);
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
  const cache = serverId && state.serverId === serverId ? state.servers[serverId] : undefined;
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
