import { useEffect, useRef, useState } from "react";

import { scheduleHttpClient } from "@/services/api/http";
import { prepareScheduleUpdate } from "@/services/api/schedules";
import { isScheduleRequestAllowed, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { serverScheduleStore } from "@/stores/serverScheduleStore";
import type { Schedule } from "@/types/schedule";
import { buildScheduleUpdate } from "@/utils/schedule-mapper";
import type { ScheduleListQuery } from "@/utils/schedule-query";

/** 일반 수정 전용 흐름. 완료 토글·삭제·낙관적 변경은 실행하지 않는다. */
export function useScheduleUpdate(scheduleId: string | undefined, serverId: string | null) {
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(false), [error, setError] = useState<string | null>(null);
  const locked = useRef(false), confirmed = useRef(false), uncertain = useRef(false), mounted = useRef(true);
  const failedQueries = useRef<ScheduleListQuery[] | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = scheduleDataModeStore.subscribe((current, previous) => {
      if (current.generation !== previous.generation) controller.current?.abort();
    });
    return () => { mounted.current = false; controller.current?.abort(); unsubscribe(); };
  }, []);

  async function save(original: Schedule, updates: Partial<Schedule>): Promise<boolean> {
    if (!mounted.current || locked.current || confirmed.current || uncertain.current) return false;
    if (!scheduleId || original.id !== scheduleId || !serverId || scheduleHttpClient.getServerId() !== serverId) {
      setError("수정 대상과 서버 설정을 다시 확인해 주세요."); return false;
    }
    if (!isScheduleRequestAllowed("PATCH", `/schedules/${encodeURIComponent(scheduleId)}`)) {
      setError("현재 정책에서는 일정 수정을 사용할 수 없어요."); return false;
    }
    let payload;
    try {
      // 폼 최초 원본을 기준으로 비교하며 일반 수정에서 completed·id 등은 받지 않는다.
      payload = buildScheduleUpdate(original, { title: updates.title, date: updates.date, time: updates.time, category: updates.category });
    } catch { setError("날짜·시간과 카테고리를 확인해 주세요."); return false; }
    if (!Object.keys(payload).length) return false;
    const prepared = prepareScheduleUpdate(scheduleId, payload);
    if (!prepared.ok) { setError(Object.values(prepared.error.fields).join(" ")); return false; }
    const generation = scheduleDataModeStore.getState().generation;
    const currentScreen = () => mounted.current && generation === scheduleDataModeStore.getState().generation &&
      scheduleHttpClient.getServerId() === serverId;
    locked.current = true; setBusy(true); setError(null);
    controller.current = new AbortController();
    try {
      serverScheduleStore.syncServer(); serverScheduleStore.invalidate();
      const result = await prepared.operation.submit(controller.current.signal);
      if ("response" in result) {
        if (result.response.data.id !== scheduleId) {
          uncertain.current = true;
          if (currentScreen()) { setNeedsCheck(true); setError("응답의 대상 ID가 일치하지 않아요. GET으로 대상 상태를 확인해 주세요."); }
          return false;
        }
        confirmed.current = true;
        if (mounted.current) { setSaved(true); setNeedsCheck(true); }
        if (!serverScheduleStore.applyScheduleResult(serverId, result.response.data)) return false;
        const refresh = await serverScheduleStore.refreshLists(serverId);
        failedQueries.current = refresh.failedQueries;
        if (!currentScreen()) return false;
        if (!refresh.ok) { setError("일정은 수정되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요."); return false; }
        setNeedsCheck(false); return true;
      }
      uncertain.current = result.requiresReconciliation;
      if (!currentScreen()) return false;
      setNeedsCheck(uncertain.current);
      const code = "problem" in result.error ? result.error.problem?.code : undefined;
      setError(uncertain.current ? "수정 결과를 확인하지 못했어요. PATCH를 새로 보내지 않고 서버 상태를 먼저 확인해 주세요."
        : code === "SCHEDULE_NOT_FOUND" ? "수정할 일정을 찾을 수 없어요. 입력은 유지하고 있어요."
        : code === "SCHEDULE_IN_THE_PAST" ? "과거 시각으로 변경할 수 없어요. 날짜와 시간을 확인해 주세요."
        : code === "VALIDATION_ERROR" || code === "EMPTY_UPDATE" ? "수정할 입력값을 확인해 주세요."
        : "일정을 수정하지 못했어요. 입력을 확인하고 다시 시도해 주세요.");
      return false;
    } catch {
      if (!confirmed.current) uncertain.current = true;
      if (currentScreen()) { setNeedsCheck(true); setError(confirmed.current
        ? "일정은 수정되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요."
        : "수정 결과를 확인하지 못했어요. 서버 상태를 먼저 확인해 주세요."); }
      return false;
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }

  async function retryGet(): Promise<boolean> {
    if (!mounted.current || locked.current || !scheduleId || !serverId || scheduleHttpClient.getServerId() !== serverId) return false;
    const generation = scheduleDataModeStore.getState().generation;
    const currentScreen = () => mounted.current && generation === scheduleDataModeStore.getState().generation && scheduleHttpClient.getServerId() === serverId;
    locked.current = true; setBusy(true);
    try {
      if (confirmed.current) {
        const refresh = await serverScheduleStore.refreshLists(serverId, failedQueries.current);
        failedQueries.current = refresh.failedQueries;
        if (!currentScreen()) return false;
        setError(refresh.ok ? null : "목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요.");
        if (refresh.ok) setNeedsCheck(false);
        return refresh.ok;
      }
      await serverScheduleStore.retryDetail(scheduleId);
      if (currentScreen()) {
        const entry = serverScheduleStore.store.getState().servers[serverId]?.details[scheduleId];
        setError(entry?.status === "success" && !entry.stale
          ? "서버 상태를 다시 조회했어요. 기존 수정의 적용 여부를 확인해 주세요. 자동으로 다시 저장하지 않습니다."
          : "서버 상태를 확인하지 못했어요. 입력과 수정 잠금을 유지하고 GET 조회만 다시 시도해 주세요.");
      }
      // 조회된 현재값만으로 이전 PATCH의 실행 여부를 추정하거나 새 write를 허용하지 않는다.
      return false;
    } catch {
      if (currentScreen()) setError("서버 상태를 조회하지 못했어요. GET 조회만 다시 시도해 주세요.");
      return false;
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  return { save, retryGet, busy, saved, needsCheck, blocked: saved || needsCheck, error };
}
