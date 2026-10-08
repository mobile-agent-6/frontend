import * as Crypto from "expo-crypto";

import { useScheduleStore } from "@/stores/scheduleStore";
import type { AssistantInteraction } from "@/types/assistant";
import type { Schedule } from "@/types/schedule";
import {
  createDatePickerValue,
  createTimePickerValue,
  formatLocalDate,
} from "@/utils/schedule-date-time";

// 후속 입력을 구분하는 Mock 전용 상태이며 AI conversation context가 아니다.
export type MockAssistantPending =
  | "awaiting-team-meeting-time"
  | "awaiting-team-meeting-title"
  | "awaiting-team-meeting-date"
  | "awaiting-team-meeting-title-and-time"
  | null;

// MOCK_SCHEDULES에 실제 존재하는 ID를 고정 대상으로 사용한다.
const MEETING_TARGET_ID = "10000000-0000-4000-8000-000000000002";
const INVENTORY_TARGET_ID = "10000000-0000-4000-8000-000000000001";
const RETURN_TARGET_ID = "10000000-0000-4000-8000-000000000003";
const COMPLETED_INVENTORY_TARGET_ID = "10000000-0000-4000-8000-000000000004";
const SAFETY_INSPECTION_TARGET_ID = "10000000-0000-4000-8000-000000000005";
const OUTBOUND_PREPARATION_TARGET_ID = "10000000-0000-4000-8000-000000000007";
const INBOUND_QUANTITY_TARGET_ID = "10000000-0000-4000-8000-000000000008";
const RETURN_SHIPMENT_TARGET_ID = "10000000-0000-4000-8000-000000000006";

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

function addMockTeamMeeting() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const schedule: Schedule = {
    id: Crypto.randomUUID(),
    title: "팀 회의",
    date: formatLocalDate(tomorrow),
    time: "15:00",
    category: "기타",
    completed: false,
    notificationEnabled: true,
  };
  useScheduleStore.getState().addSchedule(schedule);

  return { text: "네, 일정을 추가했어요.", schedules: [schedule] };
}

function formatScheduleDateTime(schedule: Schedule) {
  const date = createDatePickerValue(schedule.date);
  const time = createTimePickerValue(schedule.time);
  const hour = time.getHours();
  const minute = time.getMinutes();
  const period = hour < 12 ? "오전" : "오후";
  const minuteText = minute === 0 ? "" : ` ${minute}분`;

  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${period} ${hour % 12 || 12}시${minuteText}`;
}

export function createMockDeleteConfirmation(scheduleId: string): {
  text: string;
  schedules: Schedule[];
  interaction?: AssistantInteraction;
} {
  const target = useScheduleStore
    .getState()
    .schedules.find((schedule) => schedule.id === scheduleId);
  if (!target) return { text: "일정을 찾지 못했어요.", schedules: [] };

  return {
    text: `${formatScheduleDateTime(target)} ${target.title}을 삭제할까요?`,
    schedules: [],
    interaction: {
      type: "delete-confirmation",
      scheduleId,
      resolved: false,
    },
  };
}

function runStandaloneMockScenario(input: string): {
  text: string;
  schedules: Schedule[];
  interaction?: AssistantInteraction;
} {
  switch (input) {
    case "작업장 안전 점검 삭제해 줘":
      return createMockDeleteConfirmation(SAFETY_INSPECTION_TARGET_ID);
    case "재고 일정 삭제해 줘": {
      const schedules = useScheduleStore.getState().schedules;
      const candidates = [INVENTORY_TARGET_ID, COMPLETED_INVENTORY_TARGET_ID]
        .map((id) => schedules.find((schedule) => schedule.id === id))
        .filter((schedule): schedule is Schedule => schedule !== undefined);
      if (candidates.length === 0) {
        return { text: "일정을 찾지 못했어요.", schedules: [] };
      }
      if (candidates.length === 1) {
        return createMockDeleteConfirmation(candidates[0].id);
      }
      return {
        text: "어느 일정을 삭제할까요?",
        schedules: [],
        interaction: {
          type: "candidate-selection",
          candidates: candidates.map((schedule) => ({
            scheduleId: schedule.id,
            label: `${schedule.title} · ${formatScheduleDateTime(schedule)}`,
          })),
          resolved: false,
        },
      };
    }
    case "내일 오후 3시 팀 회의 추가해 줘":
      return addMockTeamMeeting();
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
    case "작업장 안전 점검을 내일로 옮겨 줘": {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return updateMockSchedule(
        SAFETY_INSPECTION_TARGET_ID,
        { date: formatLocalDate(tomorrow) },
        "작업장 안전 점검 날짜를 내일로 변경했어요.",
      );
    }
    case "반품 택배 발송을 내일 오후 4시로 바꾸고 카테고리를 출고로 변경해 줘": {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return updateMockSchedule(
        RETURN_SHIPMENT_TARGET_ID,
        { date: formatLocalDate(tomorrow), time: "16:00", category: "출고" },
        "반품 택배 발송을 내일 오후 4시, 출고 카테고리로 변경했어요.",
      );
    }
    case "입고 상품 수량 확인 카테고리를 기타로 바꿔 줘":
      return updateMockSchedule(
        INBOUND_QUANTITY_TARGET_ID,
        { category: "기타" },
        "입고 상품 수량 확인 카테고리를 기타로 변경했어요.",
      );
    case "출고 상품 준비 알림 꺼 줘":
      return updateMockSchedule(
        OUTBOUND_PREPARATION_TARGET_ID,
        { notificationEnabled: false },
        "출고 상품 준비 알림을 껐어요.",
      );
    case "출고 상품 준비 알림 켜 줘":
      return updateMockSchedule(
        OUTBOUND_PREPARATION_TARGET_ID,
        { notificationEnabled: true },
        "출고 상품 준비 알림을 켰어요.",
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

export function resolveMockDeleteConfirmation(
  scheduleId: string,
  confirmed: boolean,
) {
  if (!confirmed) return { text: "삭제하지 않았어요." };

  const store = useScheduleStore.getState();
  const target = store.schedules.find((schedule) => schedule.id === scheduleId);
  if (!target) return { text: "일정을 찾지 못했어요." };

  store.deleteSchedule(scheduleId);
  return { text: "삭제했어요." };
}

// 지정된 입력 문장만 실행하는 개발용 Mock이며 자연어를 해석하지 않는다.
export function runMockAssistantScenario(
  input: string,
  pending: MockAssistantPending = null,
) {
  if (input === "내일 일정 추가해 줘") {
    return {
      text: "어떤 일정으로 추가할까요?",
      schedules: [],
      status: "need-more-info" as const,
      pending: "awaiting-team-meeting-title-and-time" as const,
    };
  }

  if (
    pending === "awaiting-team-meeting-title-and-time" &&
    input === "팀 회의"
  ) {
    return {
      text: "몇 시로 할까요?",
      schedules: [],
      status: "need-more-info" as const,
      pending: "awaiting-team-meeting-time" as const,
    };
  }

  if (input === "내일 팀 회의 추가해 줘") {
    return {
      text: "몇 시로 할까요?",
      schedules: [],
      status: "need-more-info" as const,
      pending: "awaiting-team-meeting-time" as const,
    };
  }

  if (input === "내일 오후 3시에 일정 추가해 줘") {
    return {
      text: "어떤 일정으로 추가할까요?",
      schedules: [],
      status: "need-more-info" as const,
      pending: "awaiting-team-meeting-title" as const,
    };
  }

  if (input === "오후 3시 팀 회의 추가해 줘") {
    return {
      text: "언제로 추가할까요?",
      schedules: [],
      status: "need-more-info" as const,
      pending: "awaiting-team-meeting-date" as const,
    };
  }

  const matchesFollowUp =
    (pending === "awaiting-team-meeting-time" && input === "오후 3시") ||
    (pending === "awaiting-team-meeting-title" && input === "팀 회의") ||
    (pending === "awaiting-team-meeting-date" && input === "내일");

  if (matchesFollowUp) {
    return {
      ...addMockTeamMeeting(),
      status: "idle" as const,
      pending: null,
    };
  }

  return {
    ...runStandaloneMockScenario(input),
    status: pending === null ? ("idle" as const) : ("need-more-info" as const),
    pending,
  };
}
