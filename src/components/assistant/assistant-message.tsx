import { Pressable, StyleSheet, Text, View } from "react-native";

import { AssistantScheduleCard } from "@/components/assistant/assistant-schedule-card";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type {
  AssistantCandidateSelection,
  AssistantInteraction,
} from "@/types/assistant";
import type { Schedule } from "@/types/schedule";

type AssistantMessageProps = {
  text: string;
  schedules?: readonly Schedule[];
  interaction?: AssistantInteraction;
  onDeleteConfirmation?: (confirmed: boolean) => void;
  onCandidateSelection?: (scheduleId: string) => void;
};

export function AssistantMessage({
  text,
  schedules,
  interaction,
  onDeleteConfirmation,
  onCandidateSelection,
}: AssistantMessageProps) {
  const theme = useTheme();
  const confirmationDisabled = interaction?.resolved || !onDeleteConfirmation;
  return (
    <ThemedView type="primary" style={styles.bubble}>
      <Text
        selectable
        style={[styles.messageText, { color: theme.primaryForeground }]}
      >
        {text}
      </Text>
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
                styles.buttonBase,
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
      {interaction?.type === "candidate-selection" && (
        <CandidateSelectionInteraction
          interaction={interaction}
          onSelect={onCandidateSelection}
        />
      )}
    </ThemedView>
  );
}

function CandidateSelectionInteraction({
  interaction,
  onSelect,
}: {
  interaction: AssistantCandidateSelection;
  onSelect?: (scheduleId: string) => void;
}) {
  const theme = useTheme();
  const disabled = interaction.resolved || !onSelect;
  return (
    <View style={styles.candidates}>
      {interaction.candidates.map((candidate) => (
        <Pressable
          key={candidate.scheduleId}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => onSelect?.(candidate.scheduleId)}
          style={[
            styles.buttonBase,
            styles.candidate,
            { backgroundColor: theme.primaryForeground },
            disabled && styles.disabled,
          ]}
        >
          <ThemedText themeColor="primary">
            {candidate.label}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  messageText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 500,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  candidates: {
    alignSelf: "stretch",
    gap: Spacing.two,
  },
  candidate: {
    paddingVertical: Spacing.two,
  },
  actions: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: Spacing.two,
  },
  buttonBase: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
  },
  action: {
    flex: 1,
    minWidth: 64,
    alignItems: "center",
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
