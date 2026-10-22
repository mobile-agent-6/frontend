import { useScheduleStore } from "@/stores/scheduleStore";

// seed를 다시 넣지 않고 현재 공유 store만 조회한다.
export function readMockSchedules() {
  return useScheduleStore.getState().schedules;
}

export function setMockScheduleCompleted(id: string, completed: boolean) {
  const store = useScheduleStore.getState();
  const schedule = store.schedules.find((item) => item.id === id);
  if (!schedule) throw new Error("일정을 찾지 못했어요.");
  // 같은 렌더의 연속 이벤트가 완료 상태를 두 번 뒤집지 않게 한다.
  if (schedule.completed === completed) return;
  store.toggleCompleted(id);
}
