import { captureScheduleOwner, createScheduleRoute, discardScheduleRoute, isScheduleOwnerCurrent } from "@/utils/schedule-ownership";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef } from "react";

/** 연속 탭만 동기적으로 막고 실제 화면 복귀 시 다음 진입을 허용한다. */
export function useScheduleEditNavigation() {
  const router = useRouter();
  const owner = captureScheduleOwner();
  const focused = useRef(false), opening = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true; opening.current = false;
    return () => { focused.current = false; };
  }, []));
  return useCallback((id: string) => {
    if (!isScheduleOwnerCurrent(owner) || !focused.current || opening.current) return;
    opening.current = true;
    let route: ReturnType<typeof createScheduleRoute> = null;
    try { route = createScheduleRoute(id, owner); if (route) router.push(route); }
    catch { discardScheduleRoute(route?.params.connectionKey); opening.current = false; }
  }, [router, owner]);
}
