import { Pressable, StyleSheet, View } from "react-native";

import { AssistantScheduleCard } from "@/components/assistant/assistant-schedule-card";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { AssistantDeleteConfirmation } from "@/types/assistant";
import type { Schedule } from "@/types/schedule";

type AssistantMessageProps = {
  text: string;
  schedules?: readonly Schedule[];
  interaction?: AssistantDeleteConfirmation;
  onDeleteConfirmation?: (confirmed: boolean) => void;
};

export function AssistantMessage({
  text,
  schedules,
  interaction,
  onDeleteConfirmation,
}: AssistantMessageProps) {
  const theme = useTheme();
  const confirmationDisabled = interaction?.resolved || !onDeleteConfirmation;
  return (
    <ThemedView type="primary" style={styles.bubble}>
      <ThemedText themeColor="primaryForeground">{text}</ThemedText>
      {schedules?.map((schedule) => (
        <AssistantScheduleCard key={schedule.id} schedule={schedule} />
      ))}
      {interaction?.type === "delete-confirmation" && (
        <View style={styles.actions}>
          {([false, true] as const).map((confirmed) => (
            <Pressable
              key={String(confirmed)}
              accessibilityRole="button"
              accessibilityState={{ disabled: confirmationDisabled }}
              disabled={confirmationDisabled}
              onPress={() => onDeleteConfirmation?.(confirmed)}
              style={[
                styles.action,
                {
                  backgroundColor: confirmed
                    ? theme.primaryForeground
                    : "#FC8957",
                },
                confirmationDisabled && styles.disabled,
              ]}
            >
              <ThemedText
                themeColor={confirmed ? "primary" : "primaryForeground"}
              >
                {confirmed ? "예" : "아니요"}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: Spacing.two,
  },
  action: {
    flex: 1,
    minHeight: 44,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
  },
  disabled: {
    opacity: 0.5,
  },
  bubble: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    borderRadius: 20,
    borderBottomLeftRadius: 4,
    padding: Spacing.three,
    gap: Spacing.two,
  },
});
