import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
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
import {
  getMockAssistantSchedules,
  getMockAssistantText,
} from "@/services/mock/assistant";
import type { AssistantStatus } from "@/types/assistant";

// processing UI를 보여주기 위한 Mock 지연이며, 실제 API timeout이 아니다.
const MOCK_PROCESSING_DELAY_MS = 700;

export default function AssistantScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const sendLockedRef = useRef(false);

  useEffect(() => {
    if (status !== "processing") return;

    const timer = setTimeout(() => {
      const response: ConversationMessage = {
        id: Crypto.randomUUID(),
        role: "assistant",
        text: getMockAssistantText(),
        schedules: getMockAssistantSchedules(),
      };
      setMessages((current) => [...current, response]);
      setStatus("idle");
      sendLockedRef.current = false;
    }, MOCK_PROCESSING_DELAY_MS);

    return () => clearTimeout(timer);
  }, [status]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || sendLockedRef.current) return;
    sendLockedRef.current = true;

    const message: ConversationMessage = {
      id: Crypto.randomUUID(),
      role: "user",
      text,
    };
    setMessages((current) => [...current, message]);
    setInputText("");
    setStatus("processing");
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
        <ConversationList
          messages={messages}
          isProcessing={status === "processing"}
        />
        <MessageInput
          value={inputText}
          onChangeText={setInputText}
          onSend={handleSend}
          disabled={status === "processing"}
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
