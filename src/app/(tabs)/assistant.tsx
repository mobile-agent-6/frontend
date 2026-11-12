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
import { assistantHttpClient } from "@/services/api/assistant";
import { assistantOrchestrator, type AssistantExecutionResult, type AssistantRequestTask } from "@/services/api/assistant-orchestrator";
import {
  resolveMockDeleteConfirmation,
  createMockDeleteConfirmation,
  runMockAssistantScenario,
  type MockAssistantPending,
} from "@/services/mock/assistant";
import type { AssistantInteraction, AssistantStatus } from "@/types/assistant";
import { useScheduleStore } from "@/stores/scheduleStore";
import { isMockScheduleMode, scheduleDataModeStore } from "@/stores/scheduleDataModeStore";
import { parseAssistantRequestCreate, validateAssistantJsonBodySize, validateAssistantText } from "@/utils/assistant-validation";

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
  const inputRevisionRef = useRef(0);
  const serverTaskRef = useRef<AssistantRequestTask | null>(null);
  const operationVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const errorIdRef = useRef(0);
  const pendingInputRef = useRef("");
  const pendingMockRef = useRef<MockAssistantPending>(null);
  const activeInteractionIdRef = useRef<string | null>(null);
  const resolvedInteractionIdsRef = useRef(new Set<string>());
  const conversationListRef = useRef<ConversationListHandle>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const reportError = useCallback((text: string, apiExecution?: AssistantExecutionResult) => {
    // UUID 생성 예외가 발생한 경우에도 기존 대화 UI로 오류를 안내한다.
    const id = `assistant-error-${++errorIdRef.current}`;
    setMessages((current) => [...current, {
      id,
      role: "assistant",
      text,
      apiExecution,
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

  const clearMockOperation = useCallback((notify: boolean) => {
    if (!mountedRef.current) return;
    operationVersionRef.current += 1;
    serverTaskRef.current?.cancel();
    serverTaskRef.current = null;
    if (processingTimerRef.current !== null) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = null;
    pendingMockRef.current = null;
    invalidateActiveInteraction();
    finishOperation();
    if (notify) reportError("데이터 모드가 변경되어 이전 요청을 중단했어요.");
  }, [finishOperation, invalidateActiveInteraction, reportError]);

  useEffect(() => scheduleDataModeStore.subscribe((current, previous) => {
    if (current.generation !== previous.generation) clearMockOperation(current.mode === "server");
  }), [clearMockOperation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationVersionRef.current += 1;
      serverTaskRef.current?.cancel();
      serverTaskRef.current = null;
      sendLockedRef.current = false;
      pendingInputRef.current = "";
      if (processingTimerRef.current !== null) clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (status !== "processing" || serverTaskRef.current !== null || !isMockScheduleMode()) return;

    const version = operationVersionRef.current;
    const submittedText = pendingInputRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!mountedRef.current || cancelled || operationVersionRef.current !== version) return;
      if (!isMockScheduleMode(generation)) { clearMockOperation(true); return; }
      const before = useScheduleStore.getState().schedules;
      let handled = false;
      try {
        const result = runMockAssistantScenario(submittedText, pendingMockRef.current);
        if (operationVersionRef.current !== version || !isMockScheduleMode(generation)) return;
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
    processingTimerRef.current = timer;

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (processingTimerRef.current === timer) processingTimerRef.current = null;
    };
  }, [status, finishOperation, invalidateActiveInteraction, publishResponse, reportError, restoreInput, clearMockOperation]);

  const sendServerText = async () => {
    if (!mountedRef.current || sendLockedRef.current || status === "processing") return;
    sendLockedRef.current = true;
    setIsBusy(true);
    const version = ++operationVersionRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    const text = inputTextRef.current, revision = inputRevisionRef.current;
    let completed = false;
    const isCurrent = () => mountedRef.current && operationVersionRef.current === version &&
      scheduleDataModeStore.getState().mode === "server" && scheduleDataModeStore.getState().generation === generation;
    try {
      // 서버 계약은 trim 전 원문을 검사한다. Mock의 기존 입력 처리와 분리한다.
      if (!validateAssistantText(text).ok) {
        reportError("공백이 아닌 메시지를 1~500자로 입력해 주세요. 허용되지 않는 제어문자는 사용할 수 없어요.");
        return;
      }
      const serverId = assistantHttpClient.getServerId();
      if (!serverId) { reportError("Assistant 서버 설정을 확인해 주세요."); return; }
      const requestId = Crypto.randomUUID();
      const body = parseAssistantRequestCreate({ requestId, input: { type: "text", text } });
      if (!body || !validateAssistantJsonBodySize(JSON.stringify(body)).ok) {
        reportError("메시지 형식이나 크기를 확인해 주세요.");
        return;
      }
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId) return;
      pendingInputRef.current = text;
      setMessages((current) => [...current, { id: requestId, role: "user", text }]);
      inputTextRef.current = "";
      setInputText("");
      setStatus("processing");
      // 저장 장벽·GET-first·polling·재전송은 기존 orchestration에만 맡긴다.
      const task = assistantOrchestrator.startRequest(body, { expectedServerId: serverId });
      if (!isCurrent()) { task.cancel(); return; }
      serverTaskRef.current = task;
      const execution = await task.completion;
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId) return;
      if (execution.kind === "completed") {
        completed = true;
        // 결과 종류·식별값·질문·상세 DTO는 보존하되 이번 단계에서는 텍스트만 표시한다.
        publishResponse({ id: `assistant-${requestId}`, role: "assistant",
          text: execution.response.data.result.text, apiExecution: execution }, false);
      } else {
        reportError("요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.", execution);
      }
    } catch {
      if (isCurrent()) {
        // 표시 실패는 새 POST의 근거가 아니다. 원래 복구 기록도 정리하지 않는다.
        try { reportError("응답을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요."); } catch {}
      }
    } finally {
      if (mountedRef.current && operationVersionRef.current === version) {
        // 새로 작성했다가 지운 초안도 이전 요청의 실패 입력으로 덮어쓰지 않는다.
        if (!completed && inputRevisionRef.current === revision) restoreInput(text);
        serverTaskRef.current = null;
        finishOperation();
      }
    }
  };

  const handleSend = () => {
    if (!isMockScheduleMode()) { void sendServerText(); return; }
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
      if (!isMockScheduleMode()) { clearMockOperation(true); return; }
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
    if (!mountedRef.current) return;
    if (!isMockScheduleMode()) return;
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
    const generation = scheduleDataModeStore.getState().generation;
    const before = useScheduleStore.getState().schedules;
    let confirmationHandled = false;
    try {
      const result: { text: string; interaction?: AssistantInteraction } = action.type === "candidate"
        ? createMockDeleteConfirmation(action.scheduleId)
        : resolveMockDeleteConfirmation(
          (interaction as Extract<typeof interaction, { type: "delete-confirmation" }>).scheduleId,
          action.confirmed,
        );
      if (operationVersionRef.current !== version || !isMockScheduleMode(generation)) return;
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
            inputRevisionRef.current += 1;
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
