import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native";

import { ScheduleEditForm } from "@/components/schedule-edit/schedule-edit-form";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useScheduleStore } from "@/stores/scheduleStore";

export default function ScheduleEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const schedules = useScheduleStore((state) => state.schedules);
  const schedule =
    typeof id === "string" && id.length > 0
      ? schedules.find((item) => item.id === id)
      : undefined;

  if (!schedule) {
    return (
      <ThemedView style={styles.notFound}>
        <ThemedText>일정을 찾을 수 없어요.</ThemedText>
      </ThemedView>
    );
  }

  return <ScheduleEditForm key={schedule.id} schedule={schedule} />;
}

const styles = StyleSheet.create({
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.four,
  },
});
