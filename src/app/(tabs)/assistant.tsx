import * as Crypto from "expo-crypto";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";

import {
  ConversationList,
  type ConversationMessage,
} from "@/components/assistant/conversation-list";
import { MessageInput } from "@/components/assistant/message-input";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";

export default function AssistantScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [inputText, setInputText] = useState("");

  const handleSend = () => {
    const text = inputText.trim();
    if (!text) return;

    const message: ConversationMessage = {
      id: Crypto.randomUUID(),
      role: "user",
      text,
    };
    setMessages((current) => [...current, message]);
    setInputText("");
  };

  return (
    <ThemedView
      style={[
        styles.screen,
        {
          backgroundColor:
            colorScheme === "dark" ? theme.background : "#FCF9F7",
        },
      ]}
    >
      <Header title="일정 비서" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.content}
      >
        <ConversationList messages={messages} />
        <MessageInput
          value={inputText}
          onChangeText={setInputText}
          onSend={handleSend}
        />
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
