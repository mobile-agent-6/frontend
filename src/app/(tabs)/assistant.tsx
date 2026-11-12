import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";

import {
  ConversationList,
  type ConversationMessage,
  type ConversationListHandle,
} from "@/components/assistant/conversation-list";
import { MessageInput } from "@/components/assistant/message-input";
import { formatAssistantCardDateTime } from "@/components/assistant/assistant-schedule-card";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { assistantHttpClient } from "@/services/api/assistant";
import { assistantLifecycle, type AssistantLifecycleSnapshot } from "@/services/api/assistant-lifecycle";
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
import { upsertAssistantExecutionMessage } from "@/utils/assistant-recovery-messages";
import { createAssistantTextQuestionContext, type AssistantCandidateQuestion, type AssistantConfirmationQuestion, type AssistantTextQuestion } from "@/utils/assistant-text-question";
import { assistantCandidateToDisplay } from "@/utils/assistant-mapper";

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
  const [questionUi, setQuestionUi] = useState<{ serverId: string; generation: number;
    active?: AssistantCandidateQuestion; confirmation?: AssistantConfirmationQuestion;
    selections: Readonly<Record<string, string>>; confirmations: Readonly<Record<string, boolean>>;
    expiredConfirmations: readonly string[] } | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] = useState(assistantLifecycle.getSnapshot);
  const sendLockedRef = useRef(false);
  const inputTextRef = useRef("");
  const inputRevisionRef = useRef(0);
  const serverTaskRef = useRef<AssistantRequestTask | null>(null);
  const textQuestionRef = useRef<ReturnType<typeof createAssistantTextQuestionContext> | null>(null);
  const operationVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const errorIdRef = useRef(0);
  const pendingInputRef = useRef("");
  const pendingMockRef = useRef<MockAssistantPending>(null);
  const activeInteractionIdRef = useRef<string | null>(null);
  const resolvedInteractionIdsRef = useRef(new Set<string>());
  const conversationListRef = useRef<ConversationListHandle>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getTextQuestionContext = useCallback((serverId: string) => {
    const generation = scheduleDataModeStore.getState().generation;
    if (textQuestionRef.current?.serverId !== serverId || textQuestionRef.current.generation !== generation) {
      textQuestionRef.current = createAssistantTextQuestionContext(serverId, generation);
    }
    return textQuestionRef.current;
  }, []);

  const syncQuestionUi = useCallback((context: ReturnType<typeof createAssistantTextQuestionContext>) => {
    if (!mountedRef.current) return;
    const now = Date.now();
    const next = { serverId: context.serverId, generation: context.generation,
      active: context.getCandidateQuestion(now), confirmation: context.getConfirmationQuestion(now),
      selections: context.getSelections(), confirmations: context.getConfirmations(), expiredConfirmations: context.getExpiredConfirmations(now) };
    setQuestionUi(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);

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
    if (apiExecution) {
      setMessages(current => upsertAssistantExecutionMessage(current, apiExecution, "request"));
      return;
    }
    // UUID 생성 예외가 발생한 경우에도 기존 대화 UI로 오류를 안내한다.
    const id = `assistant-error-${++errorIdRef.current}`;
    setMessages((current) => [...current, {
      id,
      role: "assistant",
      text,
      ...(isMockScheduleMode() ? {} : { serverId: assistantHttpClient.getServerId() }),
    }]);
  }, []);

  const reportRecoveryIssue = useCallback((snapshot: AssistantLifecycleSnapshot, serverId: string | null) => {
    const id = `assistant-recovery-notice-${JSON.stringify(serverId)}`;
    const { phase, initialCheck, initialization, issue } = snapshot;
    const message: ConversationMessage = { id, role: "assistant", serverId,
      text: initialCheck === "pending" && !issue ? "이전 요청을 확인하고 있어요. 확인 뒤 전송해 주세요."
        : issue === "server-mismatch" ? "서버 설정이 달라 이전 요청을 확인하지 못했어요."
        : "이전 요청의 복구 정보를 확인하지 못했어요. 결과 확인이 필요해요.",
      recoveryIssue: { serverId: snapshot.serverId, phase, initialCheck, initialization, issue } };
    setMessages(current => {
      const index = current.findIndex(item => item.id === id);
      if (index < 0) return [...current, message];
      return JSON.stringify(current[index]) === JSON.stringify(message) ? current : current.map((item, n) => n === index ? message : item);
    });
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
    textQuestionRef.current = null;
    setQuestionUi(null);
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
    let subscribed = true;
    const consume = () => {
      if (!subscribed || !mountedRef.current) return;
      const snapshot = assistantLifecycle.getSnapshot();
      setRecoverySnapshot(snapshot);
      if (isMockScheduleMode()) return;
      const serverId = assistantHttpClient.getServerId();
      if (snapshot.serverId !== serverId) {
        if (snapshot.serverId !== null) reportRecoveryIssue({ ...snapshot, issue: "server-mismatch" }, serverId);
        return;
      }
      if (serverId) {
        const context = getTextQuestionContext(serverId);
        for (const entry of snapshot.results) {
          if (entry.reference.serverId !== serverId) continue;
          if (entry.latestResult && entry.latestResult.reference.requestId.toLowerCase() === entry.reference.requestId.toLowerCase()) {
            context.observeExecution(entry.latestResult, "recovery");
          } else if (!entry.latestResult && entry.phase === "status" && entry.lastResponse &&
            entry.lastResponse.data.requestId.toLowerCase() === entry.reference.requestId.toLowerCase()) {
            context.observeResponse(entry.lastResponse.data, "recovery");
          }
        }
        syncQuestionUi(context);
      }
      setMessages(current => {
        let next = snapshot.initialCheck === "checked" && !snapshot.issue && !snapshot.initialization
          ? current.filter(message => message.role !== "assistant" || !message.recoveryIssue || message.serverId !== serverId) : current;
        if (next.length === current.length) next = current;
        for (const entry of snapshot.results) {
          if (entry.reference.serverId !== serverId) continue;
          let execution = entry.latestResult;
          if (!execution && entry.phase === "status" && entry.lastResponse) {
            const response = entry.lastResponse, data = response.data;
            execution = data.status === "completed"
              ? { kind: "completed", reference: entry.reference, response: { ...response, data } }
              : { kind: "observed", reference: entry.reference, response: { ...response, data } };
          }
          if (execution?.kind === "needs-attention" && !execution.lastResponse && entry.lastResponse) {
            execution = { ...execution, lastResponse: entry.lastResponse };
          }
          if (execution && execution.reference.serverId === serverId &&
            execution.reference.requestId.toLowerCase() === entry.reference.requestId.toLowerCase()) {
            next = upsertAssistantExecutionMessage(next, execution, "recovery");
          }
        }
        return next;
      });
      if (snapshot.initialization || snapshot.issue) reportRecoveryIssue(snapshot, serverId);
    };
    // 먼저 구독하고 즉시 다시 읽어 render와 effect 사이의 변경도 놓치지 않는다.
    const unsubscribe = assistantLifecycle.subscribe(consume);
    consume();
    return () => { subscribed = false; unsubscribe(); };
  }, [getTextQuestionContext, reportRecoveryIssue, syncQuestionUi]);

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

  const sendServerInput = async (action?: { type: "selection"; messageId: string; candidateId: string } |
    { type: "confirmation"; messageId: string; approved: boolean }) => {
    const selection = action?.type === "selection" ? action : undefined;
    const confirmation = action?.type === "confirmation" ? action : undefined;
    if (!mountedRef.current || sendLockedRef.current || status === "processing") return;
    sendLockedRef.current = true;
    setIsBusy(true);
    const version = ++operationVersionRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    const text = inputTextRef.current, revision = inputRevisionRef.current;
    let completed = false;
    let clearInputExpiry: (() => void) | undefined;
    const isCurrent = () => mountedRef.current && operationVersionRef.current === version &&
      scheduleDataModeStore.getState().mode === "server" && scheduleDataModeStore.getState().generation === generation;
    try {
      // 서버 계약은 trim 전 원문을 검사한다. Mock의 기존 입력 처리와 분리한다.
      if (!action && !validateAssistantText(text).ok) {
        reportError("공백이 아닌 메시지를 1~500자로 입력해 주세요. 허용되지 않는 제어문자는 사용할 수 없어요.");
        return;
      }
      const serverId = assistantHttpClient.getServerId();
      if (!serverId) { reportError("Assistant 서버 설정을 확인해 주세요."); return; }
      const canStart = () => {
        const snapshot = assistantLifecycle.getSnapshot();
        if (snapshot.serverId === serverId && snapshot.initialCheck === "checked") return true;
        reportRecoveryIssue(snapshot, serverId);
        return false;
      };
      if (!canStart()) return;
      const context = getTextQuestionContext(serverId);
      const currentQuestion = context.getQuestion();
      let question: AssistantTextQuestion | undefined, label = text;
      const resolveSelection = () => {
        if (!selection) return;
        const active = context.getCandidateQuestion(Date.now());
        const message = messages.find(item => item.id === selection.messageId);
        const execution = message?.role === "assistant" ? message.apiExecution : undefined;
        if (!active || execution?.kind !== "completed" || execution.reference.serverId !== serverId ||
          execution.reference.requestId.toLowerCase() !== active.requestId.toLowerCase() ||
          execution.response.data.result.kind !== "candidate_selection" ||
          execution.response.data.result.questionId !== active.questionId || !active.candidateIds.includes(selection.candidateId)) return;
        const candidate = execution.response.data.result.candidates.find(item => item.candidateId === selection.candidateId);
        return candidate ? { question: active, candidate } : undefined;
      };
      const selected = resolveSelection();
      const resolveConfirmation = () => {
        if (!confirmation || typeof confirmation.approved !== "boolean") return;
        const active = context.getConfirmationQuestion(Date.now());
        const message = messages.find(item => item.id === confirmation.messageId);
        const execution = message?.role === "assistant" ? message.apiExecution : undefined;
        if (!active || execution?.kind !== "completed" || execution.reference.serverId !== serverId ||
          execution.reference.requestId.toLowerCase() !== active.requestId.toLowerCase() ||
          execution.response.data.result.kind !== "confirmation" ||
          execution.response.data.result.questionId.toLowerCase() !== active.questionId.toLowerCase()) return;
        return active;
      };
      const confirmed = resolveConfirmation();
      if (selection) {
        if (!selected) return;
        question = selected.question;
        const candidate = assistantCandidateToDisplay(selected.candidate);
        label = `${candidate.title} · ${formatAssistantCardDateTime(candidate.date, candidate.time)} · ${candidate.category}`;
      } else if (confirmation) {
        if (!confirmed) return;
        question = confirmed;
        label = confirmation.approved ? "예" : "아니요";
      } else if (typeof currentQuestion === "string") {
        reportError(currentQuestion === "unsupported" ? "현재 질문은 후보 선택 또는 확인이 필요해요."
          : "현재 질문을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요.");
        return;
      } else question = currentQuestion;
      const requestId = Crypto.randomUUID();
      if (!action) {
        const latest = context.getQuestion();
        if (typeof latest === "string") return;
        question = latest;
      }
      const body = parseAssistantRequestCreate({ requestId,
        ...(question ? { conversationId: question.conversationId } : {}),
        input: confirmation ? { type: "confirmation", questionId: question?.questionId, approved: confirmation.approved }
          : selection ? { type: "selection", questionId: question?.questionId, candidateId: selection.candidateId }
          : { type: "text", text, ...(question ? { questionId: question.questionId } : {}) } });
      if (!body || !validateAssistantJsonBodySize(JSON.stringify(body)).ok) {
        reportError("메시지 형식이나 크기를 확인해 주세요.");
        return;
      }
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId) return;
      if (!canStart()) return;
      // 본문을 만든 사이 질문이 바뀌었으면 오래된 ID로 보내지 않고 입력을 남긴다.
      if (selection ? JSON.stringify(selected?.question) !== JSON.stringify(resolveSelection()?.question)
        : confirmation ? JSON.stringify(confirmed) !== JSON.stringify(resolveConfirmation())
          : JSON.stringify(question) !== JSON.stringify(context.getQuestion())) return;
      const timedQuestion = selected?.question ?? confirmed;
      const inputController = action ? new AbortController() : undefined;
      if (inputController && timedQuestion) {
        const remaining = Date.parse(timedQuestion.expiresAt) - Date.now();
        if (remaining <= 0) return;
        // 저장 장벽 대기 중 만료되면 기존 HTTP의 AbortSignal 검사로 실제 전송을 막는다. 서버 취소는 아니다.
        const timer = setTimeout(() => {
          if (!assistantHttpClient.hasAcceptanceEvidence({ serverId, requestId })) inputController.abort();
        }, Math.min(2_147_483_647, remaining));
        clearInputExpiry = () => clearTimeout(timer);
      }
      pendingInputRef.current = label;
      setMessages((current) => [...current, { id: requestId, role: "user", text: label, serverId }]);
      if (!action) { inputTextRef.current = ""; setInputText(""); }
      setStatus("processing");
      context.beginRequest(requestId, question, selection?.candidateId, confirmation?.approved);
      syncQuestionUi(context);
      // 저장 장벽·GET-first·polling·재전송은 기존 orchestration에만 맡긴다.
      const task = assistantOrchestrator.startRequest(body, { expectedServerId: serverId, signal: inputController?.signal, onUpdate: event => {
        if (!isCurrent() || assistantHttpClient.getServerId() !== serverId || event.reference.serverId !== serverId ||
          event.reference.requestId.toLowerCase() !== requestId.toLowerCase()) return;
        if (event.phase === "status") {
          clearInputExpiry?.();
          context.observeResponse(event.response.data, "request", question);
          syncQuestionUi(context);
        }
      } });
      if (!isCurrent()) { task.cancel(); return; }
      serverTaskRef.current = task;
      const execution = await task.completion;
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId) return;
      context.observeExecution(execution, "request", question);
      syncQuestionUi(context);
      if (execution.kind === "completed") {
        completed = true;
        // 원본 처리 결과를 메시지에 보존하고 상세 표시는 ConversationList에 맡긴다.
        setMessages(current => upsertAssistantExecutionMessage(current, execution, "request"));
      } else {
        reportError("요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.", execution);
      }
    } catch {
      if (isCurrent()) {
        // 표시 실패는 새 POST의 근거가 아니다. 원래 복구 기록도 정리하지 않는다.
        try { reportError("응답을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요."); } catch {}
      }
    } finally {
      clearInputExpiry?.();
      if (mountedRef.current && operationVersionRef.current === version) {
        // 새로 작성했다가 지운 초안도 이전 요청의 실패 입력으로 덮어쓰지 않는다.
        if (!action && !completed && inputRevisionRef.current === revision) restoreInput(text);
        serverTaskRef.current = null;
        finishOperation();
      }
    }
  };

  const handleSend = () => {
    if (!isMockScheduleMode()) { void sendServerInput(); return; }
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

  const mockMode = isMockScheduleMode(), currentServerId = assistantHttpClient.getServerId();
  const recoveryMatches = !mockMode && recoverySnapshot.serverId === currentServerId;
  const recoveryPending = !mockMode && currentServerId !== null &&
    (!recoveryMatches || recoverySnapshot.initialCheck === "pending") &&
    ["idle", "recovering", "observing"].includes(recoverySnapshot.phase);
  const recoveryProcessing = recoveryMatches && ["recovering", "observing"].includes(recoverySnapshot.phase) &&
    recoverySnapshot.results.some(entry => entry.reference.serverId === currentServerId &&
      entry.latestResult?.kind !== "needs-attention" && entry.lastResponse?.data.status !== "completed" && Boolean(entry.lastResponse));
  const visibleMessages = messages.filter(message => {
    const serverId = message.serverId !== undefined ? message.serverId
      : message.role === "assistant" ? message.apiExecution?.reference.serverId : undefined;
    return mockMode ? serverId === undefined : serverId !== undefined && serverId === currentServerId;
  });
  const questionView = !mockMode && questionUi?.serverId === currentServerId &&
    questionUi.generation === scheduleDataModeStore.getState().generation ? questionUi : null;
  const activeCandidate = questionView?.active;
  const activeConfirmation = questionView?.confirmation;
  const timedQuestion = activeCandidate ?? activeConfirmation;
  const timedRequestId = timedQuestion?.requestId, timedExpiresAt = timedQuestion?.expiresAt;
  useEffect(() => {
    if (!timedExpiresAt) return;
    const timer = setTimeout(() => {
      const context = textQuestionRef.current;
      if (context) syncQuestionUi(context);
    },
      Math.min(2_147_483_647, Math.max(0, Date.parse(timedExpiresAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [timedRequestId, timedExpiresAt, syncQuestionUi]);

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
          messages={visibleMessages.length === messages.length ? messages : visibleMessages}
          isProcessing={status === "processing" || recoveryPending || recoveryProcessing}
          interactionsDisabled={isBusy || status === "processing"}
          activeApiCandidate={!recoveryPending && !isBusy ? activeCandidate : undefined}
          apiCandidateSelections={questionView?.selections}
          onApiCandidateSelection={(messageId, candidateId) => { if (!isMockScheduleMode()) void sendServerInput({ type: "selection", messageId, candidateId }); }}
          activeApiConfirmation={!recoveryPending && !isBusy ? activeConfirmation : undefined}
          apiConfirmations={questionView?.confirmations}
          expiredApiConfirmations={questionView?.expiredConfirmations}
          onApiConfirmation={(messageId, approved) => { if (!isMockScheduleMode()) void sendServerInput({ type: "confirmation", messageId, approved }); }}
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
          disabled={isBusy || status === "processing" || recoveryPending}
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
