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
import { assistantFailureAdvice } from "@/utils/assistant-errors";
import type { AssistantUncertainView } from "@/utils/assistant-uncertain";
import type { AssistantRecoveryControl, AssistantRecoveryControlAction } from "@/utils/assistant-recovery-cleanup";

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
  onApiConfirmation?: (approved: boolean) => void;
  selectedApiApproval?: boolean;
  apiConfirmationExpired?: boolean;
  apiRecoveryText?: string;
  uncertainView?: AssistantUncertainView;
  uncertainErrorText?: string;
  uncertainActionsDisabled?: boolean;
  onUncertainCheck?: () => void;
  onUncertainAcknowledge?: () => void;
  recoveryControl?: AssistantRecoveryControl;
  onRecoveryAction?: (action: AssistantRecoveryControlAction) => void;
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
  onApiConfirmation,
  selectedApiApproval,
  apiConfirmationExpired,
  apiRecoveryText,
  uncertainView,
  uncertainErrorText,
  uncertainActionsDisabled = false,
  onUncertainCheck,
  onUncertainAcknowledge,
  recoveryControl,
  onRecoveryAction,
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
      {apiRecoveryText && <ThemedText type="small" themeColor="primaryForeground">{apiRecoveryText}</ThemedText>}
      {apiResult && <ApiResultDetails result={apiResult} onCandidateSelection={onApiCandidateSelection} selectedCandidateId={selectedApiCandidateId}
        onConfirmation={onApiConfirmation} selectedApproval={selectedApiApproval} confirmationExpired={apiConfirmationExpired} />}
      {uncertainView && <UncertainActions value={uncertainView} errorText={uncertainErrorText} disabled={uncertainActionsDisabled}
        onCheck={onUncertainCheck} onAcknowledge={onUncertainAcknowledge} />}
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
      {recoveryControl && <RecoveryActions value={recoveryControl} onAction={onRecoveryAction} />}
    </ThemedView>
  );
}

function RecoveryActions({ value, onAction }: { value: AssistantRecoveryControl;
  onAction?: (action: AssistantRecoveryControlAction) => void }) {
  const theme = useTheme();
  const done = value.phase === "removed" || value.phase === "not-found";
  const disabled = !onAction || value.phase === "working";
  const button = (action: AssistantRecoveryControlAction, label: string) => (
    <Pressable key={action} testID={`assistant-recovery-${action}`} accessibilityRole="button" disabled={disabled}
      accessibilityState={{ disabled }} onPress={disabled ? undefined : () => onAction?.(action)}
      style={[styles.buttonBase, { backgroundColor: theme.primaryForeground }, disabled && styles.disabled]}>
      <ThemedText themeColor="primary">{label}</ThemedText>
    </Pressable>
  );
  return <View style={styles.candidates} testID={`assistant-recovery-record-${JSON.stringify([value.reference.serverId, value.reference.requestId.toLowerCase()])}`}>
    <ThemedText type="small" themeColor="primaryForeground">서버: {value.reference.serverId}{"\n"}요청 ID: {value.reference.requestId}</ThemedText>
    {value.phase && <ThemedText type="small" themeColor="primaryForeground">{{
      confirming: "이 서버의 이 요청에 대한 로컬 복구 기록만 지워요. 서버 작업은 취소되지 않으며 과거 변경이 반영됐을 수 있어요. 성공·실패 판정이나 uncertain 보류 해제가 아니에요. 자동 복구 대상에서 빠지므로 같은 작업을 다시 보내지 마세요.",
      working: "로컬 복구 기록을 정리하고 있어요.",
      removed: "로컬 복구 기록을 정리했어요. 서버의 작업·결과·보류 상태는 바뀌지 않아요.",
      "not-found": "이 요청의 로컬 복구 기록은 이미 없어요. 서버 상태는 바뀌지 않아요.",
      retained: "정리 조건이 확인되지 않아 복구 기록을 유지했어요.",
      failed: "복구 기록을 정리하지 못했어요. 저장 상태를 확인해 주세요. 요청을 다시 실행하지 않았어요.",
    }[value.phase]}</ThemedText>}
    {!done && (value.phase === "confirming" ? <>
      {button("confirm-manual", "위험을 확인했고 로컬 기록만 정리")}{button("keep", "복구 기록 유지")}
    </> : <>
      {value.resultConfirmable && button("result", "결과 확인 및 복구 기록 정리")}
      {value.expiryConfirmable && button("expiry", "상세 보관 종료 안내 확인 및 기록 정리")}
      {button("manual", "로컬 복구 기록 수동 정리")}
    </>)}
  </View>;
}

function UncertainActions({ value, errorText, disabled, onCheck, onAcknowledge }: {
  value: AssistantUncertainView; errorText?: string; disabled: boolean; onCheck?: () => void; onAcknowledge?: () => void;
}) {
  const theme = useTheme();
  const acknowledgeDisabled = disabled || !value.canAcknowledge || value.armed || !onAcknowledge;
  const stateText = value.pendingRequestId ? value.acknowledged
    ? "위험 인지는 새 작업 접수와 함께 반영됐어요. 새 작업 결과는 확인이 필요해요."
    : "새 작업의 접수 여부가 미확인이에요. 새 ID로 다시 보내지 않고 원래 ID를 확인해 주세요."
    : value.armed ? "아직 서버에 인지가 반영되지 않았어요. 다음 입력은 과거 질문의 답변이 아닌 새 독립 text 작업으로 전송돼요."
    : value.acknowledged ? "위험 인지는 새 작업 접수와 함께 반영됐지만 과거 결과는 여전히 미확인이에요."
    : value.state === "pending" ? "아직 처리 중이에요. 새 요청을 보내지 않고 상태를 다시 확인해 주세요."
    : value.state === "expired" ? "상세 보관 기간이 지나 과거 성공·실패는 알 수 없어요."
    : value.state === "unknown" ? "현재 상태를 확인하지 못했어요. 먼저 원래 요청을 다시 확인해 주세요." : "결과가 아직 확인되지 않았어요.";
  return <>
    <ThemedText type="small" themeColor="primaryForeground">{value.state === "resolved"
      ? "과거 요청의 결과는 확정됐어요. 별도로 보낸 새 작업은 원래 ID로 확인해 주세요."
      : <>
      과거 일정 변경이 반영됐을 수 있으며 아직 확정되지 않았어요. 같은 변경을 반복하면 중복될 위험이 있어요.
      위험 인지는 과거 작업의 취소·성공·실패 판정이 아니에요. 일정 목록에서도 직접 확인해 주세요.
      </>}
    </ThemedText>
    <ThemedText type="small" themeColor="primaryForeground">{stateText}</ThemedText>
    {errorText && <ThemedText type="small" themeColor="primaryForeground">{errorText}</ThemedText>}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || !onCheck }} disabled={disabled || !onCheck}
        onPress={disabled ? undefined : onCheck} style={[styles.buttonBase, styles.action, { backgroundColor: theme.primaryForeground }, disabled && styles.disabled]}>
        <ThemedText themeColor="primary">{value.pendingRequestId ? "새 작업 결과 확인" : "원래 요청 결과 확인"}</ThemedText>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: acknowledgeDisabled, selected: value.armed }} disabled={acknowledgeDisabled}
        onPress={acknowledgeDisabled ? undefined : onAcknowledge}
        style={[styles.buttonBase, styles.action, { backgroundColor: theme.primaryForeground }, acknowledgeDisabled && styles.disabled]}>
        <ThemedText themeColor="primary">위험을 이해하고 새 작업 입력</ThemedText>
      </Pressable>
    </View>
  </>;
}

// 서버 후속 입력 callback은 Mock interaction 실행과 분리한다.
function ApiResultDetails({ result, onCandidateSelection, selectedCandidateId, onConfirmation, selectedApproval, confirmationExpired }: {
  result: AssistantResultDisplay;
  onCandidateSelection?: (candidateId: string) => void;
  selectedCandidateId?: string;
  onConfirmation?: (approved: boolean) => void;
  selectedApproval?: boolean;
  confirmationExpired?: boolean;
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
        {confirmationExpired && <ThemedText type="small" themeColor="primaryForeground">확인 기한이 지났어요.</ThemedText>}
        <ConfirmationActions disabled={!onConfirmation || Boolean(confirmationExpired)} onConfirm={onConfirmation} selectedApproved={selectedApproval} />
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
    case "failure": return <>
      <ThemedText type="small" themeColor="primaryForeground">처리 실패</ThemedText>
      <ThemedText type="small" themeColor="primaryForeground">{assistantFailureAdvice(result.nextAction)}</ThemedText>
    </>;
    case "uncertain": return <ThemedText type="small" themeColor="primaryForeground">결과 미확인</ThemedText>;
  }
}

function ConfirmationActions({ disabled, onConfirm, selectedApproved }: {
  disabled: boolean; onConfirm?: (confirmed: boolean) => void; selectedApproved?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.actions}>
      {([false, true] as const).map(confirmed => (
        <Pressable key={String(confirmed)} accessibilityRole="button"
          accessibilityState={{ disabled, ...(selectedApproved !== undefined ? { selected: selectedApproved === confirmed } : {}) }} disabled={disabled}
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
