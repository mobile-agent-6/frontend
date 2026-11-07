import { useMemo, useRef, useState } from "react";

import { readMockSchedules, setMockScheduleCompleted } from "@/services/mock/schedule-operations";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { Schedule } from "@/types/schedule";

// 일정 변경 원본은 store에 유지하고, 각 화면은 마지막 조회 성공 결과의 참조만 보관한다.
export function useScheduleData(enabled = true) {
  const currentSchedules = useScheduleStore((state) => state.schedules);
  const [readAttempt, setReadAttempt] = useState(0);
  const [lastSuccessfulSchedules, setLastSuccessfulSchedules] = useState<Schedule[] | null>(null);
  const [completionError, setCompletionError] = useState<{ id: string; completed: boolean } | null>(null);
  const lockedRef = useRef(false);
  const result = useMemo(() => {
    if (!enabled) return { schedules: [], readError: false };
    try {
      return { schedules: readMockSchedules(), readError: false };
    } catch {
      // 실패한 조회 결과는 표시하지 않고, 아래에서 마지막 성공 결과만 사용한다.
      return { schedules: [], readError: true };
    }
    // 수동 재시도는 같은 store에서도 조회 함수를 다시 실행해야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchedules, readAttempt, enabled]);

  // 빈 배열도 조회 성공이다. store의 seed 존재 여부로 성공 이력을 판단하지 않는다.
  if (enabled && !result.readError && lastSuccessfulSchedules !== result.schedules) {
    setLastSuccessfulSchedules(result.schedules);
  }

  const changeCompleted = (id: string, completed: boolean) => {
    if (!enabled) return;
    if (lockedRef.current) return;
    lockedRef.current = true;
    const before = useScheduleStore.getState().schedules;
    try {
      setMockScheduleCompleted(id, completed);
      setCompletionError(null);
    } catch {
      // 데이터 변경 뒤 표시 예외가 발생했다면 성공한 작업을 재실행하지 않는다.
      const changed = useScheduleStore.getState().schedules !== before;
      setCompletionError(changed ? null : { id, completed });
    } finally {
      lockedRef.current = false;
    }
  };

  return {
    ...result,
    schedules: result.readError
      ? lastSuccessfulSchedules ?? []
      : result.schedules,
    hasSuccessfulRead: !result.readError || lastSuccessfulSchedules !== null,
    completionError,
    retryRead: () => setReadAttempt((attempt) => attempt + 1),
    toggleCompleted: (schedule: Schedule) => changeCompleted(schedule.id, !schedule.completed),
    retryCompletion: () => {
      if (completionError) changeCompleted(completionError.id, completionError.completed);
    },
    canOpenSchedule: () => !lockedRef.current,
  };
}
