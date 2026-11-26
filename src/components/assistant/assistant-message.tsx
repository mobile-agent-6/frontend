import { Pressable, StyleSheet, Text, View } from "react-native";
import { useState, type ComponentRef, type Ref } from "react";
import { SymbolView } from "expo-symbols";

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
import { ASSISTANT_CONNECTION_ERROR_NOTICE } from "@/utils/assistant-recovery-messages";
import type { AssistantUncertainView } from "@/utils/assistant-uncertain";
import type { AssistantRecoveryControl, AssistantRecoveryControlAction } from "@/utils/assistant-recovery-cleanup";
import type { AssistantScheduleSyncEntry } from "@/services/api/assistant-schedule-sync";

type AssistantMessageProps = {
  text: string;
  resultTextRef?: Ref<ComponentRef<typeof Text>>;
  resultTextKey?: string;
  onResultTextLayout?: () => void;
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
  onResultRecheck?: () => void;
  resultRechecking?: boolean;
  resultRecheckDisabled?: boolean;
  recoveryControl?: AssistantRecoveryControl;
  recoveryIssue?: boolean;
  recoveryNotice?: boolean;
  onRecoveryAction?: (action: AssistantRecoveryControlAction) => void;
  scheduleSyncEntry?: AssistantScheduleSyncEntry;
  scheduleSyncRetrying?: boolean;
  onScheduleSyncRetry?: () => void;
};

export function AssistantMessage({
  text,
  resultTextRef,
  resultTextKey,
  onResultTextLayout,
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
  onResultRecheck,
  resultRechecking = false,
  resultRecheckDisabled = false,
  recoveryControl,
  recoveryIssue = false,
  recoveryNotice = false,
  onRecoveryAction,
  scheduleSyncEntry,
  scheduleSyncRetrying = false,
  onScheduleSyncRetry,
}: AssistantMessageProps) {
  const theme = useTheme();
  const confirmationDisabled = interactionsDisabled || interaction?.resolved || !onDeleteConfirmation;
  const hasConfirmation = apiResult?.kind === "confirmation" || interaction?.type === "delete-confirmation";
  const isConnectionNotice = Boolean(onResultRecheck && text === ASSISTANT_CONNECTION_ERROR_NOTICE);
  const paragraphs = isConnectionNotice ? text.split("\n\n") : [text];
  const showRecoveryActions = Boolean(recoveryControl &&
    (recoveryIssue || apiResult?.kind === "failure" || apiResult?.kind === "uncertain" || recoveryControl.phase === "failed"));
  const compactRecoveryButtons = Boolean(onResultRecheck && showRecoveryActions && !recoveryControl?.phase &&
    !recoveryControl?.resultConfirmable && !recoveryControl?.expiryConfirmable &&
    !apiResult && !scheduleSyncEntry && !uncertainView && !schedules?.length && !interaction);
  const compactRecoveryNotice = recoveryNotice && showRecoveryActions &&
    recoveryControl?.phase !== "removed" && recoveryControl?.phase !== "not-found";
  const recoveryActions = showRecoveryActions && recoveryControl
    ? <RecoveryActions value={recoveryControl} onAction={onRecoveryAction}
        balancedManagementSpacing={isConnectionNotice && compactRecoveryButtons} centerButtonText={isConnectionNotice || recoveryNotice} /> : null;
  const resultRecheckButton = onResultRecheck && <Pressable testID="assistant-result-recheck" accessibilityRole="button"
    accessibilityState={{ disabled: resultRecheckDisabled || resultRechecking, busy: resultRechecking }}
    disabled={resultRecheckDisabled || resultRechecking}
    onPress={resultRecheckDisabled || resultRechecking ? undefined : onResultRecheck}
    style={[styles.buttonBase, { backgroundColor: theme.primaryForeground },
      (resultRecheckDisabled || resultRechecking) && styles.disabled]}>
    <ThemedText themeColor="primary" style={isConnectionNotice ? styles.centeredButtonText : undefined}>
      {resultRechecking ? "결과를 확인하고 있어요…" : "결과 다시 확인"}
    </ThemedText>
  </Pressable>;
  return (
    <ThemedView type="primary" style={[styles.bubble, hasConfirmation && styles.confirmationBubble,
      (isConnectionNotice || recoveryNotice) && styles.connectionNoticeBubble,
      (compactRecoveryButtons || compactRecoveryNotice || (showRecoveryActions && recoveryControl?.phase === "confirming")) && styles.compactRecoveryBubble]}>
      <Text
        key={resultTextKey}
        ref={resultTextRef}
        onTextLayout={event => {
          if (event.nativeEvent.lines.some(line => line.width > 0 && line.height > 0)) onResultTextLayout?.();
        }}
        selectable
        style={[styles.messageText, { color: theme.primaryForeground }]}
      >
        {paragraphs[0]}
      </Text>
      {paragraphs.length > 1 && <Text selectable style={[styles.messageText, { color: theme.primaryForeground }]}>
        {paragraphs[1]}
      </Text>}
      {apiRecoveryText && <ThemedText type="small" themeColor="primaryForeground">{apiRecoveryText}</ThemedText>}
      {compactRecoveryButtons ? <View style={styles.recoveryButtons}>{resultRecheckButton}{recoveryActions}</View> : resultRecheckButton}
      {apiResult && <ApiResultDetails result={apiResult} onCandidateSelection={onApiCandidateSelection} selectedCandidateId={selectedApiCandidateId}
        onConfirmation={onApiConfirmation} selectedApproval={selectedApiApproval} confirmationExpired={apiConfirmationExpired} />}
      {scheduleSyncEntry && <ScheduleSyncStatus entry={scheduleSyncEntry} retrying={scheduleSyncRetrying} onRetry={onScheduleSyncRetry}
        showCompleted={apiResult?.kind !== "outcome" || apiResult.operation !== "create"} />}
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
      {!compactRecoveryButtons && recoveryActions}
    </ThemedView>
  );
}

function ScheduleSyncStatus({ entry, retrying, onRetry, showCompleted }: {
  entry: AssistantScheduleSyncEntry; retrying: boolean; onRetry?: () => void; showCompleted: boolean;
}) {
  const theme = useTheme();
  const canRetry = entry.phase === "refresh-error" || entry.phase === "interrupted";
  if (!canRetry && !retrying && entry.detail?.phase !== "ready" && entry.detail?.phase !== "error") return null;
  return <View testID="assistant-schedule-sync-status" style={styles.candidates} accessibilityLiveRegion="polite">
    {entry.detail?.phase === "ready" && entry.detail.schedule && <AssistantScheduleCard schedule={entry.detail.schedule} showCompleted={showCompleted} />}
    {entry.detail?.phase === "error" && <>
      <ThemedText type="small" themeColor="primaryForeground">변경은 완료됐지만 일정 요약을 불러오지 못했어요.</ThemedText>
      <Pressable accessibilityRole="button" disabled={retrying || !onRetry} onPress={retrying ? undefined : onRetry}
        style={[styles.buttonBase, { backgroundColor: theme.primaryForeground }, (retrying || !onRetry) && styles.disabled]}>
        <ThemedText themeColor="primary">일정 요약 다시 불러오기</ThemedText>
      </Pressable>
    </>}
    {(canRetry || (retrying && entry.phase !== "synchronized")) && <ThemedText type="small" themeColor="primaryForeground">{retrying
      ? "목록을 다시 불러오고 있어요."
      : entry.phase === "interrupted" ? "일정 변경은 완료됐지만 목록 확인이 중단됐어요. 현재 서버에서 GET으로 다시 확인해 주세요."
      : "일정 변경은 완료됐지만 목록 갱신에 실패했어요. 이전 정보가 표시될 수 있어요. GET 조회만 다시 시도해 주세요."}</ThemedText>}
    {canRetry && <Pressable testID="assistant-schedule-sync-retry" accessibilityRole="button" disabled={retrying || !onRetry}
      accessibilityState={{ disabled: retrying || !onRetry }} onPress={retrying ? undefined : onRetry}
      style={[styles.buttonBase, { backgroundColor: theme.primaryForeground }, (retrying || !onRetry) && styles.disabled]}>
      <ThemedText themeColor="primary">목록 다시 불러오기</ThemedText>
    </Pressable>}
  </View>;
}

function RecoveryActions({ value, onAction, balancedManagementSpacing = false, centerButtonText = false }: { value: AssistantRecoveryControl;
  onAction?: (action: AssistantRecoveryControlAction) => void; balancedManagementSpacing?: boolean; centerButtonText?: boolean }) {
  const theme = useTheme();
  const done = value.phase === "removed" || value.phase === "not-found";
  const disabled = !onAction || value.phase === "working";
  const button = (action: AssistantRecoveryControlAction, label: string) => {
    const secondary = action === "manual" || action === "keep";
    const centered = (action === "manual" && centerButtonText) || action === "confirm-manual" || action === "keep";
    return <Pressable key={action} testID={`assistant-recovery-${action}`} accessibilityRole="button" disabled={disabled}
      accessibilityState={{ disabled }} onPress={disabled ? undefined : () => onAction?.(action)}
      style={[secondary ? styles.managementButton : styles.buttonBase,
        secondary && (balancedManagementSpacing || action === "keep") && styles.balancedManagementButton,
        secondary && centered && styles.centeredManagementButton,
        !secondary && { backgroundColor: theme.primaryForeground }, disabled && styles.disabled]}>
      <ThemedText themeColor={secondary ? "primaryForeground" : "primary"}
        style={secondary ? [styles.managementText, centered && styles.centeredButtonText]
          : centered ? styles.centeredButtonText : undefined}>{label}</ThemedText>
    </Pressable>;
  };
  return <View style={styles.candidates} testID={`assistant-recovery-record-${JSON.stringify([value.reference.serverId, value.reference.requestId.toLowerCase()])}`}>
    {value.phase === "confirming" && <>
      {[
        "복구 기록을 삭제할까요?",
        "기록을 삭제해도 서버 작업은 취소되지 않으며, 요청의 성공 여부도 확인되지 않아요.",
        "이후 요청 결과를 자동으로 확인할 수 없어요. 같은 작업을 다시 보내지 말고 일정 목록을 확인해 주세요.",
        "기존에 제한된 요청은 계속 제한돼요.",
      ].map(paragraph => <ThemedText key={paragraph} themeColor="primaryForeground" style={styles.messageText}>{paragraph}</ThemedText>)}
      <RecoveryDetails key={JSON.stringify([value.reference.serverId, value.reference.requestId.toLowerCase()])} reference={value.reference} />
    </>}
    {value.phase && value.phase !== "confirming" && <ThemedText type="small" themeColor="primaryForeground">{{
      working: "로컬 복구 기록을 정리하고 있어요.",
      removed: "복구 기록을 삭제했어요. 기록을 삭제해도 서버 작업은 취소되지 않으며, 요청 결과와 기존 요청 제한은 바뀌지 않아요.",
      "not-found": "이 요청의 로컬 복구 기록은 이미 없어요. 서버 상태는 바뀌지 않아요.",
      retained: "정리 조건이 확인되지 않아 복구 기록을 유지했어요.",
      failed: "복구 기록을 정리하지 못했어요. 저장 상태를 확인해 주세요. 요청을 다시 실행하지 않았어요.",
    }[value.phase]}</ThemedText>}
    {!done && (value.phase === "confirming" ? <View style={styles.recoveryButtons}>
      {button("confirm-manual", "복구 기록 삭제")}{button("keep", "복구 기록 유지")}
    </View> : <>
      {value.resultConfirmable && button("result", "결과 확인 및 복구 기록 정리")}
      {value.expiryConfirmable && button("expiry", "상세 보관 종료 안내 확인 및 기록 정리")}
      {button("manual", "복구 기록 관리")}
    </>)}
  </View>;
}

function RecoveryDetails({ reference }: { reference: AssistantRecoveryControl["reference"] }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.candidates}>
    <Pressable testID="assistant-recovery-details-toggle" accessibilityRole="button"
      accessibilityState={{ expanded }} onPress={() => setExpanded(previous => !previous)}
      style={[styles.managementButton, styles.centeredManagementButton]}>
      <ThemedText themeColor="primaryForeground" style={[styles.managementText, styles.centeredButtonText]}>
        {expanded ? "상세 정보 접기" : "상세 정보"}
      </ThemedText>
    </Pressable>
    {expanded && <View testID="assistant-recovery-details" style={styles.candidates}>
      <ThemedText type="small" themeColor="primaryForeground">서버 주소: {reference.serverId.replace(/^development:/, "")}</ThemedText>
      <ThemedText type="small" themeColor="primaryForeground">요청 ID: {reference.requestId}</ThemedText>
    </View>}
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
            style={[styles.buttonBase, styles.candidate, styles.apiCandidate, { backgroundColor: theme.primaryForeground }, disabled && styles.disabled]}>
            <AssistantScheduleCard schedule={candidate} compact />
            {candidate.candidateId === selectedCandidateId && <CandidateCheck />}
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
          <View style={styles.confirmationChanges}>
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
      if (result.outcome === "cancelled") return null;
      const operation = result.operation === undefined ? undefined : {
        create: "등록", list: "조회", update: "수정", delete: "삭제",
      }[result.operation];
      const label = result.outcome === "success" ? "완료" : "대상 없음";
      return (
        <>
          {result.outcome !== "success" &&
            <ThemedText type="small" themeColor="primaryForeground">{operation === undefined ? label : `${operation} ${label}`}</ThemedText>}
          {result.outcome === "success" && result.operation === "list" && result.items.map(item => (
            <AssistantScheduleCard key={item.id} schedule={item} showCompleted />
          ))}
        </>
      );
    }
    case "failure": {
      const hasReason = /실패|못했|못해|오류|문제|없|잘못|지원|만료|초과/.test(result.text);
      const actionPattern = result.nextAction === "revise_input"
        ? /(입력|내용|표현|날짜|조건|요청)[^.!?\n]{0,48}(수정|바꿔|바꾸|고쳐|구체|명확)[^.!?\n]{0,32}(주세요|보세요|하세요)|다른 표현[^.!?\n]{0,32}(주세요|보세요|하세요)|내용을\s*확인해\s*다시\s*말씀해\s*주세요/
        : result.nextAction === "retry_later"
          ? /(나중|잠시 후|잠시 뒤|잠깐 후|잠깐 뒤)[^.!?\n]{0,40}(다시|재시도)[^.!?\n]{0,24}(주세요|보세요|하세요)/
          : /(결과|상태|일정 목록)[^.!?\n]{0,24}확인[^.!?\n]{0,24}(주세요|보세요|하세요)/;
      const action = result.text.match(actionPattern)?.[0];
      const hasAction = action !== undefined && !/하지 마|하지 않|말아|말고/.test(action);
      if (hasReason && hasAction) return null;
      return <>
        <ThemedText type="small" themeColor="primaryForeground">처리 실패</ThemedText>
        <ThemedText type="small" themeColor="primaryForeground">{assistantFailureAdvice(result.nextAction)}</ThemedText>
      </>;
    }
    case "uncertain": return <ThemedText type="small" themeColor="primaryForeground">결과 미확인</ThemedText>;
  }
}

function ConfirmationActions({ disabled, onConfirm, selectedApproved }: {
  disabled: boolean; onConfirm?: (confirmed: boolean) => void; selectedApproved?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.confirmationActions}>
      {([false, true] as const).map(confirmed => (
        <Pressable key={String(confirmed)} accessibilityRole="button"
          accessibilityState={{ disabled, ...(selectedApproved !== undefined ? { selected: selectedApproved === confirmed } : {}) }} disabled={disabled}
          onPress={disabled ? undefined : () => onConfirm?.(confirmed)}
          style={[styles.buttonBase, styles.action, styles.confirmationButton, { backgroundColor: confirmed ? theme.primaryForeground : "#FC8957" }, disabled && styles.disabled]}>
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
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const disabled = processing || interaction.resolved || !onSelect;
  return (
    <View style={styles.candidates}>
      {interaction.candidates.map((candidate) => (
        <Pressable
          key={candidate.scheduleId}
          accessibilityRole="button"
          accessibilityState={{ disabled, selected: candidate.scheduleId === selectedScheduleId }}
          disabled={disabled}
          onPress={() => { setSelectedScheduleId(candidate.scheduleId); onSelect?.(candidate.scheduleId); }}
          style={[
            styles.buttonBase,
            styles.candidate,
            styles.mockCandidate,
            { backgroundColor: theme.primaryForeground },
            disabled && styles.disabled,
          ]}
        >
          <ThemedText themeColor="primary">
            {candidate.label}
          </ThemedText>
          {candidate.scheduleId === selectedScheduleId && <CandidateCheck />}
        </Pressable>
      ))}
    </View>
  );
}

function CandidateCheck() {
  const theme = useTheme();
  return <View testID="assistant-candidate-check" pointerEvents="none" accessible={false}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.candidateCheck}>
    <SymbolView name={{ ios: "checkmark", android: "check" }} size={20} tintColor={theme.primary}
      fallback={<Text style={{ color: theme.primary }}>✓</Text>} />
  </View>;
}

const styles = StyleSheet.create({
  centeredButtonText: { textAlign: "center" },
  centeredManagementButton: { alignSelf: "center" },
  managementText: { textDecorationLine: "underline", lineHeight: Spacing.four },
  // Base touch area: 8 + 24 + 12 = 44dp. Recovery notices add the bubble's 8dp gap above.
  // Connection notices use 16dp top padding after the primary button; both notices leave 16dp below.
  managementButton: {
    minHeight: 44,
    alignSelf: "flex-start",
    maxWidth: "100%",
    justifyContent: "flex-start",
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three - Spacing.one,
  },
  balancedManagementButton: { paddingTop: Spacing.three },
  recoveryButtons: { alignSelf: "stretch" },
  connectionNoticeBubble: { width: "70%", maxWidth: "70%" },
  compactRecoveryBubble: { paddingBottom: Spacing.one },
  messageText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 500,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
  candidates: {
    alignSelf: "stretch",
    gap: Spacing.two,
  },
  candidate: {
    paddingVertical: Spacing.two,
    position: "relative",
  },
  apiCandidate: { paddingHorizontal: 0, paddingVertical: 0 },
  mockCandidate: { paddingHorizontal: 12, paddingRight: 36 },
  candidateCheck: { position: "absolute", top: 10, right: 12, width: 20, height: 20 },
  confirmationChanges: { alignSelf: "stretch", gap: 12 },
  confirmationActions: { alignSelf: "stretch", flexDirection: "row", gap: 12 },
  confirmationButton: { height: 44, minHeight: 44, flexBasis: 0 },
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
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    justifyContent: "center",
    gap: Spacing.two,
  },
  confirmationBubble: { width: "90%", maxWidth: "90%", gap: 12 },
});
