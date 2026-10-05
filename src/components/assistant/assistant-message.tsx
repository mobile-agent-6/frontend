import { StyleSheet } from "react-native";

import { AssistantScheduleCard } from "@/components/assistant/assistant-schedule-card";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import type { Schedule } from "@/types/schedule";

type AssistantMessageProps = {
  text: string;
  schedules?: readonly Schedule[];
};

export function AssistantMessage({ text, schedules }: AssistantMessageProps) {
  return (
    <ThemedView type="primary" style={styles.bubble}>
      <ThemedText themeColor="primaryForeground">{text}</ThemedText>
      {schedules?.map((schedule) => (
        <AssistantScheduleCard key={schedule.id} schedule={schedule} />
      ))}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    borderRadius: 20,
    borderBottomLeftRadius: 4,
    padding: Spacing.three,
    gap: Spacing.two,
  },
});
