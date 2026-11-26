import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type Ref } from "react";
import { AppState, Dimensions, FlatList, Keyboard, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";

import { AssistantMessage } from "@/components/assistant/assistant-message";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantLifecycleSnapshot } from "@/services/api/assistant-lifecycle";
import type { AssistantInteraction } from "@/types/assistant";
import type { Schedule } from "@/types/schedule";
import { assistantResultToDisplay } from "@/utils/assistant-mapper";
import { canRecheckAssistantMessage } from "@/utils/assistant-recovery-messages";
import type { AssistantCandidateQuestion, AssistantConfirmationQuestion } from "@/utils/assistant-text-question";
import { assistantErrorRecoveryNotice, assistantHttpErrorNotice, getAssistantExecutionError, type AssistantErrorRecoveryNotice } from "@/utils/assistant-errors";
import type { AssistantUncertainView } from "@/utils/assistant-uncertain";
import type { AssistantScheduleSyncEntry } from "@/services/api/assistant-schedule-sync";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import { assistantRecoveryKey, type AssistantRecoveryControl, type AssistantRecoveryControlAction } from "@/utils/assistant-recovery-cleanup";
import { createAssistantResultVisibility, isAssistantResultFullyVisible, type AssistantDisplayedResult, type AssistantVisibleResult } from "@/utils/assistant-result-visibility";

// 화면 메시지와 공개 API 결과를 구분하며 API 원형은 현재 실행 세션에만 보관한다.
export type ConversationMessage = {
  id: string;
  text: string;
  // undefined는 Mock, null은 서버 설정 확인 전의 서버 메시지를 뜻한다.
  serverId?: string | null;
} & (
  | { role: "user" }
  | {
      role: "assistant";
      schedules?: readonly Schedule[];
      interaction?: AssistantInteraction;
      apiExecution?: AssistantExecutionResult;
      apiSource?: "request" | "recovery";
      apiErrorRecovery?: AssistantErrorRecoveryNotice;
      apiUncertain?: Extract<AssistantExecutionResult, { kind: "completed" }>;
      recoveryIssue?: Pick<AssistantLifecycleSnapshot, "serverId" | "phase" | "initialCheck" | "initialization" | "issue">;
    }
);

export type ConversationListHandle = {
  prepareForKeyboard: () => void;
};

// 하단에서 이 거리 안에 있으면 최신 메시지를 보고 있는 것으로 간주한다.
const NEAR_BOTTOM_THRESHOLD = 64;

type ConversationListProps = {
  ref?: Ref<ConversationListHandle>;
  messages: readonly ConversationMessage[];
  isProcessing?: boolean;
  // 진행 요청 식별·복구 footer는 isProcessing을 유지하고 안내 문구만 별도로 제어한다.
  showProcessingNotice?: boolean;
  interactionsDisabled?: boolean;
  onDeleteConfirmation?: (messageId: string, confirmed: boolean) => void;
  onCandidateSelection?: (messageId: string, scheduleId: string) => void;
  activeApiCandidate?: AssistantCandidateQuestion;
  apiCandidateSelections?: Readonly<Record<string, string>>;
  onApiCandidateSelection?: (messageId: string, candidateId: string) => void;
  activeApiConfirmation?: AssistantConfirmationQuestion;
  apiConfirmations?: Readonly<Record<string, boolean>>;
  expiredApiConfirmations?: readonly string[];
  onApiConfirmation?: (messageId: string, approved: boolean) => void;
  uncertainViews?: readonly AssistantUncertainView[];
  onUncertainCheck?: (requestId: string) => void;
  onUncertainAcknowledge?: (requestId: string) => void;
  onResultRecheck?: (reference: AssistantRecoveryReference) => void;
  recheckingRequest?: string | null;
  resultRecheckDisabled?: boolean;
  recoveryControls?: readonly AssistantRecoveryControl[];
  recoveryStorageError?: boolean;
  onRecoveryAction?: (control: AssistantRecoveryControl, action: AssistantRecoveryControlAction) => void;
  scheduleSyncEntries?: readonly AssistantScheduleSyncEntry[];
  retryingScheduleSync?: readonly string[];
  onScheduleSyncRetry?: (reference: AssistantRecoveryReference) => void;
  onResultDisplayed?: (result: AssistantDisplayedResult) => Promise<boolean>;
};

export function ConversationList({
  ref,
  messages,
  isProcessing = false,
  showProcessingNotice = true,
  interactionsDisabled = false,
  onDeleteConfirmation,
  onCandidateSelection,
  activeApiCandidate,
  apiCandidateSelections,
  onApiCandidateSelection,
  activeApiConfirmation,
  apiConfirmations,
  expiredApiConfirmations,
  onApiConfirmation,
  uncertainViews,
  onUncertainCheck,
  onUncertainAcknowledge,
  onResultRecheck,
  recheckingRequest,
  resultRecheckDisabled = false,
  recoveryControls,
  recoveryStorageError,
  onRecoveryAction,
  scheduleSyncEntries,
  retryingScheduleSync,
  onScheduleSyncRetry,
  onResultDisplayed,
}: ConversationListProps) {
  const listRef = useRef<FlatList<ConversationMessage>>(null);
  const renderedMessages = messages.filter(message => !(isProcessing && message.role === "assistant" &&
    message.apiExecution?.kind === "observed" && !message.apiUncertain && !message.apiErrorRecovery &&
    recheckingRequest !== assistantRecoveryKey(message.apiExecution.reference)));
  const messageCount = renderedMessages.length;
  const processingMessage = isProcessing ? [...messages].reverse().find(message => message.role === "user") : undefined;
  const previousMessageCountRef = useRef(messageCount);
  const scrollMetricsRef = useRef({ contentHeight: 0, viewportHeight: 0, offsetY: 0 });
  const isNearBottomRef = useRef(true);
  const bottomBeforeKeyboardRef = useRef<boolean | null>(null);
  const keyboardVisibleRef = useRef(Keyboard.isVisible());
  const scrollFrameRef = useRef<number | null>(null);
  const followNewMessagesRef = useRef(false);
  const focusedRef = useRef(false), mountedRef = useRef(true);
  const textRefs = useRef(new Map<string, { token: string; node: ComponentRef<typeof Text> }>());
  const displayedCallback = useRef(onResultDisplayed);
  const visibilityRef = useRef<ReturnType<typeof createAssistantResultVisibility> | null>(null);
  const [pendingDisplay, setPendingDisplay] = useState<ReadonlyMap<string, string>>(new Map());
  const visibleResults = useMemo(() => {
    const results = new Map<string, AssistantVisibleResult>();
    for (const message of messages) if (message.role === "assistant" && message.apiExecution?.kind === "completed" &&
      ["outcome", "failure"].includes(message.apiExecution.response.data.result.kind)) results.set(message.id, {
        messageId: message.id, reference: message.apiExecution.reference, executionToken: JSON.stringify(message.apiExecution),
        contentToken: JSON.stringify([message.text, message.apiExecution.response.data]),
      });
    return results;
  }, [messages]);
  useLayoutEffect(() => {
    displayedCallback.current = onResultDisplayed;
  }, [onResultDisplayed]);
  useLayoutEffect(() => {
    if (visibilityRef.current === null) visibilityRef.current = createAssistantResultVisibility({
    isActive: () => mountedRef.current && focusedRef.current && AppState.currentState === "active",
    onPending: (result, pending) => {
      if (!mountedRef.current) return;
      setPendingDisplay(previous => {
        if (pending ? previous.get(result.messageId) === result.executionToken : previous.get(result.messageId) !== result.executionToken) return previous;
        const next = new Map(previous);
        if (pending) next.set(result.messageId, result.executionToken); else next.delete(result.messageId);
        return next;
      });
    },
    onDisplayed: result => displayedCallback.current?.({ ...result,
      isCurrent: () => result.isCurrent() && textRefs.current.get(result.messageId)?.token === result.executionToken,
    }) ?? Promise.resolve(false),
    measure: result => new Promise(resolve => {
      const viewport = listRef.current?.getNativeScrollRef();
      const text = textRefs.current.get(result.messageId);
      if (!viewport || !("measureInWindow" in viewport) || typeof viewport.measureInWindow !== "function" ||
        !text || text.token !== result.executionToken || typeof text.node.measureInWindow !== "function") { resolve(false); return; }
      viewport.measureInWindow((x: number, y: number, width: number, height: number) => {
        try {
          text.node.measureInWindow((tx, ty, tw, th) => {
            try { resolve(textRefs.current.get(result.messageId) === text && isAssistantResultFullyVisible(
              { x: tx, y: ty, width: tw, height: th }, { x, y, width, height }, Dimensions.get("window"))); }
            catch { resolve(false); }
          });
        } catch { resolve(false); }
      });
    }),
    });
    // 커밋된 후보만 갱신한다. 정리는 별도의 native 레이아웃·측정 증거를 기다린다.
    visibilityRef.current.update([...visibleResults.values()]);
    visibilityRef.current.refresh();
  }, [visibleResults]);
  useFocusEffect(useCallback(() => {
    const visibility = visibilityRef.current;
    focusedRef.current = true; visibility?.refresh();
    return () => { focusedRef.current = false; visibility?.invalidate(); };
  }, []));
  useEffect(() => {
    const visibility = visibilityRef.current;
    mountedRef.current = true;
    const subscription = AppState.addEventListener("change", () => visibility?.refresh());
    visibility?.refresh();
    return () => { mountedRef.current = false; visibility?.invalidate(); subscription.remove(); };
  }, []);

  const scheduleScrollToEnd = useCallback((animated: boolean) => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      // 마지막 셀의 추정 높이 대신 네이티브의 실제 콘텐츠 끝으로 이동한다.
      const scrollView = listRef.current?.getNativeScrollRef();
      if (
        scrollView &&
        "scrollToEnd" in scrollView &&
        typeof scrollView.scrollToEnd === "function"
      ) {
        scrollView.scrollToEnd({ animated });
      }
    });
  }, []);

  const updateNearBottom = useCallback(() => {
    const { contentHeight, viewportHeight, offsetY } = scrollMetricsRef.current;
    isNearBottomRef.current =
      contentHeight - viewportHeight - offsetY <= NEAR_BOTTOM_THRESHOLD;
  }, []);

  useImperativeHandle(ref, () => ({
    // 입력창 포커스에서는 위치만 기록하고 스크롤하지 않는다.
    prepareForKeyboard: () => {
      if (!Keyboard.isVisible()) {
        bottomBeforeKeyboardRef.current = isNearBottomRef.current;
        followNewMessagesRef.current = false;
      }
    },
  }), []);

  const followKeyboardOpening = useCallback(() => {
    if (keyboardVisibleRef.current && bottomBeforeKeyboardRef.current === true) {
      scheduleScrollToEnd(false);
    }
  }, [scheduleScrollToEnd]);

  useEffect(() => {
    const willShow = Keyboard.addListener("keyboardWillShow", () => {
      bottomBeforeKeyboardRef.current ??= isNearBottomRef.current;
      followNewMessagesRef.current = false;
    });
    const didShow = Keyboard.addListener("keyboardDidShow", () => {
      keyboardVisibleRef.current = true;
      bottomBeforeKeyboardRef.current ??= isNearBottomRef.current;
      if (bottomBeforeKeyboardRef.current) followKeyboardOpening();
    });
    const didHide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardVisibleRef.current = false;
      bottomBeforeKeyboardRef.current = null;
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    });
    return () => {
      willShow.remove();
      didShow.remove();
      didHide.remove();
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [followKeyboardOpening]);

  useEffect(() => {
    const hasNewMessage = messageCount > previousMessageCountRef.current;
    previousMessageCountRef.current = messageCount;
    if (!hasNewMessage) return;

    // 새 메시지 이후에는 콘텐츠 측정이 끝날 때까지 하단을 따라간다.
    followNewMessagesRef.current = true;
    bottomBeforeKeyboardRef.current = false;
    scheduleScrollToEnd(true);
  }, [messageCount, scheduleScrollToEnd]);

  const footerControls = recoveryControls?.filter(control => !(processingMessage && processingMessage.serverId === control.reference.serverId &&
            processingMessage.id.toLowerCase() === control.reference.requestId.toLowerCase()) &&
            !messages.some(message => message.role === "assistant" && message.apiExecution &&
            assistantRecoveryKey(message.apiExecution.reference) === assistantRecoveryKey(control.reference))) ?? [];
  const showProgress = isProcessing && showProcessingNotice;
  const hasFooterContent = showProgress || footerControls.length > 0 || recoveryStorageError;
  const recoveryControlFor = (item: ConversationMessage) => {
    if (item.role !== "assistant" || !item.apiExecution) return;
    const control = recoveryControls?.find(value => assistantRecoveryKey(value.reference) === assistantRecoveryKey(item.apiExecution!.reference));
    // Suppress only an actually measured automatic attempt. Explicit/manual/error states remain available.
    return control?.phase === undefined && pendingDisplay.get(item.id) === JSON.stringify(item.apiExecution) ? undefined : control;
  };
  return (
    <FlatList
      ref={listRef}
      data={renderedMessages}
      onScroll={({ nativeEvent }) => {
        scrollMetricsRef.current = {
          contentHeight: nativeEvent.contentSize.height,
          viewportHeight: nativeEvent.layoutMeasurement.height,
          offsetY: nativeEvent.contentOffset.y,
        };
        updateNearBottom();
        visibilityRef.current?.refresh();
      }}
      scrollEventThrottle={16}
      onContentSizeChange={(_, height) => {
        visibilityRef.current?.refresh();
        scrollMetricsRef.current.contentHeight = height;
        updateNearBottom();
        if (followNewMessagesRef.current) scheduleScrollToEnd(false);
      }}
      onLayout={({ nativeEvent }) => {
        visibilityRef.current?.refresh();
        const height = nativeEvent.layout.height;
        const shrank = height < scrollMetricsRef.current.viewportHeight;
        // 키보드 표시 이벤트보다 레이아웃 변경이 먼저 오는 경우도 위치를 보존한다.
        if (shrank && !keyboardVisibleRef.current) {
          bottomBeforeKeyboardRef.current ??= isNearBottomRef.current;
        }
        scrollMetricsRef.current.viewportHeight = height;
        updateNearBottom();
        if (shrank && keyboardVisibleRef.current && bottomBeforeKeyboardRef.current) {
          followKeyboardOpening();
        }
      }}
      onScrollBeginDrag={() => {
        visibilityRef.current?.invalidate();
        followNewMessagesRef.current = false;
        if (scrollFrameRef.current !== null) {
          cancelAnimationFrame(scrollFrameRef.current);
          scrollFrameRef.current = null;
        }
        // 사용자가 직접 이동하면 키보드 후속 레이아웃이 위치를 되돌리지 않는다.
        if (bottomBeforeKeyboardRef.current !== null) {
          bottomBeforeKeyboardRef.current = false;
        }
      }}
      style={styles.list}
      contentContainerStyle={styles.content}
      keyExtractor={(message) => message.id}
      ItemSeparatorComponent={MessageSeparator}
      ListFooterComponent={
        <View>
          {messageCount > 0 && hasFooterContent && <MessageSeparator />}
          {showProgress && (
            <View style={styles.processing} accessibilityLiveRegion="polite">
              <ThemedText themeColor="textSecondary">
                일정을 확인하고 있어요...
              </ThemedText>
            </View>
          )}
          {/* 현재 전송을 처리 중인 기록은 고아 복구 항목이 아니다. 실패 결과와 이전 서버 기록은 별도로 유지한다. */}
          {footerControls.map((control, index) => (
            <View key={assistantRecoveryKey(control.reference)}>
              {(index > 0 || showProgress) && <MessageSeparator />}
              <AssistantMessage text="결과를 확인하지 못한 이전 요청이 있어요."
              recoveryIssue recoveryNotice
              recoveryControl={control} onRecoveryAction={onRecoveryAction ? action => onRecoveryAction(control, action) : undefined} />
            </View>
          ))}
          {recoveryStorageError && (showProgress || footerControls.length > 0) && <MessageSeparator />}
          {recoveryStorageError && <AssistantMessage text="로컬 복구 기록을 읽지 못했어요. 기록을 삭제하지 않았으며 저장 상태 확인이 필요해요." />}
          <View style={styles.footer} />
        </View>
      }
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) =>
        item.role === "user" ? (
          <UserMessage text={item.text} />
        ) : (
          <AssistantMessage
            resultTextKey={visibleResults.get(item.id)?.contentToken}
            resultTextRef={visibleResults.has(item.id) ? node => {
              const result = visibleResults.get(item.id)!;
              if (node) textRefs.current.set(item.id, { token: result.executionToken, node });
              else if (textRefs.current.get(item.id)?.token === result.executionToken) textRefs.current.delete(item.id);
            } : undefined}
            onResultTextLayout={visibleResults.has(item.id) ? () => visibilityRef.current?.laidOut(visibleResults.get(item.id)!) : undefined}
            text={item.text}
            onResultRecheck={item.apiExecution && canRecheckAssistantMessage(item) &&
              !uncertainViews?.some(view => view.requestId.toLowerCase() === item.apiExecution!.reference.requestId.toLowerCase()) &&
              onResultRecheck ? () => onResultRecheck(item.apiExecution!.reference) : undefined}
            resultRechecking={Boolean(item.apiExecution && recheckingRequest === assistantRecoveryKey(item.apiExecution.reference))}
            resultRecheckDisabled={resultRecheckDisabled || interactionsDisabled || isProcessing}
            scheduleSyncEntry={scheduleSyncForMessage(item, scheduleSyncEntries)}
            scheduleSyncRetrying={Boolean(item.apiExecution && retryingScheduleSync?.includes(assistantRecoveryKey(item.apiExecution.reference)))}
            onScheduleSyncRetry={item.apiExecution && onScheduleSyncRetry ? () => onScheduleSyncRetry(item.apiExecution!.reference) : undefined}
            recoveryControl={recoveryControlFor(item)}
            recoveryIssue={item.apiExecution?.kind === "needs-attention"}
            onRecoveryAction={item.apiExecution && onRecoveryAction ? action => {
              const control = recoveryControls?.find(control => assistantRecoveryKey(control.reference) === assistantRecoveryKey(item.apiExecution!.reference));
              if (control) onRecoveryAction(control, action);
            } : undefined}
            apiRecoveryText={item.apiErrorRecovery ? assistantErrorRecoveryNotice(item.apiErrorRecovery) : undefined}
            uncertainView={item.apiExecution ? uncertainViews?.find(view => view.requestId.toLowerCase() === item.apiExecution?.reference.requestId.toLowerCase()) : undefined}
            uncertainErrorText={item.apiUncertain && item.apiExecution && getAssistantExecutionError(item.apiExecution)
              ? assistantHttpErrorNotice(getAssistantExecutionError(item.apiExecution)!) : undefined}
            uncertainActionsDisabled={interactionsDisabled}
            onUncertainCheck={item.apiExecution && onUncertainCheck ? () => onUncertainCheck(item.apiExecution!.reference.requestId) : undefined}
            onUncertainAcknowledge={item.apiExecution && onUncertainAcknowledge ? () => onUncertainAcknowledge(item.apiExecution!.reference.requestId) : undefined}
            apiResult={item.apiExecution?.kind === "completed"
              ? assistantResultToDisplay(item.apiExecution.response.data.result) : undefined}
            schedules={item.apiExecution ? undefined : item.schedules}
            interaction={item.apiExecution ? undefined : item.interaction}
            interactionsDisabled={Boolean(item.apiExecution) || interactionsDisabled}
            selectedApiCandidateId={item.apiExecution ? apiCandidateSelections?.[item.apiExecution.reference.requestId.toLowerCase()] : undefined}
            selectedApiApproval={item.apiExecution ? apiConfirmations?.[item.apiExecution.reference.requestId.toLowerCase()] : undefined}
            apiConfirmationExpired={item.apiExecution ? expiredApiConfirmations?.includes(item.apiExecution.reference.requestId.toLowerCase()) : undefined}
            onApiConfirmation={
              !interactionsDisabled && activeApiConfirmation && onApiConfirmation && item.apiExecution?.kind === "completed" &&
              item.apiExecution.reference.serverId === activeApiConfirmation.serverId &&
              item.apiExecution.reference.requestId.toLowerCase() === activeApiConfirmation.requestId.toLowerCase() &&
              item.apiExecution.response.data.result.kind === "confirmation" &&
              item.apiExecution.response.data.result.questionId.toLowerCase() === activeApiConfirmation.questionId.toLowerCase()
                ? approved => onApiConfirmation(item.id, approved) : undefined
            }
            onApiCandidateSelection={
              !interactionsDisabled && activeApiCandidate && onApiCandidateSelection && item.apiExecution?.kind === "completed" &&
              item.apiExecution.reference.serverId === activeApiCandidate.serverId &&
              item.apiExecution.reference.requestId.toLowerCase() === activeApiCandidate.requestId.toLowerCase() &&
              item.apiExecution.response.data.result.kind === "candidate_selection" &&
              item.apiExecution.response.data.result.questionId.toLowerCase() === activeApiCandidate.questionId.toLowerCase()
                ? candidateId => onApiCandidateSelection(item.id, candidateId) : undefined
            }
            onCandidateSelection={
              !item.apiExecution && onCandidateSelection
                ? (scheduleId) => onCandidateSelection(item.id, scheduleId)
                : undefined
            }
            onDeleteConfirmation={
              !item.apiExecution && onDeleteConfirmation
                ? (confirmed) => onDeleteConfirmation(item.id, confirmed)
                : undefined
            }
          />
        )
      }
    />
  );
}

function scheduleSyncForMessage(message: ConversationMessage, entries?: readonly AssistantScheduleSyncEntry[]) {
  const execution = message.role === "assistant" ? message.apiExecution : undefined;
  if (execution?.kind !== "completed") return;
  const result = execution.response.data.result;
  if (result.kind !== "outcome" || result.outcome !== "success" || result.operation === "list" || !result.schedulesChanged) return;
  return entries?.find(entry => assistantRecoveryKey(entry.reference) === assistantRecoveryKey(execution.reference));
}

function UserMessage({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <ThemedView type="backgroundElement" style={styles.userBubble}>
      <Text
        selectable
        style={[styles.messageText, { color: theme.text }]}
      >
        {text}
      </Text>
    </ThemedView>
  );
}

function MessageSeparator() {
  return <View style={styles.separator} />;
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
  list: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    borderRadius: 20,
    borderBottomRightRadius: 4,
    padding: Spacing.three,
  },
  separator: {
    height: Spacing.three,
  },
  footer: {
    height: Spacing.five,
  },
  processing: {
    alignSelf: "flex-start",
  },
});
