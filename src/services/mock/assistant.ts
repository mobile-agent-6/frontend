import * as Crypto from "expo-crypto";

import { useScheduleStore } from "@/stores/scheduleStore";
import type { Schedule } from "@/types/schedule";
import { formatLocalDate } from "@/utils/schedule-date-time";

// MOCK_SCHEDULES에 실제 존재하는 ID를 고정 대상으로 사용한다.
const MEETING_TARGET_ID = "10000000-0000-4000-8000-000000000002";
const INVENTORY_TARGET_ID = "10000000-0000-4000-8000-000000000001";
const RETURN_TARGET_ID = "10000000-0000-4000-8000-000000000003";
const COMPLETED_INVENTORY_TARGET_ID = "10000000-0000-4000-8000-000000000004";
const DENTAL_TARGET_ID = "10000000-0000-4000-8000-000000000005";
const MANAGER_MEETING_TARGET_ID = "10000000-0000-4000-8000-000000000007";
const DELIVERY_TARGET_ID = "10000000-0000-4000-8000-000000000008";

function updateMockSchedule(
  id: string,
  updates: Partial<
    Pick<
      Schedule,
      "title" | "date" | "time" | "category" | "notificationEnabled" | "completed"
    >
  >,
  text: string,
) {
  const store = useScheduleStore.getState();
  const target = store.schedules.find((schedule) => schedule.id === id);
  if (!target) return { text: "일정을 찾지 못했어요.", schedules: [] };

  const alreadyMatches = Object.entries(updates).every(
    ([field, value]) => target[field as keyof Schedule] === value,
  );
  if (alreadyMatches) {
    const unchangedText =
      updates.completed === true
        ? "이미 완료된 일정이에요."
        : updates.completed === false
          ? "이미 미완료 상태인 일정이에요."
          : "이미 요청한 상태예요.";
    return { text: unchangedText, schedules: [target] };
  }

  store.updateSchedule(id, updates);
  const updated = useScheduleStore
    .getState()
    .schedules.find((schedule) => schedule.id === id);
  if (!updated) return { text: "일정을 찾지 못했어요.", schedules: [] };

  return { text, schedules: [updated] };
}

// 지정된 입력 문장만 실행하는 개발용 Mock이며 자연어를 해석하지 않는다.
export function runMockAssistantScenario(input: string) {
  switch (input) {
    case "내일 오후 3시 팀 회의 추가해 줘": {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const schedule: Schedule = {
        id: Crypto.randomUUID(),
        title: "팀 회의",
        date: formatLocalDate(tomorrow),
        time: "15:00",
        category: "회의",
        completed: false,
        notificationEnabled: true,
      };
      useScheduleStore.getState().addSchedule(schedule);

      return { text: "네, 일정을 추가했어요.", schedules: [schedule] };
    }
    case "일정 보여줘": {
      const schedules = [...useScheduleStore.getState().schedules];
      const text =
        schedules.length === 0
          ? "등록된 일정이 없어요."
          : `등록된 일정은 ${schedules.length}개예요.`;

      return { text, schedules };
    }
    case "팀 주간 회의를 오후 4시로 바꿔 줘":
      return updateMockSchedule(
        MEETING_TARGET_ID,
        { time: "16:00" },
        "팀 주간 회의 시간을 오후 4시로 변경했어요.",
      );
    case "A구역 재고 실사 완료 처리해 줘":
      return updateMockSchedule(
        INVENTORY_TARGET_ID,
        { completed: true },
        "A구역 재고 실사를 완료 처리했어요.",
      );
    case "반품 상품 검수를 반품 상품 최종 검수로 바꿔 줘":
      return updateMockSchedule(
        RETURN_TARGET_ID,
        { title: "반품 상품 최종 검수" },
        "일정 제목을 반품 상품 최종 검수로 변경했어요.",
      );
    case "치과 예약을 내일로 옮겨 줘": {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return updateMockSchedule(
        DENTAL_TARGET_ID,
        { date: formatLocalDate(tomorrow) },
        "치과 예약 날짜를 내일로 변경했어요.",
      );
    }
    case "택배 수령 카테고리를 개인으로 바꿔 줘":
      return updateMockSchedule(
        DELIVERY_TARGET_ID,
        { category: "개인" },
        "택배 수령 카테고리를 개인으로 변경했어요.",
      );
    case "점장 미팅 알림 꺼 줘":
      return updateMockSchedule(
        MANAGER_MEETING_TARGET_ID,
        { notificationEnabled: false },
        "점장 미팅 알림을 껐어요.",
      );
    case "점장 미팅 알림 켜 줘":
      return updateMockSchedule(
        MANAGER_MEETING_TARGET_ID,
        { notificationEnabled: true },
        "점장 미팅 알림을 켰어요.",
      );
    case "B구역 재고 정리를 미완료로 바꿔 줘":
      return updateMockSchedule(
        COMPLETED_INVENTORY_TARGET_ID,
        { completed: false },
        "B구역 재고 정리를 미완료로 변경했어요.",
      );
    default:
      return {
        text: "메시지를 받았어요. 지금은 텍스트 대화 흐름을 확인하는 단계예요.",
        schedules: [],
      };
  }
}
