import { useScheduleOwner } from "@/hooks/use-schedule-owner";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import { scheduleHttpClient } from "@/services/api/http";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { serverScheduleStore } from "@/stores/serverScheduleStore";

/** 삭제 결과·잠금은 공유 Store에 남기고 화면 수명은 취소와 navigation만 제어한다. */
export function useScheduleDeletion(id: string | undefined, serverId: string | null) {
  const ownsScreen = useScheduleOwner();
  const state = useStore(serverScheduleStore.store);
  const mutation = serverId && id ? state.servers[serverId]?.mutations[id] : undefined;
  const deletion = mutation?.kind === "delete" ? mutation : undefined;
  const controller = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const lifetime = new AbortController(); controller.current = lifetime;
    return () => { mounted.current = false; lifetime.abort(); };
  }, []);
  async function run(check: boolean) {
    if (!ownsScreen() || !mounted.current || !id || !serverId || scheduleDataModeStore.getState().mode !== "server" ||
      scheduleHttpClient.getServerId() !== serverId) return false;
    const request = controller.current;
    if (!request || request.signal.aborted) return false;
    const generation = scheduleDataModeStore.getState().generation;
    const ok = await (check ? serverScheduleStore.checkDeletion(serverId, id, request.signal)
      : serverScheduleStore.deleteSchedule(serverId, id, request.signal));
    return ok && mounted.current && generation === scheduleDataModeStore.getState().generation && scheduleHttpClient.getServerId() === serverId;
  }
  return {
    remove: () => run(false), retryGet: () => run(true), active: Boolean(deletion),
    busy: deletion?.phase === "pending",
    blocked: Boolean(mutation && (mutation.phase === "pending" || mutation.phase === "uncertain")) ||
      Boolean(deletion && (deletion.deleted || deletion.phase !== "error")),
    needsCheck: Boolean(deletion?.message), error: deletion?.message ?? null,
  };
}
