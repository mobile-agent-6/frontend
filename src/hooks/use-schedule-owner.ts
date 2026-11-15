import { useCallback, useEffect, useRef } from "react";

import { captureScheduleOwner, isScheduleOwnerCurrent } from "@/utils/schedule-ownership";

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
