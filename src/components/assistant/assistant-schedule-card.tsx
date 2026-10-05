import { StyleSheet, View } from "react-native";

import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { Schedule } from "@/types/schedule";

type AssistantScheduleCardProps = {
  schedule: Schedule;
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

export function AssistantScheduleCard({ schedule }: AssistantScheduleCardProps) {
  const theme = useTheme();

  return (
    <ThemedView style={styles.card}>
      <View style={[styles.badge, { backgroundColor: theme.primaryMuted }]}>
        <ThemedText type="smallBold" themeColor="primary">
          {schedule.category}
        </ThemedText>
      </View>
      <ThemedText style={styles.title}>{schedule.title}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {`${formatCardDate(schedule.date)} ${formatCardTime(schedule.time)}`}
      </ThemedText>
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
  title: {
    fontWeight: "700",
  },
});
