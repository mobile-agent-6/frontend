import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { MonthCalendar } from "@/components/calendar/month-calendar";
import { Header } from "@/components/navigation/header";
import { ScheduleCard } from "@/components/schedule-list/schedule-card";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useScheduleStore } from "@/stores/scheduleStore";
import { formatLocalDate } from "@/utils/schedule-date-time";

export default function CalendarScreen() {
  const router = useRouter();
  const schedules = useScheduleStore((state) => state.schedules);
  const toggleCompleted = useScheduleStore((state) => state.toggleCompleted);
  const [selectedDate, setSelectedDate] = useState(() =>
    formatLocalDate(new Date()),
  );
  const [visibleMonth, setVisibleMonth] = useState(
    () => `${selectedDate.slice(0, 7)}-01`,
  );
  const scheduleDates = useMemo(
    () => [...new Set(schedules.map((schedule) => schedule.date))],
    [schedules],
  );
  const selectedDateTitle = useMemo(() => {
    const [year, month, day] = selectedDate.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];

    return `${month}월 ${day}일 (${weekday})`;
  }, [selectedDate]);
  const selectedSchedules = useMemo(
    () =>
      schedules
        .filter((schedule) => schedule.date === selectedDate)
        .sort((a, b) => a.time.localeCompare(b.time)),
    [schedules, selectedDate],
  );

  return (
    <ThemedView style={styles.screen}>
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

        <View style={styles.scheduleList}>
          {selectedSchedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              showDate={false}
              onToggleCompleted={() => toggleCompleted(schedule.id)}
              onPress={() =>
                router.push({
                  pathname: "/schedule/[id]",
                  params: { id: schedule.id },
                })
              }
            />
          ))}
        </View>
      </ScrollView>
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
    fontWeight: "700",
  },
  scheduleList: {
    marginTop: Spacing.two,
    gap: 12,
  },
});
