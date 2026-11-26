import { StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { Schedule } from "@/types/schedule";

type AssistantScheduleCardProps = {
  // 후보 DTO에 없는 일정 ID·완료 여부를 표시 때문에 만들어 넣지 않는다.
  schedule: Pick<Schedule, "title" | "date" | "time" | "category"> & { completed?: boolean };
  showCompleted?: boolean;
  compact?: boolean;
};

function formatCardDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][
    new Date(year, month - 1, day).getDay()
  ];

  return `${month}월 ${day}일 (${weekday})`;
}

function formatCardTime(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const period = hour < 12 ? "오전" : "오후";

  return `${period} ${hour % 12 || 12}:${String(minute).padStart(2, "0")}`;
}

export function formatAssistantCardDateTime(date: string, time: string) {
  return `${formatCardDate(date)} ${formatCardTime(time)}`;
}

export function AssistantScheduleCard({ schedule, showCompleted = false, compact = false }: AssistantScheduleCardProps) {
  const theme = useTheme();

  return (
    <ThemedView style={[styles.card, compact && styles.compactCard]}>
      <View style={[styles.badge, compact && styles.compactBadge, { backgroundColor: theme.primaryMuted }]}>
        <ThemedText type="smallBold" themeColor="primary">
          {schedule.category}
        </ThemedText>
      </View>
      <ThemedText style={styles.title}>{schedule.title}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {formatAssistantCardDateTime(schedule.date, schedule.time)}
      </ThemedText>
      {showCompleted && schedule.completed !== undefined && (
        <ThemedText type="small" themeColor="textSecondary">
          {schedule.completed ? "완료" : "미완료"}
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    borderRadius: 16,
    padding: 12,
    gap: Spacing.two,
  },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 12,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  compactCard: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingRight: 36,
    gap: 4,
    borderRadius: 12,
  },
  compactBadge: {
    paddingVertical: 2,
  },
  title: {
    fontWeight: "700",
  },
});
