import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { ScrollView, StyleSheet, View } from "react-native";

import { MonthCalendar } from "@/components/calendar/month-calendar";
import { Header } from "@/components/navigation/header";
import { ScheduleCard } from "@/components/schedule-list/schedule-card";
import { ScheduleListState } from "@/components/schedule-list/schedule-list-state";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useScheduleData } from "@/hooks/use-schedule-data";
import { useScheduleEditNavigation } from "@/hooks/use-schedule-edit-navigation";
import { useScheduleCompletion, useServerScheduleData } from "@/hooks/use-server-schedule-data";
import { isMockScheduleMode, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { getCalendarScheduleRange } from "@/utils/schedule-query";
import { formatLocalDate } from "@/utils/schedule-date-time";

export default function CalendarScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const openSchedule = useScheduleEditNavigation();
  const [selectedDate, setSelectedDate] = useState(() =>
    formatLocalDate(new Date()),
  );
  const [visibleMonth, setVisibleMonth] = useState(
    () => `${selectedDate.slice(0, 7)}-01`,
  );
  const serverMode = useStore(scheduleDataModeStore, (state) => state.mode === "server");
  const mock = useScheduleData(!serverMode);
  const month = useServerScheduleData(getCalendarScheduleRange(visibleMonth), serverMode);
  const dayStart = `${selectedDate}T00:00:00+09:00`;
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const selected = useServerScheduleData(getCalendarScheduleRange(selectedDate.slice(0, 7)), serverMode,
    { from: dayStart, to: dayEnd });
  const completion = useScheduleCompletion(selected.serverId, serverMode);
  const schedules = serverMode ? selected.schedules : mock.schedules;
  const readError = serverMode ? Boolean(selected.error) : mock.readError;
  const hasSuccessfulRead = serverMode ? selected.hasSuccessfulRead : mock.hasSuccessfulRead;
  const retryRead = serverMode ? selected.retryRead : mock.retryRead;
  const { toggleCompleted, canOpenSchedule } = mock;
  const retryCompletion = serverMode ? completion.retryCompletion : mock.retryCompletion;
  const completionError = serverMode ? completion.completionError : mock.completionError;
  const needsRefresh = serverMode && selected.hasSuccessfulRead && selected.stale && !selected.isFetching &&
    !selected.error && !selected.refreshPending && !completionError;
  const loading = serverMode && selected.initialLoading;
  const canShowEmpty = serverMode ? selected.success && selected.coverage(dayStart, dayEnd) === "covered"
    : !readError || hasSuccessfulRead;
  const separateMonthStatus = serverMode && (month.query?.from !== selected.query?.from || month.query?.to !== selected.query?.to);
  const feedback = <>
    {readError && !(serverMode && selected.completionRefreshFailed) && <ScheduleListState state="error" onRetry={retryRead}
      errorTitle={hasSuccessfulRead ? "최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요." : undefined} />}
    {needsRefresh && <ScheduleListState state="notice" errorTitle="일정 정보를 다시 확인해 주세요." onRetry={retryRead} retryLabel="GET 다시 조회" />}
    {completionError && <ScheduleListState state={serverMode ? completion.completionNoticeState : "error"}
      errorTitle={serverMode ? completion.completionError ?? undefined : "완료 상태를 변경하지 못했어요."}
      onRetry={retryCompletion} retryLabel={serverMode ? "GET 상태 확인" : undefined} />}
  </>;
  const scheduleDates = useMemo(
    () => {
      const dots = serverMode ? (month.hasSuccessfulRead ? month.schedules : []) : mock.schedules;
      return [...new Set(dots.filter((schedule) => !serverMode || schedule.date.slice(0, 7) === visibleMonth.slice(0, 7))
        .map((schedule) => schedule.date))];
    },
    [month.hasSuccessfulRead, month.schedules, mock.schedules, serverMode, visibleMonth],
  );
  const selectedDateTitle = useMemo(() => {
    const [year, month, day] = selectedDate.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];

    return `${month}월 ${day}일 (${weekday})`;
  }, [selectedDate]);
  const selectedSchedules = useMemo(
    () => {
      const filtered = schedules.filter((schedule) => schedule.date === selectedDate);
      return serverMode ? filtered : filtered.sort((a, b) => a.time.localeCompare(b.time));
    },
    [schedules, selectedDate, serverMode],
  );

  return (
    <ThemedView
      style={[
        styles.screen,
        {
          backgroundColor:
            colorScheme === "dark" ? theme.background : "#FCF9F7",
        },
      ]}
    >
      <Header title="캘린더" />

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.calendarContent}
      >
        <MonthCalendar
          visibleMonth={visibleMonth}
          selectedDate={selectedDate}
          scheduleDates={scheduleDates}
          onSelectDate={(date) => setSelectedDate(date.dateString)}
          onMonthChange={(month) =>
            setVisibleMonth(`${month.dateString.slice(0, 7)}-01`)
          }
        />

        <ThemedText style={styles.selectedDateTitle}>
          {selectedDateTitle}
        </ThemedText>

        <View testID="calendar-schedule-list" style={[styles.scheduleList, !serverMode && readError && styles.readErrorList]}>
          {loading && <ScheduleListState state="loading" />}
          {(!serverMode || !hasSuccessfulRead) && feedback}
          {selectedSchedules.length === 0 && canShowEmpty ? (
            <View style={styles.emptyState}>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.emptyText}
              >
                일정 없음
              </ThemedText>
            </View>
          ) : (
            selectedSchedules.map((schedule) => (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                showDate={false}
                completionDisabled={serverMode && completion.completionDisabled(schedule.id)}
                onToggleCompleted={() => serverMode ? completion.toggleCompleted(schedule.id) : isMockScheduleMode() && toggleCompleted(schedule)}
                onPress={() => (serverMode || canOpenSchedule()) && openSchedule(schedule.id)}
              />
            ))
          )}
        </View>
      </ScrollView>
      {serverMode && ((hasSuccessfulRead && (readError || needsRefresh || completionError)) ||
        (separateMonthStatus && (month.initialLoading || month.error))) && (
        <ScrollView testID="schedule-feedback" style={styles.feedback} contentContainerStyle={styles.feedbackContent}>
          {hasSuccessfulRead && feedback}
          {separateMonthStatus && month.initialLoading && <ScheduleListState state="loading" />}
          {separateMonthStatus && month.error && <ScheduleListState state="error"
            errorTitle="캘린더의 최신 정보를 불러오지 못했어요. 이전 정보를 표시하고 있어요." onRetry={month.retryRead} />}
        </ScrollView>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  calendarContent: {
    padding: Spacing.three,
  },
  selectedDateTitle: {
    marginTop: Spacing.three,
    marginLeft: Spacing.one,
    fontWeight: "700",
  },
  scheduleList: {
    marginTop: Spacing.two,
    gap: 12,
  },
  feedback: { flexGrow: 0, maxHeight: "40%" },
  feedbackContent: { gap: Spacing.two, padding: Spacing.three },
  readErrorList: { marginTop: 16 },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.three,
  },
  emptyText: {
    fontSize: 16,
    textAlign: "center",
  },
});
