import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";

import {
  ConversationList,
  type ConversationMessage,
  type ConversationListHandle,
} from "@/components/assistant/conversation-list";
import { MessageInput } from "@/components/assistant/message-input";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import {
  resolveMockDeleteConfirmation,
  createMockDeleteConfirmation,
  runMockAssistantScenario,
  type MockAssistantPending,
} from "@/services/mock/assistant";
import type { AssistantInteraction, AssistantStatus } from "@/types/assistant";
import { useScheduleStore } from "@/stores/scheduleStore";

// processing UI를 보여주기 위한 Mock 지연이며, 실제 API timeout이 아니다.
const MOCK_PROCESSING_DELAY_MS = 700;

function resolveInteraction(message: ConversationMessage, id: string) {
  return message.id === id && message.role === "assistant" && message.interaction
    ? { ...message, interaction: { ...message.interaction, resolved: true } }
    : message;
}

export default function AssistantScreen() {
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [isBusy, setIsBusy] = useState(false);
  const sendLockedRef = useRef(false);
  const inputTextRef = useRef("");
  const operationVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const errorIdRef = useRef(0);
  const pendingInputRef = useRef("");
  const pendingMockRef = useRef<MockAssistantPending>(null);
  const activeInteractionIdRef = useRef<string | null>(null);
  const resolvedInteractionIdsRef = useRef(new Set<string>());
  const conversationListRef = useRef<ConversationListHandle>(null);

  const invalidateActiveInteraction = useCallback(() => {
    const id = activeInteractionIdRef.current;
    if (id === null) return;
    resolvedInteractionIdsRef.current.add(id);
    activeInteractionIdRef.current = null;
    setMessages((current) => current.map((message) => resolveInteraction(message, id)));
  }, []);

  const publishResponse = useCallback((response: ConversationMessage, replaceInteraction: boolean) => {
    if (replaceInteraction) {
      invalidateActiveInteraction();
      activeInteractionIdRef.current = response.role === "assistant" && response.interaction
        ? response.id
        : null;
    }
    setMessages((current) => [...current, response]);
  }, [invalidateActiveInteraction]);

  const reportError = useCallback((text: string) => {
    // UUID 생성 예외가 발생한 경우에도 기존 대화 UI로 오류를 안내한다.
    const id = `assistant-error-${++errorIdRef.current}`;
    setMessages((current) => [...current, {
      id,
      role: "assistant",
      text,
    }]);
  }, []);

  const restoreInput = useCallback((text: string) => {
    if (inputTextRef.current.length > 0) return;
    inputTextRef.current = text;
    setInputText(text);
  }, []);

  const finishOperation = useCallback(() => {
    sendLockedRef.current = false;
    pendingInputRef.current = "";
    setIsBusy(false);
    setStatus(pendingMockRef.current === null ? "idle" : "need-more-info");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationVersionRef.current += 1;
      sendLockedRef.current = false;
      pendingInputRef.current = "";
    };
  }, []);

  useEffect(() => {
    if (status !== "processing") return;

    const version = operationVersionRef.current;
    const submittedText = pendingInputRef.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || operationVersionRef.current !== version) return;
      const before = useScheduleStore.getState().schedules;
      let handled = false;
      try {
        const result = runMockAssistantScenario(submittedText, pendingMockRef.current);
        if (operationVersionRef.current !== version) return;
        pendingMockRef.current = result.pending;
        handled = result.handled;
        publishResponse({
          id: Crypto.randomUUID(),
          role: "assistant",
          text: result.text,
          schedules: result.schedules,
          interaction: "interaction" in result ? result.interaction : undefined,
        }, handled);
      } catch {
        if (cancelled || operationVersionRef.current !== version) return;
        // 동기 Mock의 실제 데이터 변경과 응답 표시 실패를 구분한다.
        const changed = useScheduleStore.getState().schedules !== before;
        if (changed || handled) invalidateActiveInteraction();
        if (changed) pendingMockRef.current = null;
        else restoreInput(submittedText);
        reportError(changed
          ? "일정 데이터가 변경되었지만 응답을 표시하지 못했어요. 목록에서 확인해 주세요."
          : "요청을 처리하지 못했어요. 입력 내용을 확인하고 다시 전송해 주세요.");
      } finally {
        if (!cancelled && operationVersionRef.current === version) finishOperation();
      }
    }, MOCK_PROCESSING_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, finishOperation, invalidateActiveInteraction, publishResponse, reportError, restoreInput]);

  const handleSend = () => {
    const text = inputTextRef.current.trim();
    if (!mountedRef.current || !text || sendLockedRef.current || status === "processing") return;
    sendLockedRef.current = true;
    setIsBusy(true);
    operationVersionRef.current += 1;
    pendingInputRef.current = text;

    try {
      const message: ConversationMessage = {
        id: Crypto.randomUUID(),
        role: "user",
        text,
      };
      setMessages((current) => [...current, message]);
      inputTextRef.current = "";
      setInputText("");
      setStatus("processing");
    } catch {
      restoreInput(text);
      reportError("메시지를 전송하지 못했어요. 다시 시도해 주세요.");
      finishOperation();
    }
  };

  const handleInteraction = (
    messageId: string,
    action: { type: "candidate"; scheduleId: string } | { type: "confirmation"; confirmed: boolean },
  ) => {
    if (
      !mountedRef.current || sendLockedRef.current || status === "processing" ||
      activeInteractionIdRef.current !== messageId ||
      resolvedInteractionIdsRef.current.has(messageId)
    ) return;
    const message = messages.find((item) => item.id === messageId);
    if (
      message?.role !== "assistant" ||
      !message.interaction || message.interaction.resolved
    ) return;
    const interaction = message.interaction;
    if (action.type === "candidate" && (
      interaction.type !== "candidate-selection" ||
      !interaction.candidates.some((candidate) => candidate.scheduleId === action.scheduleId)
    )) return;
    if (action.type === "confirmation" && interaction.type !== "delete-confirmation") return;

    sendLockedRef.current = true;
    setIsBusy(true);
    const version = ++operationVersionRef.current;
    const before = useScheduleStore.getState().schedules;
    let confirmationHandled = false;
    try {
      const result: { text: string; interaction?: AssistantInteraction } = action.type === "candidate"
        ? createMockDeleteConfirmation(action.scheduleId)
        : resolveMockDeleteConfirmation(
          (interaction as Extract<typeof interaction, { type: "delete-confirmation" }>).scheduleId,
          action.confirmed,
        );
      if (operationVersionRef.current !== version) return;
      confirmationHandled = action.type === "confirmation";
      publishResponse({
        id: Crypto.randomUUID(),
        role: "assistant",
        text: result.text,
        interaction: result.interaction,
      }, true);
    } catch {
      if (operationVersionRef.current !== version) return;
      const changed = useScheduleStore.getState().schedules !== before;
      if (changed || confirmationHandled) invalidateActiveInteraction();
      if (changed) pendingMockRef.current = null;
      reportError(changed || confirmationHandled
        ? "확인 처리 후 응답을 표시하지 못했어요. 일정 목록을 확인해 주세요."
        : "요청을 처리하지 못했어요. 다시 선택하거나 확인해 주세요.");
    } finally {
      if (operationVersionRef.current === version) finishOperation();
    }
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
          ref={conversationListRef}
          messages={messages}
          isProcessing={status === "processing"}
          interactionsDisabled={isBusy || status === "processing"}
          onDeleteConfirmation={(messageId, confirmed) =>
            handleInteraction(messageId, { type: "confirmation", confirmed })}
          onCandidateSelection={(messageId, scheduleId) =>
            handleInteraction(messageId, { type: "candidate", scheduleId })}
        />
        <MessageInput
          onFocus={() => conversationListRef.current?.prepareForKeyboard()}
          value={inputText}
          onChangeText={(text) => {
            inputTextRef.current = text;
            setInputText(text);
          }}
          onSend={handleSend}
          disabled={isBusy || status === "processing"}
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
