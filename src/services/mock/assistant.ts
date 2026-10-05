import * as Crypto from "expo-crypto";

import { useScheduleStore } from "@/stores/scheduleStore";
import type { Schedule } from "@/types/schedule";
import { formatLocalDate } from "@/utils/schedule-date-time";

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
    default:
      return {
        text: "메시지를 받았어요. 지금은 텍스트 대화 흐름을 확인하는 단계예요.",
        schedules: [],
      };
  }
}
