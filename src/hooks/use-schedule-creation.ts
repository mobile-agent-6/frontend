import { useScheduleOwner } from "@/hooks/use-schedule-owner";
import { useEffect, useRef, useState } from "react";

import { scheduleHttpClient } from "@/services/api/http";
import { prepareScheduleCreation, type ScheduleCreationOperation } from "@/services/api/schedules";
import { isScheduleRequestAllowed, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { serverScheduleStore } from "@/stores/serverScheduleStore";
import type { ScheduleCategory } from "@/types/schedule";
import { toApiCategory, uiDateTimeToScheduledAt } from "@/utils/schedule-mapper";
import type { ScheduleListQuery } from "@/utils/schedule-query";

export const SCHEDULE_CREATION_READ_ONLY_MESSAGE = "현재 읽기 전용 모드에서는 일정을 추가할 수 없어요.";

/** 폼 수명 동안 key·payload를 보존한다. 앱 종료 후 복구나 서버 결과 추정은 하지 않는다. */
export function useScheduleCreation() {
  const ownsScreen = useScheduleOwner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(false);
  const mounted = useRef(true), locked = useRef(false), saved = useRef(false);
  const operation = useRef<ScheduleCreationOperation | null>(null);
  const reconciliation = useRef(false);
  const failedQueries = useRef<ScheduleListQuery[] | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = scheduleDataModeStore.subscribe((current, previous) => {
      if (current.generation !== previous.generation) controller.current?.abort();
    });
    return () => { mounted.current = false; controller.current?.abort(); unsubscribe(); };
  }, []);

  async function save(input: { title: string; date: string; time: string; category: ScheduleCategory }): Promise<boolean> {
    if (!ownsScreen() || locked.current || saved.current || !mounted.current) return false;
    if (!isScheduleRequestAllowed("POST", "/schedules")) { setError(SCHEDULE_CREATION_READ_ONLY_MESSAGE); return false; }
    let payload;
    try { payload = { title: input.title.trim(), scheduledAt: uiDateTimeToScheduledAt(input.date, input.time), category: toApiCategory(input.category) }; }
    catch { setError("날짜·시간과 카테고리를 확인해 주세요."); return false; }
    if (operation.current && JSON.stringify(operation.current.payload) !== JSON.stringify(payload)) {
      if (reconciliation.current) {
        setError("이전 등록 결과를 아직 확인하지 못했어요. 입력을 바꿔 새로 등록하기 전에 기존 결과를 확인해 주세요."); return false;
      }
      operation.current = null;
    }
    if (!operation.current) {
      const prepared = prepareScheduleCreation(payload);
      if (!prepared.ok) {
        setError(prepared.error.kind === "validation" ? Object.values(prepared.error.fields).join(" ") : "등록 요청을 준비하지 못했어요."); return false;
      }
      operation.current = prepared.operation;
    }
    const currentOperation = operation.current;
    const generation = scheduleDataModeStore.getState().generation;
    locked.current = true; setBusy(true); setError(null);
    controller.current = new AbortController();
    const currentScreen = () => ownsScreen() && mounted.current && generation === scheduleDataModeStore.getState().generation;
    try {
      serverScheduleStore.syncServer();
      serverScheduleStore.invalidate();
      const result = await currentOperation.submit(controller.current.signal);
      if ("response" in result) {
        if (!currentScreen()) return false;
        saved.current = true;
        if (ownsScreen() && mounted.current) { setCreated(true); setNeedsCheck(true); }
        const refresh = await serverScheduleStore.refreshLists(result.response.serverId);
        failedQueries.current = refresh.failedQueries;
        if (!currentScreen()) return false;
        if (!refresh.ok) { setError("일정은 저장되었지만 목록을 갱신하지 못했어요. 목록 조회만 다시 시도해 주세요."); return false; }
        setNeedsCheck(false);
        return true;
      }
      reconciliation.current ||= result.requiresReconciliation;
      if (!currentScreen()) return false;
      setNeedsCheck(reconciliation.current);
      if (result.outcome === "uncertain" || result.outcome === "review-required") {
        setError("등록 결과를 확인하지 못했어요. 같은 입력의 저장 재시도는 기존 요청을 사용하며, 새 등록 전 결과 확인이 필요해요.");
      } else {
        const code = "problem" in result.error ? result.error.problem?.code : undefined;
        setError(code === "SCHEDULE_IN_THE_PAST" ? "과거 시각에는 일정을 등록할 수 없어요. 날짜와 시간을 확인해 주세요."
          : code === "IDEMPOTENCY_KEY_CONFLICT" ? "등록 요청이 충돌했어요. 새로 등록하지 말고 기존 일정 결과를 먼저 확인해 주세요."
          : code === "VALIDATION_ERROR" ? "입력값을 확인해 주세요. 기존 등록 결과 확인 전 새 요청은 보내지 않습니다."
          : "일정을 등록하지 못했어요. 입력을 유지하고 있으니 상태를 확인한 뒤 다시 시도해 주세요.");
      }
      return false;
    } catch {
      if (saved.current) {
        if (currentScreen()) setError("일정은 저장되었지만 목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요.");
        return false;
      }
      // 예외만으로 서버 미실행을 단정하지 않고 동일 작업을 보존한다.
      reconciliation.current = true;
      if (currentScreen()) { setNeedsCheck(true); setError("등록 결과를 확인하지 못했어요. 기존 요청을 보존하고 있어요."); }
      return false;
    } finally {
      locked.current = false;
      if (ownsScreen() && mounted.current) setBusy(false);
    }
  }

  async function retryGet(): Promise<boolean> {
    if (!ownsScreen() || locked.current || !operation.current?.serverId) return false;
    locked.current = true; setBusy(true);
    const generation = scheduleDataModeStore.getState().generation;
    try {
      const refresh = await serverScheduleStore.refreshLists(operation.current.serverId, saved.current ? failedQueries.current : undefined);
      failedQueries.current = refresh.failedQueries;
      if (!ownsScreen() || !mounted.current || generation !== scheduleDataModeStore.getState().generation) return false;
      setError(!refresh.ok ? "목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요."
        : saved.current ? null : "목록을 갱신했어요. 등록 여부를 목록에서 확인해 주세요. 조회만으로 이전 요청의 결과를 확정하지는 않습니다.");
      if (refresh.ok && saved.current) setNeedsCheck(false);
      return refresh.ok && saved.current && scheduleHttpClient.getServerId() === operation.current.serverId;
    } catch {
      if (ownsScreen() && mounted.current) setError("목록을 갱신하지 못했어요. GET 조회만 다시 시도해 주세요.");
      return false;
    } finally { locked.current = false; if (ownsScreen() && mounted.current) setBusy(false); }
  }
  return { save, retryGet, busy, error, created, needsCheck };
}
