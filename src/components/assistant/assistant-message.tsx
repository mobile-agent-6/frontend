import { Pressable, StyleSheet, Text, View } from "react-native";

import { AssistantScheduleCard, formatAssistantCardDateTime } from "@/components/assistant/assistant-schedule-card";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type {
  AssistantCandidateSelection,
  AssistantInteraction,
} from "@/types/assistant";
import type { Schedule } from "@/types/schedule";
import type { AssistantResultDisplay } from "@/utils/assistant-mapper";

type AssistantMessageProps = {
  text: string;
  apiResult?: AssistantResultDisplay;
  schedules?: readonly Schedule[];
  interaction?: AssistantInteraction;
  interactionsDisabled?: boolean;
  onDeleteConfirmation?: (confirmed: boolean) => void;
  onCandidateSelection?: (scheduleId: string) => void;
  onApiCandidateSelection?: (candidateId: string) => void;
  selectedApiCandidateId?: string;
};

export function AssistantMessage({
  text,
  apiResult,
  schedules,
  interaction,
  interactionsDisabled = false,
  onDeleteConfirmation,
  onCandidateSelection,
  onApiCandidateSelection,
  selectedApiCandidateId,
}: AssistantMessageProps) {
  const theme = useTheme();
  const confirmationDisabled = interactionsDisabled || interaction?.resolved || !onDeleteConfirmation;
  return (
    <ThemedView type="primary" style={styles.bubble}>
      <Text
        selectable
        style={[styles.messageText, { color: theme.primaryForeground }]}
      >
        {text}
      </Text>
      {apiResult && <ApiResultDetails result={apiResult} onCandidateSelection={onApiCandidateSelection} selectedCandidateId={selectedApiCandidateId} />}
      {!apiResult && schedules?.map((schedule) => (
        <AssistantScheduleCard key={schedule.id} schedule={schedule} />
      ))}
      {!apiResult && interaction?.type === "delete-confirmation" && (
        <ConfirmationActions disabled={Boolean(confirmationDisabled)} onConfirm={onDeleteConfirmation} />
      )}
      {!apiResult && interaction?.type === "candidate-selection" && (
        <CandidateSelectionInteraction
          interaction={interaction}
          onSelect={onCandidateSelection}
          processing={interactionsDisabled}
        />
      )}
    </ThemedView>
  );
}

// 서버 후보 선택 callback은 Mock interaction·confirmation 실행과 분리한다.
function ApiResultDetails({ result, onCandidateSelection, selectedCandidateId }: {
  result: AssistantResultDisplay;
  onCandidateSelection?: (candidateId: string) => void;
  selectedCandidateId?: string;
}) {
  const theme = useTheme();
  switch (result.kind) {
    case "need_more_info": return null;
    case "candidate_selection": {
      const disabled = !onCandidateSelection;
      return (
      <View style={styles.candidates}>
        {result.candidates.map(candidate => (
          <Pressable key={candidate.candidateId} accessibilityRole="button"
            accessibilityState={{ disabled, selected: candidate.candidateId === selectedCandidateId }} disabled={disabled}
            onPress={disabled ? undefined : () => onCandidateSelection?.(candidate.candidateId)}
            style={[styles.buttonBase, styles.candidate, { backgroundColor: theme.primaryForeground }, disabled && styles.disabled]}>
            <AssistantScheduleCard schedule={candidate} />
            {candidate.candidateId === selectedCandidateId && <ThemedText type="small" themeColor="primary">선택됨</ThemedText>}
          </Pressable>
        ))}
      </View>
      );
    }
    case "confirmation": return (
      <>
        <ThemedText type="small" themeColor="primaryForeground">
          {result.operation === "delete" ? "삭제 대상" : "수정 대상"}
        </ThemedText>
        <AssistantScheduleCard schedule={result.target} showCompleted />
        {result.operation === "update" && (
          <View style={styles.candidates}>
            {result.changes.title !== undefined && (
              <ThemedText themeColor="primaryForeground">{`제목: ${result.target.title} → ${result.changes.title}`}</ThemedText>
            )}
            {result.changes.date !== undefined && result.changes.time !== undefined && (
              <ThemedText themeColor="primaryForeground">
                {`일시: ${formatAssistantCardDateTime(result.target.date, result.target.time)} → ${formatAssistantCardDateTime(result.changes.date, result.changes.time)}`}
              </ThemedText>
            )}
            {result.changes.category !== undefined && (
              <ThemedText themeColor="primaryForeground">{`분류: ${result.target.category} → ${result.changes.category}`}</ThemedText>
            )}
            {result.changes.completed !== undefined && (
              <ThemedText themeColor="primaryForeground">
                {`완료 상태: ${result.target.completed ? "완료" : "미완료"} → ${result.changes.completed ? "완료" : "미완료"}`}
              </ThemedText>
            )}
          </View>
        )}
        <ConfirmationActions disabled />
      </>
    );
    case "outcome": {
      const operation = result.operation === undefined ? undefined : {
        create: "등록", list: "조회", update: "수정", delete: "삭제",
      }[result.operation];
      const label = result.outcome === "success" ? "완료"
        : result.outcome === "cancelled" ? "취소됨" : "대상 없음";
      return (
        <>
          <ThemedText type="small" themeColor="primaryForeground">{operation === undefined ? label : `${operation} ${label}`}</ThemedText>
          {result.outcome === "success" && result.operation === "list" && result.items.map(item => (
            <AssistantScheduleCard key={item.id} schedule={item} showCompleted />
          ))}
        </>
      );
    }
    case "failure": return <ThemedText type="small" themeColor="primaryForeground">처리 실패</ThemedText>;
    case "uncertain": return <ThemedText type="small" themeColor="primaryForeground">결과 미확인</ThemedText>;
  }
}

function ConfirmationActions({ disabled, onConfirm }: { disabled: boolean; onConfirm?: (confirmed: boolean) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.actions}>
      {([false, true] as const).map(confirmed => (
        <Pressable key={String(confirmed)} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
          onPress={disabled ? undefined : () => onConfirm?.(confirmed)}
          style={[styles.buttonBase, styles.action, { backgroundColor: confirmed ? theme.primaryForeground : "#FC8957" }, disabled && styles.disabled]}>
          <ThemedText themeColor={confirmed ? "primary" : "primaryForeground"}>{confirmed ? "예" : "아니요"}</ThemedText>
        </Pressable>
      ))}
    </View>
  );
}

function CandidateSelectionInteraction({
  interaction,
  onSelect,
  processing,
}: {
  interaction: AssistantCandidateSelection;
  onSelect?: (scheduleId: string) => void;
  processing: boolean;
}) {
  const theme = useTheme();
  const disabled = processing || interaction.resolved || !onSelect;
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
