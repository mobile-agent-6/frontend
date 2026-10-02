import { useMemo } from "react";
import { Calendar, type CalendarProps } from "react-native-calendars";

import { useTheme } from "@/hooks/use-theme";

type MonthCalendarProps = {
  /** YYYY-MM-DD 형식. 일반적으로 현재 표시 중인 월의 1일을 사용한다. */
  visibleMonth: string;
  /** YYYY-MM-DD 형식 */
  selectedDate: string;
  /** 부모에서 전달받은 일정 날짜 목록. 완료된 일정도 포함한다. */
  scheduleDates: readonly string[];
  onSelectDate: NonNullable<CalendarProps["onDayPress"]>;
  onMonthChange: NonNullable<CalendarProps["onMonthChange"]>;
};

export function MonthCalendar({
  visibleMonth,
  selectedDate,
  scheduleDates,
  onSelectDate,
  onMonthChange,
}: MonthCalendarProps) {
  const theme = useTheme();
  const markedDates = useMemo<NonNullable<CalendarProps["markedDates"]>>(() => {
    const scheduleMarkings: NonNullable<CalendarProps["markedDates"]> =
      Object.fromEntries(scheduleDates.map((date) => [date, { marked: true }]));

    return {
      ...scheduleMarkings,
      [selectedDate]: {
        ...scheduleMarkings[selectedDate],
        selected: true,
      },
    };
  }, [scheduleDates, selectedDate]);

  return (
    <Calendar
      initialDate={visibleMonth}
      monthFormat="yyyy년 M월"
      markedDates={markedDates}
      onDayPress={onSelectDate}
      onMonthChange={onMonthChange}
      theme={{
        calendarBackground: theme.background,
        dayTextColor: theme.text,
        monthTextColor: theme.text,
        textSectionTitleColor: theme.textSecondary,
        textDisabledColor: theme.textSecondary,
        arrowColor: theme.primary,
        selectedDayBackgroundColor: theme.primary,
        selectedDayTextColor: theme.primaryForeground,
        todayTextColor: theme.primary,
        todayBackgroundColor: theme.primaryMuted,
        dotColor: theme.primary,
        selectedDotColor: theme.primaryForeground,
      }}
    />
  );
}
