import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { FlatList, Keyboard, StyleSheet, Text, View } from "react-native";

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
import type { AssistantCandidateQuestion } from "@/utils/assistant-text-question";

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
  interactionsDisabled?: boolean;
  onDeleteConfirmation?: (messageId: string, confirmed: boolean) => void;
  onCandidateSelection?: (messageId: string, scheduleId: string) => void;
  activeApiCandidate?: AssistantCandidateQuestion;
  apiCandidateSelections?: Readonly<Record<string, string>>;
  onApiCandidateSelection?: (messageId: string, candidateId: string) => void;
};

export function ConversationList({
  ref,
  messages,
  isProcessing = false,
  interactionsDisabled = false,
  onDeleteConfirmation,
  onCandidateSelection,
  activeApiCandidate,
  apiCandidateSelections,
  onApiCandidateSelection,
}: ConversationListProps) {
  const listRef = useRef<FlatList<ConversationMessage>>(null);
  const messageCount = messages.length;
  const previousMessageCountRef = useRef(messageCount);
  const scrollMetricsRef = useRef({ contentHeight: 0, viewportHeight: 0, offsetY: 0 });
  const isNearBottomRef = useRef(true);
  const bottomBeforeKeyboardRef = useRef<boolean | null>(null);
  const keyboardVisibleRef = useRef(Keyboard.isVisible());
  const scrollFrameRef = useRef<number | null>(null);
  const followNewMessagesRef = useRef(false);

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

  return (
    <FlatList
      ref={listRef}
      data={messages}
      onScroll={({ nativeEvent }) => {
        scrollMetricsRef.current = {
          contentHeight: nativeEvent.contentSize.height,
          viewportHeight: nativeEvent.layoutMeasurement.height,
          offsetY: nativeEvent.contentOffset.y,
        };
        updateNearBottom();
      }}
      scrollEventThrottle={16}
      onContentSizeChange={(_, height) => {
        scrollMetricsRef.current.contentHeight = height;
        updateNearBottom();
        if (followNewMessagesRef.current) scheduleScrollToEnd(false);
      }}
      onLayout={({ nativeEvent }) => {
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
          {isProcessing && (
            <View style={styles.processing} accessibilityLiveRegion="polite">
              <ThemedText themeColor="textSecondary">
                일정을 확인하고 있어요...
              </ThemedText>
            </View>
          )}
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
            text={item.text}
            apiResult={item.apiExecution?.kind === "completed"
              ? assistantResultToDisplay(item.apiExecution.response.data.result) : undefined}
            schedules={item.apiExecution ? undefined : item.schedules}
            interaction={item.apiExecution ? undefined : item.interaction}
            interactionsDisabled={Boolean(item.apiExecution) || interactionsDisabled}
            selectedApiCandidateId={item.apiExecution ? apiCandidateSelections?.[item.apiExecution.reference.requestId.toLowerCase()] : undefined}
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
    marginTop: Spacing.three,
    alignSelf: "flex-start",
  },
});
