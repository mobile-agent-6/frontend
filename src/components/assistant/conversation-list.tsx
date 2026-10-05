import { useEffect, useRef } from "react";
import { FlatList, StyleSheet, View } from "react-native";

import { AssistantMessage } from "@/components/assistant/assistant-message";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";
import type { AssistantDeleteConfirmation } from "@/types/assistant";
import type { Schedule } from "@/types/schedule";

// 화면 표시용 메시지 데이터이며, 향후 Assistant API 계약과는 별개다.
export type ConversationMessage = {
  id: string;
  text: string;
} & (
  | { role: "user" }
  | {
      role: "assistant";
      schedules?: readonly Schedule[];
      interaction?: AssistantDeleteConfirmation;
    }
);

type ConversationListProps = {
  messages: readonly ConversationMessage[];
  isProcessing?: boolean;
  onDeleteConfirmation?: (messageId: string, confirmed: boolean) => void;
};

export function ConversationList({
  messages,
  isProcessing = false,
  onDeleteConfirmation,
}: ConversationListProps) {
  const listRef = useRef<FlatList<ConversationMessage>>(null);
  const messageCount = messages.length;
  const previousMessageCountRef = useRef(messageCount);

  useEffect(() => {
    const hasNewMessage = messageCount > previousMessageCountRef.current;
    previousMessageCountRef.current = messageCount;
    if (!hasNewMessage) return;

    // 메시지와 processing 영역이 렌더링된 다음 하단으로 이동한다.
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [messageCount]);

  return (
    <FlatList
      ref={listRef}
      data={messages}
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
            schedules={item.schedules}
            interaction={item.interaction}
            onDeleteConfirmation={
              onDeleteConfirmation
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
  return (
    <ThemedView type="backgroundElement" style={styles.userBubble}>
      <ThemedText>{text}</ThemedText>
    </ThemedView>
  );
}

function MessageSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
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
