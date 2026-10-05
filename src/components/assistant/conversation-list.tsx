import { useRef } from "react";
import { FlatList, StyleSheet, View } from "react-native";

import { AssistantMessage } from "@/components/assistant/assistant-message";
import { ThemedText } from "@/components/ui/themed-text";
import { ThemedView } from "@/components/ui/themed-view";
import { Spacing } from "@/constants/theme";

// 화면 표시용 메시지 데이터이며, 향후 Assistant API 계약과는 별개다.
export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type ConversationListProps = {
  messages: readonly ConversationMessage[];
};

export function ConversationList({ messages }: ConversationListProps) {
  const listRef = useRef<FlatList<ConversationMessage>>(null);

  const scrollToLatest = (animated: boolean) => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated });
    }
  };

  return (
    <FlatList
      ref={listRef}
      data={messages}
      style={styles.list}
      contentContainerStyle={styles.content}
      keyExtractor={(message) => message.id}
      ItemSeparatorComponent={MessageSeparator}
      ListFooterComponent={<View style={styles.footer} />}
      onContentSizeChange={() => scrollToLatest(true)}
      onLayout={() => scrollToLatest(false)}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) =>
        item.role === "user" ? (
          <UserMessage text={item.text} />
        ) : (
          <AssistantMessage text={item.text} />
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
});
