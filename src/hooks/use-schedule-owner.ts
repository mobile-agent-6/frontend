import { useCallback, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { scheduleDataModeStore } from "@/stores/scheduleDataModeStore";

import { captureScheduleOwner, isScheduleOwnerCurrent } from "@/utils/schedule-ownership";

/** Current list/navigation render only. Previously created callbacks keep their own immutable owner. */
export function useCurrentScheduleOwner() {
  const connection = useStore(scheduleDataModeStore);
  return captureScheduleOwner(connection);
}

/** A mounted screen never acquires another connection through a rerender or focus. */
export function useScheduleOwner() {
  const owner = useRef(captureScheduleOwner());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback(() => mounted.current && isScheduleOwnerCurrent(owner.current), []);
}
