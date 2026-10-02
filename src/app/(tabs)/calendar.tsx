import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";

import { MonthCalendar } from "@/components/calendar/month-calendar";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { formatLocalDate } from "@/utils/schedule-date-time";

const EMPTY_SCHEDULE_DATES: readonly string[] = [];

export default function CalendarScreen() {
  const [selectedDate, setSelectedDate] = useState(() =>
    formatLocalDate(new Date()),
  );
  const [visibleMonth, setVisibleMonth] = useState(
    () => `${selectedDate.slice(0, 7)}-01`,
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
          scheduleDates={EMPTY_SCHEDULE_DATES}
          onSelectDate={(date) => setSelectedDate(date.dateString)}
          onMonthChange={(month) =>
            setVisibleMonth(`${month.dateString.slice(0, 7)}-01`)
          }
        />
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
});
