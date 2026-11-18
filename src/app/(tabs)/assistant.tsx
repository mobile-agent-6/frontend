import { createAssistantVoicePayload, disposeVoiceFile, retryVoiceFileCleanup } from "@/services/assistant-voice-payload";
import type { VoiceRequestFile } from "@/services/voice-request-file";
import type { VoiceRecordingSubmission } from "@/hooks/use-local-voice-recording";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";

import { formatAssistantCardDateTime } from "@/components/assistant/assistant-schedule-card";
import {
  ConversationList,
  type ConversationListHandle,
  type ConversationMessage,
} from "@/components/assistant/conversation-list";
import { MessageInput } from "@/components/assistant/message-input";
import { VoiceInputStatus } from "@/components/assistant/voice-input-status";
import { Header } from "@/components/navigation/header";
import { ThemedView } from "@/components/ui/themed-view";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useLocalVoiceRecording } from "@/hooks/use-local-voice-recording";
import { assistantHttpClient } from "@/services/api/assistant";
import {
  assistantLifecycle,
  type AssistantLifecycleSnapshot,
} from "@/services/api/assistant-lifecycle";
import {
  assistantOrchestrator,
  type AssistantExecutionOptions,
  type AssistantExecutionResult,
  type AssistantRequestTask,
} from "@/services/api/assistant-orchestrator";
import { assistantScheduleSync } from "@/services/api/assistant-schedule-sync";
import {
  createMockDeleteConfirmation,
  resolveMockDeleteConfirmation,
  runMockAssistantScenario,
  type MockAssistantPending,
} from "@/services/mock/assistant";
import { assistantRecoveryStorage } from "@/services/storage/assistant-recovery";
import {
  isMockScheduleMode,
  scheduleDataModeStore,
} from "@/stores/scheduleDataModeStore";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { AssistantInteraction, AssistantStatus } from "@/types/assistant";
import type {
  AssistantRecoveryCleanupEvidence,
  AssistantRecoveryMetadata,
  AssistantRecoveryReference,
} from "@/types/assistant-recovery";
import {
  getAssistantErrorRecoveryTarget,
  getAssistantExecutionError,
  type AssistantErrorRecoveryNotice,
} from "@/utils/assistant-errors";
import { assistantCandidateToDisplay } from "@/utils/assistant-mapper";
import {
  assistantAcceptedCleanup,
  assistantRecoveryKey,
  assistantRequestExpiryEvidence,
  type AssistantRecoveryCleanupPhase,
  type AssistantRecoveryControl,
  type AssistantRecoveryControlAction,
} from "@/utils/assistant-recovery-cleanup";
import { upsertAssistantExecutionMessage } from "@/utils/assistant-recovery-messages";
import {
  createAssistantTextQuestionContext,
  type AssistantCandidateQuestion,
  type AssistantConfirmationQuestion,
  type AssistantTextQuestion,
} from "@/utils/assistant-text-question";
import {
  createAssistantUncertainContext,
  type AssistantUncertainView,
} from "@/utils/assistant-uncertain";
import {
  parseAssistantRequestCreate,
  parseAssistantRequestStatusResponse,
  validateAssistantJsonBodySize,
  validateAssistantText,
} from "@/utils/assistant-validation";
import {
  isVoiceInputBusy,
  type AssistantInputUi,
} from "@/utils/assistant-voice-ui";

// processing UI를 보여주기 위한 Mock 지연이며, 실제 API timeout이 아니다.
const MOCK_PROCESSING_DELAY_MS = 700;

function recoveringRecord(snapshot: AssistantLifecycleSnapshot, key: string) {
  if (snapshot.handoff && assistantRecoveryKey(snapshot.handoff) === key) return true;
  return snapshot.phase === "observing" && snapshot.results.some(entry =>
    assistantRecoveryKey(entry.reference) === key &&
    entry.latestResult?.kind !== "needs-attention" &&
    entry.lastResponse?.data.status !== "completed");
}

function resolveInteraction(message: ConversationMessage, id: string) {
  return message.id === id &&
    message.role === "assistant" &&
    message.interaction
    ? { ...message, interaction: { ...message.interaction, resolved: true } }
    : message;
}

export default function AssistantScreen() {
  const viewGeneration = scheduleDataModeStore.getState().generation;
  const viewServerId = assistantHttpClient.getServerId();
  const viewCurrent = () => scheduleDataModeStore.getState().generation === viewGeneration && assistantHttpClient.getServerId() === viewServerId;
  const theme = useTheme();
  const colorScheme = useColorScheme();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [status, setStatus] = useState<AssistantStatus>("idle");
  // 로컬 녹음 표시와 기존 Assistant 요청 상태를 분리한다.
  const [inputUi, setInputUi] = useState<AssistantInputUi>({ source: "text" });
  const inputUiRef = useRef(inputUi);
  const voiceStartAllowedRef = useRef<() => boolean>(() => false);
  type VoiceSubmission = { token: symbol; owner: VoiceRequestFile; question?: AssistantTextQuestion & { expiresAt?: string }; isCurrent(): boolean };
  const voiceSubmissionRef = useRef<(() => VoiceRecordingSubmission | undefined) | undefined>(undefined);
  const voiceExecutionRef = useRef<{
    reference: AssistantRecoveryReference;
    generation: number;
    version: number;
    token: symbol;
    previouslyAccepted: boolean;
  } | null>(null);
  const activeVoiceRef = useRef(false);
  const localVoice = useLocalVoiceRecording(() => voiceStartAllowedRef.current(), (input) => {
    inputUiRef.current = input;
    setInputUi(input);
  }, () => voiceSubmissionRef.current?.(), value => assistantLifecycle.focus?.(value));
  const voiceInputBusy = isVoiceInputBusy(inputUi) || localVoice.busy;
  const [isBusy, setIsBusy] = useState(false);
  const [questionUi, setQuestionUi] = useState<{
    serverId: string;
    generation: number;
    voiceAvailable: boolean;
    active?: AssistantCandidateQuestion;
    confirmation?: AssistantConfirmationQuestion;
    selections: Readonly<Record<string, string>>;
    confirmations: Readonly<Record<string, boolean>>;
    expiredConfirmations: readonly string[];
  } | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] = useState(
    assistantLifecycle.getSnapshot,
  );
  const [scheduleSyncSnapshot, setScheduleSyncSnapshot] = useState(
    assistantScheduleSync.getSnapshot,
  );
  const [retryingScheduleSync, setRetryingScheduleSync] = useState<
    readonly string[]
  >([]);
  const scheduleSyncRetryLocksRef = useRef(new Map<string, symbol>());
  const [uncertainUi, setUncertainUi] = useState<{
    serverId: string;
    generation: number;
    held: boolean;
    views: AssistantUncertainView[];
  } | null>(null);
  const [recoveryRecords, setRecoveryRecords] = useState<
    AssistantRecoveryMetadata[]
  >([]);
  const [recoveryReadError, setRecoveryReadError] = useState(false);
  const [cleanupRevision, setCleanupRevision] = useState(0);
  const [cleanupScope, setCleanupScope] = useState(() =>
    JSON.stringify([
      scheduleDataModeStore.getState().mode,
      assistantHttpClient.getServerId(),
      scheduleDataModeStore.getState().generation,
    ]),
  );
  const [cleanupStates, setCleanupStates] = useState<
    Record<
      string,
      {
        reference: AssistantRecoveryReference;
        phase: AssistantRecoveryCleanupPhase;
        automatic?: boolean;
      }
    >
  >({});
  const cleanupLocksRef = useRef(new Set<string>());
  const manualConfirmationsRef = useRef(
    new Map<string, { serverId: string | null; generation: number; snapshot: typeof recoverySnapshot; metadata: Promise<AssistantRecoveryMetadata | null> }>(),
  );
  const committedMessagesRef = useRef(messages);
  const uncertainRef = useRef<ReturnType<
    typeof createAssistantUncertainContext
  > | null>(null);
  const sendLockedRef = useRef(false);
  const inputTextRef = useRef("");
  const inputRevisionRef = useRef(0);
  const serverTaskRef = useRef<AssistantRequestTask | null>(null);
  const textQuestionRef = useRef<ReturnType<
    typeof createAssistantTextQuestionContext
  > | null>(null);
  const operationVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const connectionRef = useRef({ generation: viewGeneration, serverId: viewServerId });
  const lastServerIdRef = useRef(viewServerId);
  const errorIdRef = useRef(0);
  const pendingInputRef = useRef("");
  const mockTextPendingRef = useRef(false);
  const pendingMockRef = useRef<MockAssistantPending>(null);
  const activeInteractionIdRef = useRef<string | null>(null);
  const resolvedInteractionIdsRef = useRef(new Set<string>());
  const conversationListRef = useRef<ConversationListHandle>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 커밋된 메시지와 클릭 대상을 비교할 뿐, effect 자체로 표시 확인이나 정리를 수행하지 않는다.
  useEffect(() => {
    committedMessagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    inputUiRef.current = inputUi;
  }, [inputUi]);

  const publishCleanup = useCallback(
    (
      reference: AssistantRecoveryReference,
      phase: AssistantRecoveryCleanupPhase,
      automatic = false,
    ) => {
      if (!mountedRef.current) return;
      setCleanupStates((previous) => ({
        ...previous,
        [assistantRecoveryKey(reference)]: {
          reference: { ...reference },
          phase,
          automatic,
        },
      }));
    },
    [],
  );

  const cleanupWithEvidence = useCallback(
    async (
      reference: AssistantRecoveryReference,
      evidence: AssistantRecoveryCleanupEvidence,
      isCurrent: () => boolean,
    ) => {
      const key = assistantRecoveryKey(reference);
      const generation = scheduleDataModeStore.getState().generation;
      if (!isCurrent() || cleanupLocksRef.current.has(key)) return;
      cleanupLocksRef.current.add(key);
      publishCleanup(reference, "working");
      try {
        const result = await assistantRecoveryStorage.cleanup(
          reference,
          reference.serverId,
          evidence,
          { isCurrent },
        );
        if (isCurrent()) {
          publishCleanup(reference, result, true);
          setCleanupRevision((value) => value + 1);
        }
      } catch {
        if (isCurrent()) publishCleanup(reference, "failed");
      } finally {
        if (
          !isCurrent() &&
          mountedRef.current &&
          !isMockScheduleMode() &&
          assistantHttpClient.getServerId() === reference.serverId &&
          scheduleDataModeStore.getState().generation === generation
        )
          publishCleanup(reference, "retained");
        cleanupLocksRef.current.delete(key);
      }
    },
    [publishCleanup],
  );

  const getTextQuestionContext = useCallback((serverId: string) => {
    const generation = scheduleDataModeStore.getState().generation;
    if (
      textQuestionRef.current?.serverId !== serverId ||
      textQuestionRef.current.generation !== generation
    ) {
      textQuestionRef.current = createAssistantTextQuestionContext(
        serverId,
        generation,
      );
    }
    return textQuestionRef.current;
  }, []);

  const syncQuestionUi = useCallback(
    (context: ReturnType<typeof createAssistantTextQuestionContext>) => {
      if (!mountedRef.current) return;
      const now = Date.now();
      const next = {
        serverId: context.serverId,
        generation: context.generation,
        voiceAvailable: context.getVoiceQuestion(now) !== "unavailable",
        active: context.getCandidateQuestion(now),
        confirmation: context.getConfirmationQuestion(now),
        selections: context.getSelections(),
        confirmations: context.getConfirmations(),
        expiredConfirmations: context.getExpiredConfirmations(now),
      };
      setQuestionUi((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    },
    [],
  );

  const getUncertainContext = useCallback((serverId: string) => {
    const generation = scheduleDataModeStore.getState().generation;
    if (
      uncertainRef.current?.serverId !== serverId ||
      uncertainRef.current.generation !== generation
    ) {
      uncertainRef.current = createAssistantUncertainContext(
        serverId,
        generation,
      );
    }
    return uncertainRef.current;
  }, []);
  const syncUncertainUi = useCallback(
    (context: ReturnType<typeof createAssistantUncertainContext>) => {
      if (!mountedRef.current) return;
      const next = {
        serverId: context.serverId,
        generation: context.generation,
        held: context.isHeld(),
        views: context.views(),
      };
      setUncertainUi((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    },
    [],
  );

  const invalidateActiveInteraction = useCallback(() => {
    const id = activeInteractionIdRef.current;
    if (id === null) return;
    resolvedInteractionIdsRef.current.add(id);
    activeInteractionIdRef.current = null;
    setMessages((current) =>
      current.map((message) => resolveInteraction(message, id)),
    );
  }, []);

  const publishResponse = useCallback(
    (response: ConversationMessage, replaceInteraction: boolean) => {
      if (replaceInteraction) {
        invalidateActiveInteraction();
        activeInteractionIdRef.current =
          response.role === "assistant" && response.interaction
            ? response.id
            : null;
      }
      setMessages((current) => [...current, response]);
    },
    [invalidateActiveInteraction],
  );

  const reportError = useCallback(
    (text: string, apiExecution?: AssistantExecutionResult) => {
      if (apiExecution) {
        setMessages((current) =>
          upsertAssistantExecutionMessage(current, apiExecution, "request"),
        );
        return;
      }
      // UUID 생성 예외가 발생한 경우에도 기존 대화 UI로 오류를 안내한다.
      const id = `assistant-error-${++errorIdRef.current}`;
      setMessages((current) => [
        ...current,
        {
          id,
          role: "assistant",
          text,
          ...(isMockScheduleMode()
            ? {}
            : { serverId: assistantHttpClient.getServerId() }),
        },
      ]);
    },
    [],
  );

  const reportRecoveryIssue = useCallback(
    (snapshot: AssistantLifecycleSnapshot, serverId: string | null) => {
      const id = `assistant-recovery-notice-${JSON.stringify(serverId)}`;
      const { phase, initialCheck, initialization, issue } = snapshot;
      const message: ConversationMessage = {
        id,
        role: "assistant",
        serverId,
        text:
          initialCheck === "pending" && !issue
            ? "이전 요청을 확인하고 있어요. 확인 뒤 전송해 주세요."
            : issue === "server-mismatch"
              ? "서버 설정이 달라 이전 요청을 확인하지 못했어요."
              : "이전 요청의 복구 정보를 확인하지 못했어요. 결과 확인이 필요해요.",
        recoveryIssue: {
          serverId: snapshot.serverId,
          phase,
          initialCheck,
          initialization,
          issue,
        },
      };
      setMessages((current) => {
        const index = current.findIndex((item) => item.id === id);
        if (index < 0) return [...current, message];
        return JSON.stringify(current[index]) === JSON.stringify(message)
          ? current
          : current.map((item, n) => (n === index ? message : item));
      });
    },
    [],
  );

  const restoreInput = useCallback((text: string) => {
    if (inputTextRef.current.length > 0) return;
    inputTextRef.current = text;
    setInputText(text);
  }, []);

  const finishOperation = useCallback(() => {
    sendLockedRef.current = false;
    pendingInputRef.current = "";
    mockTextPendingRef.current = false;
    setIsBusy(false);
    setStatus(pendingMockRef.current === null ? "idle" : "need-more-info");
  }, []);

  const clearMockOperation = useCallback(
    () => {
      if (!mountedRef.current) return;
      const serverId = assistantHttpClient.getServerId();
      const serverChanged = serverId !== null && lastServerIdRef.current !== null && serverId !== lastServerIdRef.current;
      if (serverId !== null) lastServerIdRef.current = serverId;
      connectionRef.current = { generation: scheduleDataModeStore.getState().generation, serverId: assistantHttpClient.getServerId() };
      operationVersionRef.current += 1;
      committedMessagesRef.current = []; setMessages([]);
      inputTextRef.current = ""; inputRevisionRef.current += 1; setInputText("");
      setRecoveryRecords([]); setRecoveryReadError(false);
      scheduleSyncRetryLocksRef.current.clear(); setRetryingScheduleSync([]);
      serverTaskRef.current?.cancel();
      serverTaskRef.current = null;
      voiceExecutionRef.current = null;
      textQuestionRef.current = null;
      setQuestionUi(null);
      uncertainRef.current = null;
      setUncertainUi(null);
      manualConfirmationsRef.current.clear();
      setCleanupStates({});
      if (processingTimerRef.current !== null)
        clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
      pendingMockRef.current = null;
      invalidateActiveInteraction();
      finishOperation();
      if (serverChanged) reportError("서버 연결이 변경되어 이전 대화가 초기화되었어요.");
    },
    [finishOperation, invalidateActiveInteraction, reportError],
  );

  useLayoutEffect(() => {
    if (connectionRef.current.generation !== viewGeneration || connectionRef.current.serverId !== viewServerId) clearMockOperation();
  }, [viewGeneration, viewServerId, clearMockOperation]);

  useEffect(
    () =>
      scheduleDataModeStore.subscribe((current, previous) => {
        if (current.generation !== previous.generation)
          clearMockOperation();
      }),
    [clearMockOperation],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationVersionRef.current += 1;
      serverTaskRef.current?.cancel();
      serverTaskRef.current = null;
      voiceExecutionRef.current = null;
      sendLockedRef.current = false;
      pendingInputRef.current = "";
      mockTextPendingRef.current = false;
      if (processingTimerRef.current !== null)
        clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    let subscribed = true;
    const consume = () => {
      if (subscribed && mountedRef.current)
        setScheduleSyncSnapshot(assistantScheduleSync.getSnapshot());
    };
    const unsubscribe = assistantScheduleSync.subscribe(consume);
    consume();
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let subscribed = true;
    const consume = () => {
      if (!subscribed || !mountedRef.current) return;
      const snapshot = assistantLifecycle.getSnapshot();
      if (snapshot.generation !== undefined && snapshot.generation !== scheduleDataModeStore.getState().generation) return;
      if (connectionRef.current.serverId !== assistantHttpClient.getServerId() ||
        connectionRef.current.generation !== scheduleDataModeStore.getState().generation) clearMockOperation();
      setRecoverySnapshot(snapshot);
      if (isMockScheduleMode()) return;
      const serverId = assistantHttpClient.getServerId();
      if (snapshot.serverId !== serverId) {
        if (snapshot.serverId !== null)
          reportRecoveryIssue(
            { ...snapshot, issue: "server-mismatch" },
            serverId,
          );
        return;
      }
      if (serverId) {
        const context = getTextQuestionContext(serverId);
        const uncertain = getUncertainContext(serverId);
        for (const entry of snapshot.results) {
          if (entry.reference.serverId !== serverId) continue;
          if (
            entry.latestResult &&
            entry.latestResult.reference.requestId.toLowerCase() ===
              entry.reference.requestId.toLowerCase()
          ) {
            context.observeExecution(entry.latestResult, "recovery");
            uncertain.observe(entry.latestResult, "recovery");
          } else if (
            !entry.latestResult &&
            entry.phase === "status" &&
            entry.lastResponse &&
            entry.lastResponse.data.requestId.toLowerCase() ===
              entry.reference.requestId.toLowerCase()
          ) {
            context.observeResponse(entry.lastResponse.data, "recovery");
            const response = entry.lastResponse,
              data = response.data;
            uncertain.observe(
              data.status === "completed"
                ? {
                    kind: "completed",
                    reference: entry.reference,
                    response: { ...response, data },
                  }
                : {
                    kind: "observed",
                    reference: entry.reference,
                    response: { ...response, data },
                  },
              "recovery",
            );
          }
        }
        syncQuestionUi(context);
        syncUncertainUi(uncertain);
      }
      setMessages((current) => {
        let next =
          snapshot.initialCheck === "checked" &&
          !snapshot.issue &&
          !snapshot.initialization
            ? current.filter(
                (message) =>
                  message.role !== "assistant" ||
                  !message.recoveryIssue ||
                  message.serverId !== serverId,
              )
            : current;
        if (next.length === current.length) next = current;
        for (const entry of snapshot.results) {
          if (entry.reference.serverId !== serverId) continue;
          let execution = entry.latestResult;
          if (!execution && entry.phase === "status" && entry.lastResponse) {
            const response = entry.lastResponse,
              data = response.data;
            execution =
              data.status === "completed"
                ? {
                    kind: "completed",
                    reference: entry.reference,
                    response: { ...response, data },
                  }
                : {
                    kind: "observed",
                    reference: entry.reference,
                    response: { ...response, data },
                  };
          }
          if (
            execution?.kind === "needs-attention" &&
            !execution.lastResponse &&
            entry.lastResponse
          ) {
            execution = { ...execution, lastResponse: entry.lastResponse };
          }
          if (
            execution &&
            execution.reference.serverId === serverId &&
            execution.reference.requestId.toLowerCase() ===
              entry.reference.requestId.toLowerCase()
          ) {
            next = upsertAssistantExecutionMessage(next, execution, "recovery");
          }
        }
        return next;
      });
      if (snapshot.initialization || snapshot.issue)
        reportRecoveryIssue(snapshot, serverId);
    };
    // 먼저 구독하고 즉시 다시 읽어 render와 effect 사이의 변경도 놓치지 않는다.
    const unsubscribe = assistantLifecycle.subscribe(consume);
    consume();
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [
    clearMockOperation,
    getTextQuestionContext,
    getUncertainContext,
    reportRecoveryIssue,
    syncQuestionUi,
    syncUncertainUi,
  ]);

  useEffect(() => {
    // 표시 상태만으로 Mock write를 실행하지 않는다. 실제 text 제출만 실행 권한을 갖는다.
    if (
      status !== "processing" ||
      !mockTextPendingRef.current ||
      serverTaskRef.current !== null ||
      !isMockScheduleMode()
    )
      return;

    const version = operationVersionRef.current;
    const submittedText = pendingInputRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (
        !mountedRef.current ||
        cancelled ||
        operationVersionRef.current !== version
      )
        return;
      if (!isMockScheduleMode(generation)) {
        clearMockOperation();
        return;
      }
      mockTextPendingRef.current = false;
      const before = useScheduleStore.getState().schedules;
      let handled = false;
      try {
        const result = runMockAssistantScenario(
          submittedText,
          pendingMockRef.current,
        );
        if (
          operationVersionRef.current !== version ||
          !isMockScheduleMode(generation)
        )
          return;
        pendingMockRef.current = result.pending;
        handled = result.handled;
        publishResponse(
          {
            id: Crypto.randomUUID(),
            role: "assistant",
            text: result.text,
            schedules: result.schedules,
            interaction:
              "interaction" in result ? result.interaction : undefined,
          },
          handled,
        );
      } catch {
        if (cancelled || operationVersionRef.current !== version) return;
        // 동기 Mock의 실제 데이터 변경과 응답 표시 실패를 구분한다.
        const changed = useScheduleStore.getState().schedules !== before;
        if (changed || handled) invalidateActiveInteraction();
        if (changed) pendingMockRef.current = null;
        else restoreInput(submittedText);
        reportError(
          changed
            ? "일정 데이터가 변경되었지만 응답을 표시하지 못했어요. 목록에서 확인해 주세요."
            : "요청을 처리하지 못했어요. 입력 내용을 확인하고 다시 전송해 주세요.",
        );
      } finally {
        if (!cancelled && operationVersionRef.current === version)
          finishOperation();
      }
    }, MOCK_PROCESSING_DELAY_MS);
    processingTimerRef.current = timer;

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (processingTimerRef.current === timer)
        processingTimerRef.current = null;
    };
  }, [
    status,
    finishOperation,
    invalidateActiveInteraction,
    publishResponse,
    reportError,
    restoreInput,
    clearMockOperation,
  ]);

  const sendServerInput = async (
    action?:
      | { type: "selection"; messageId: string; candidateId: string }
      | { type: "confirmation"; messageId: string; approved: boolean }
      | ({ type: "voice" } & VoiceSubmission),
  ) => {
    if (!viewCurrent()) { if (action?.type === "voice") void disposeVoiceFile(action.owner); return; }
    const voice = action?.type === "voice" ? action : undefined;
    const selection = action?.type === "selection" ? action : undefined;
    const confirmation = action?.type === "confirmation" ? action : undefined;
    if (
      !mountedRef.current ||
      isVoiceInputBusy(inputUiRef.current) || localVoice.isBusy() ||
      sendLockedRef.current ||
      status === "processing"
    ) { if (voice) void disposeVoiceFile(voice.owner); return; }
    sendLockedRef.current = true;
    setIsBusy(true);
    const version = ++operationVersionRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    const text = inputTextRef.current,
      revision = inputRevisionRef.current;
    let completed = false;
    let voicePayload: ReturnType<typeof createAssistantVoicePayload> | undefined;
    let voiceExecution: typeof voiceExecutionRef.current = null;
    let speechNotRecognized = false;
    if (voice) activeVoiceRef.current = true;
    let acknowledgmentAttempt = false,
      postAccepted = false;
    let clearInputExpiry: (() => void) | undefined;
    const isCurrent = () =>
      mountedRef.current &&
      operationVersionRef.current === version &&
      scheduleDataModeStore.getState().mode === "server" &&
      scheduleDataModeStore.getState().generation === generation;
    try {
      // 서버 계약은 trim 전 원문을 검사한다. Mock의 기존 입력 처리와 분리한다.
      if (!action && !validateAssistantText(text).ok) {
        reportError(
          "공백이 아닌 메시지를 1~500자로 입력해 주세요. 허용되지 않는 제어문자는 사용할 수 없어요.",
        );
        return;
      }
      const serverId = assistantHttpClient.getServerId();
      if (!serverId) {
        reportError("Assistant 서버 설정을 확인해 주세요.");
        return;
      }
      const canStart = () => {
        const snapshot = assistantLifecycle.getSnapshot();
        if (
          snapshot.serverId === serverId && !snapshot.handoff &&
          snapshot.initialCheck === "checked"
        )
          return true;
        reportRecoveryIssue(snapshot, serverId);
        return false;
      };
      if (!canStart()) return;
      const context = getTextQuestionContext(serverId);
      syncQuestionUi(context);
      const uncertain = getUncertainContext(serverId);
      const acknowledgedId = !action
        ? uncertain.acknowledgmentForNewText()
        : undefined;
      acknowledgmentAttempt = acknowledgedId !== undefined;
      if (uncertain.isHeld() && (!acknowledgedId || action)) {
        reportError(
          "결과가 확인되지 않은 작업이 있어요. 결과를 확인하고 위험을 명시적으로 인지한 뒤 새 text 작업을 입력해 주세요.",
        );
        return;
      }
      const currentQuestion = context.getQuestion();
      let question: AssistantTextQuestion | undefined,
        label = text;
      const resolveSelection = () => {
        if (!selection) return;
        const active = context.getCandidateQuestion(Date.now());
        const message = messages.find(
          (item) => item.id === selection.messageId,
        );
        const execution =
          message?.role === "assistant" ? message.apiExecution : undefined;
        if (
          !active ||
          execution?.kind !== "completed" ||
          execution.reference.serverId !== serverId ||
          execution.reference.requestId.toLowerCase() !==
            active.requestId.toLowerCase() ||
          execution.response.data.result.kind !== "candidate_selection" ||
          execution.response.data.result.questionId !== active.questionId ||
          !active.candidateIds.includes(selection.candidateId)
        )
          return;
        const candidate = execution.response.data.result.candidates.find(
          (item) => item.candidateId === selection.candidateId,
        );
        return candidate ? { question: active, candidate } : undefined;
      };
      const selected = resolveSelection();
      const resolveConfirmation = () => {
        if (!confirmation || typeof confirmation.approved !== "boolean") return;
        const active = context.getConfirmationQuestion(Date.now());
        const message = messages.find(
          (item) => item.id === confirmation.messageId,
        );
        const execution =
          message?.role === "assistant" ? message.apiExecution : undefined;
        if (
          !active ||
          execution?.kind !== "completed" ||
          execution.reference.serverId !== serverId ||
          execution.reference.requestId.toLowerCase() !==
            active.requestId.toLowerCase() ||
          execution.response.data.result.kind !== "confirmation" ||
          execution.response.data.result.questionId.toLowerCase() !==
            active.questionId.toLowerCase()
        )
          return;
        return active;
      };
      const confirmed = resolveConfirmation();
      if (voice) {
        if (!voice.isCurrent()) return;
        question = voice.question;
        label = "";
      } else if (selection) {
        if (!selected) return;
        question = selected.question;
        const candidate = assistantCandidateToDisplay(selected.candidate);
        label = `${candidate.title} · ${formatAssistantCardDateTime(candidate.date, candidate.time)} · ${candidate.category}`;
      } else if (confirmation) {
        if (!confirmed) return;
        question = confirmed;
        label = confirmation.approved ? "예" : "아니요";
      } else if (acknowledgedId) {
        // 인지 버튼은 다음 입력을 새 독립 작업으로 시작하겠다는 명시적 의사다. 과거 질문에 인지 ID를 붙이지 않는다.
        question = undefined;
      } else if (typeof currentQuestion === "string") {
        reportError(
          currentQuestion === "unsupported"
            ? "현재 질문은 후보 선택 또는 확인이 필요해요."
            : "현재 질문을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요.",
        );
        return;
      } else question = currentQuestion;
      const requestId = Crypto.randomUUID();
      if (!action && !acknowledgedId) {
        const latest = context.getQuestion();
        if (typeof latest === "string") return;
        question = latest;
      }
      const body = voice ? null : parseAssistantRequestCreate({
        requestId,
        ...(acknowledgedId
          ? { acknowledgedUncertainRequestId: acknowledgedId }
          : {}),
        ...(question ? { conversationId: question.conversationId } : {}),
        input: confirmation
          ? {
              type: "confirmation",
              questionId: question?.questionId,
              approved: confirmation.approved,
            }
          : selection
            ? {
                type: "selection",
                questionId: question?.questionId,
                candidateId: selection.candidateId,
              }
            : {
                type: "text",
                text,
                ...(question ? { questionId: question.questionId } : {}),
              },
      });
      if (!voice && (!body || !validateAssistantJsonBodySize(JSON.stringify(body)).ok)) {
        reportError("메시지 형식이나 크기를 확인해 주세요.");
        return;
      }
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId)
        return;
      if (!canStart()) return;
      // 본문을 만든 사이 질문이 바뀌었으면 오래된 ID로 보내지 않고 입력을 남긴다.
      if (
        acknowledgedId
          ? uncertain.acknowledgmentForNewText() !== acknowledgedId
          : uncertain.isHeld() ||
            (voice
              ? !voice.isCurrent()
              : selection
              ? JSON.stringify(selected?.question) !==
                JSON.stringify(resolveSelection()?.question)
              : confirmation
                ? JSON.stringify(confirmed) !==
                  JSON.stringify(resolveConfirmation())
                : JSON.stringify(question) !==
                  JSON.stringify(context.getQuestion()))
      )
        return;
      const timedQuestion = voice?.question?.expiresAt ? voice.question : selected?.question ?? confirmed;
      const inputController = action ? new AbortController() : undefined;
      if (inputController && timedQuestion) {
        const remaining = Date.parse(timedQuestion.expiresAt!) - Date.now();
        if (remaining <= 0) return;
        // 저장 장벽 대기 중 만료되면 기존 HTTP의 AbortSignal 검사로 실제 전송을 막는다. 서버 취소는 아니다.
        const timer = setTimeout(
          () => {
            if (
              !assistantHttpClient.hasAcceptanceEvidence({
                serverId,
                requestId,
              })
            )
              inputController.abort();
          },
          Math.min(2_147_483_647, remaining),
        );
        clearInputExpiry = () => clearTimeout(timer);
      }
      pendingInputRef.current = label;
      localVoice.discard();
      inputUiRef.current = voice ? { source: "voice", phase: "recognizing" } : { source: "text" };
      setInputUi(inputUiRef.current);
      if (!voice) setMessages((current) => [
        ...current,
        { id: requestId, role: "user", text: label, serverId },
      ]);
      if (!action) {
        inputTextRef.current = "";
        setInputText("");
      }
      setStatus("processing");
      context.beginRequest(
        requestId,
        question,
        selection?.candidateId,
        confirmation?.approved,
        voice?.token ?? false,
      );
      if (acknowledgedId) uncertain.begin(requestId, acknowledgedId);
      syncUncertainUi(uncertain);
      syncQuestionUi(context);
      // 저장 장벽·GET-first·polling·재전송은 기존 orchestration에만 맡긴다.
      const executionOptions: AssistantExecutionOptions & { expectedServerId: string } = {
        expectedServerId: serverId,
        signal: inputController?.signal,
        onUpdate: (event) => {
          if (
            !isCurrent() ||
            assistantHttpClient.getServerId() !== serverId ||
            event.reference.serverId !== serverId ||
            event.reference.requestId.toLowerCase() !== requestId.toLowerCase()
          )
            return;
          if (event.phase === "status") {
            postAccepted = true;
            clearInputExpiry?.();
            if (voice) {
              // A replay/GET cannot reconstruct STT text; never guess or POST it as text.
              setMessages(current => {
                if (current.some(message => message.role === "user" && message.serverId === serverId && message.id === requestId)) return current;
                const noticeId = `voice-original-unavailable-${requestId}`;
                if (event.acceptance) return [...current.filter(message => message.id !== noticeId),
                  { id: requestId, role: "user", serverId, text: event.acceptance.transcript }];
                return current.some(message => message.id === noticeId) ? current : [...current,
                  { id: noticeId, role: "assistant", serverId, text: "음성 요청을 확인했어요. 음성 원문은 복구할 수 없어요." }];
              });
              inputUiRef.current = { source: "text" }; setInputUi(inputUiRef.current);
            }
            for (const target of (!body && !event.acceptance ? [] : assistantAcceptedCleanup(
              body ?? { requestId, ...(question ? { conversationId: question.conversationId } : {}),
                input: event.acceptance!.input },
              event,
              question,
            ))) {
              void cleanupWithEvidence(
                target.reference,
                target.evidence,
                () =>
                  isCurrent() && assistantHttpClient.getServerId() === serverId,
              );
            }
            context.observeResponse(event.response.data, "request", question);
            const response = event.response,
              data = response.data;
            uncertain.observe(
              data.status === "completed"
                ? {
                    kind: "completed",
                    reference: event.reference,
                    response: { ...response, data },
                  }
                : {
                    kind: "observed",
                    reference: event.reference,
                    response: { ...response, data },
                  },
              "request",
            );
            syncUncertainUi(uncertain);
            syncQuestionUi(context);
          }
        },
      };
      if (voice) voicePayload = createAssistantVoicePayload(voice.owner, { requestId,
        ...(question ? { conversationId: question.conversationId, questionId: question.questionId } : {}) },
        () => isCurrent() && voice.isCurrent());
      if (voice) {
        const reference = { serverId, requestId };
        voiceExecution = { reference, generation, version, token: voice.token,
          previouslyAccepted: assistantHttpClient.hasAcceptanceEvidence(reference) };
        voiceExecutionRef.current = voiceExecution;
      }
      const task = voicePayload ? assistantOrchestrator.startVoiceRequest(voicePayload, executionOptions) :
        assistantOrchestrator.startRequest(body!, executionOptions);
      if (!isCurrent()) {
        task.cancel();
        return;
      }
      if (voice) context.setVoiceTransmission(voice.token, task.getVoiceTransmission ?? (() => undefined));
      serverTaskRef.current = task;
      const execution = await task.completion;
      clearInputExpiry?.();
      if (!isCurrent() || assistantHttpClient.getServerId() !== serverId) {
        if (voice) context.observeVoiceInterruption(execution, voice.token, question);
        return;
      }
      context.observeExecution(execution, "request", question);
      if (
        acknowledgedId &&
        assistantHttpClient.hasAcceptanceEvidence({ serverId, requestId })
      ) {
        postAccepted = true;
        uncertain.accepted(requestId);
      }
      uncertain.observe(execution, "request");
      uncertain.finish(execution);
      syncUncertainUi(uncertain);
      syncQuestionUi(context);
      if (execution.kind === "completed") {
        completed = true;
        // 원본 처리 결과를 메시지에 보존하고 상세 표시는 ConversationList에 맡긴다.
        setMessages((current) =>
          upsertAssistantExecutionMessage(current, execution, "request"),
        );
      } else {
        reportError(
          "요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.",
          execution,
        );
        const error = getAssistantExecutionError(execution);
        speechNotRecognized = !!voice && error?.problem?.code === "SPEECH_NOT_RECOGNIZED";
        if (
          question &&
          (!voice || execution.kind === "needs-attention" && execution.recoveryResult?.kind === "unconfirmed" && execution.recoveryResult.definitiveRejection) &&
          error?.kind === "http" &&
          error.operation === "post" &&
          error.status === 409 &&
          ["QUESTION_EXPIRED", "CONVERSATION_EXPIRED"].includes(
            error.problem?.code ?? "",
          )
        ) {
          void cleanupWithEvidence(
            { serverId, requestId: question.requestId },
            { type: "question-inactive-confirmed", reason: "expired" },
            () => isCurrent() && assistantHttpClient.getServerId() === serverId,
          );
        }
        const target = getAssistantErrorRecoveryTarget(
          execution,
          acknowledgedId,
        );
        if (target) {
          const token = context.getRecoveryToken();
          const updateRecovery = (
            status: AssistantErrorRecoveryNotice["status"],
            result?: AssistantExecutionResult,
          ) => {
            if (!isCurrent() || assistantHttpClient.getServerId() !== serverId)
              return;
            setMessages((current) =>
              current.map((message) =>
                message.role === "assistant" &&
                message.apiExecution?.reference.serverId === serverId &&
                message.apiExecution.reference.requestId.toLowerCase() ===
                  requestId.toLowerCase()
                  ? {
                      ...message,
                      apiErrorRecovery: {
                        targetRequestId: target.requestId,
                        kind: target.kind,
                        status,
                        result,
                      },
                    }
                  : message,
              ),
            );
          };
          updateRecovery("checking");
          // 단발 GET은 기존 서버 경계·공유 요청 잠금을 사용하며 새 polling·POST를 만들지 않는다.
          const recoveryTask = assistantOrchestrator.queryRequestOnce({
            serverId,
            requestId: target.requestId,
          });
          serverTaskRef.current = recoveryTask;
          const recovered = await recoveryTask.completion;
          if (!isCurrent() || assistantHttpClient.getServerId() !== serverId)
            return;
          if (token !== context.getRecoveryToken()) {
            updateRecovery("context-changed", recovered);
          } else if (
            recovered.kind === "needs-attention" &&
            recovered.reason === "busy"
          ) {
            updateRecovery("busy", recovered);
          } else {
            setMessages((current) =>
              upsertAssistantExecutionMessage(current, recovered, "recovery"),
            );
            if (target.kind === "uncertain")
              uncertain.observe(recovered, "manual");
            else uncertain.observe(recovered, "recovery");
            syncUncertainUi(uncertain);
            const restored =
              target.kind === "question" &&
              target.questionId &&
              (body?.conversationId ?? question?.conversationId) &&
              context.restoreActiveQuestion(
                recovered,
                {
                  requestId: target.requestId,
                  questionId: target.questionId,
                  conversationId: (body?.conversationId ?? question?.conversationId)!,
                },
                token,
                Date.now(),
              );
            syncQuestionUi(context);
            updateRecovery(
              recovered.kind === "needs-attention"
                ? "unconfirmed"
                : target.kind === "question"
                  ? restored
                    ? "restored"
                    : "mismatch"
                  : "observed",
              recovered,
            );
          }
        }
      }
    } catch {
      if (isCurrent()) {
        // 표시 실패는 새 POST의 근거가 아니다. 원래 복구 기록도 정리하지 않는다.
        try {
          reportError(
            "응답을 확인하지 못했어요. 원래 요청의 결과 확인이 필요해요.",
          );
        } catch {}
      }
    } finally {
      clearInputExpiry?.();
      if (voice) {
        if (voicePayload) void voicePayload.dispose();
        else { void disposeVoiceFile(voice.owner).then(result => { if (result !== "deleted") void retryVoiceFileCleanup(); }); }
      }
      if (voiceExecution && voiceExecutionRef.current === voiceExecution) voiceExecutionRef.current = null;
      if (mountedRef.current && operationVersionRef.current === version) {
        // 새로 작성했다가 지운 초안도 이전 요청의 실패 입력으로 덮어쓰지 않는다.
        if (
          !action &&
          !completed &&
          (!acknowledgmentAttempt || !postAccepted) &&
          inputRevisionRef.current === revision
        )
          restoreInput(text);
        serverTaskRef.current = null;
        if (voice) {
          activeVoiceRef.current = false;
          const next: AssistantInputUi = speechNotRecognized ? { source: "voice", phase: "stt-error" } : { source: "text" };
          inputUiRef.current = next; setInputUi(next);
        }
        finishOperation();
      }
    }
  };

  useEffect(() => { void retryVoiceFileCleanup(); }, []);
  useLayoutEffect(() => {
    voiceSubmissionRef.current = () => {
      if (Platform.OS !== "ios" || scheduleDataModeStore.getState().mode !== "server") return;
      const serverId = assistantHttpClient.getServerId(), generation = scheduleDataModeStore.getState().generation;
      if (!serverId || !voiceStartAllowedRef.current()) return;
      void retryVoiceFileCleanup();
      const context = getTextQuestionContext(serverId), question = context.getVoiceQuestion(Date.now());
      if (typeof question === "string") return;
      let valid = true, handed = false;
      const token = Symbol("voice-recording-submission");
      const isCurrent = () => valid && mountedRef.current && assistantHttpClient.getServerId() === serverId &&
        scheduleDataModeStore.getState().mode === "server" && scheduleDataModeStore.getState().generation === generation &&
        JSON.stringify(context.getVoiceQuestion(Date.now())) === JSON.stringify(question);
      return {
        isCurrent,
        complete(owner) {
          if (handed || !isCurrent()) { void disposeVoiceFile(owner); return; }
          handed = true;
          void sendServerInput({ type: "voice", token, owner, question, isCurrent });
        },
        invalidate(updateUi = true) {
          valid = false;
          context.holdVoiceAnswer(token);
          if (updateUi && mountedRef.current) syncQuestionUi(context);
          const execution = voiceExecutionRef.current;
          if (activeVoiceRef.current && (!execution || execution.token === token)) {
            if (execution && !execution.previouslyAccepted && execution.version === operationVersionRef.current &&
              (serverTaskRef.current?.getVoiceTransmission?.()?.postCount ?? 0) > 0 &&
              execution.generation === generation && scheduleDataModeStore.getState().generation === generation &&
              scheduleDataModeStore.getState().mode === "server" &&
              execution.reference.serverId === serverId && assistantHttpClient.getServerId() === serverId &&
              assistantHttpClient.hasAcceptanceEvidence(execution.reference)) {
              assistantLifecycle.deferRecovery?.(execution.reference, generation);
            }
            if (voiceExecutionRef.current === execution) voiceExecutionRef.current = null;
            serverTaskRef.current?.cancel();
            operationVersionRef.current++;
            serverTaskRef.current = null; activeVoiceRef.current = false;
            sendLockedRef.current = false;
            if (updateUi && mountedRef.current) { setIsBusy(false); setStatus("idle"); inputUiRef.current = { source: "text" }; setInputUi(inputUiRef.current); }
          }
        },
      };
    };
  });

  const checkUncertain = async (
    requestId: string,
    expectedServerId?: string,
    expectedGeneration?: number,
  ) => {
    if (
      !mountedRef.current ||
      sendLockedRef.current ||
      isMockScheduleMode() ||
      !expectedServerId ||
      assistantHttpClient.getServerId() !== expectedServerId ||
      scheduleDataModeStore.getState().generation !== expectedGeneration
    )
      return;
    const recovery = assistantLifecycle.getSnapshot();
    if (
      recovery.serverId !== expectedServerId ||
      recovery.initialCheck === "pending"
    ) {
      reportRecoveryIssue(recovery, expectedServerId);
      return;
    }
    const uncertain = getUncertainContext(expectedServerId),
      targetId = uncertain.getCheckTarget(requestId);
    if (!targetId) return;
    sendLockedRef.current = true;
    setIsBusy(true);
    setStatus("processing");
    const version = ++operationVersionRef.current,
      token = uncertain.token(requestId);
    const current = () =>
      mountedRef.current &&
      operationVersionRef.current === version &&
      !isMockScheduleMode() &&
      assistantHttpClient.getServerId() === expectedServerId &&
      scheduleDataModeStore.getState().generation === expectedGeneration;
    try {
      const task = assistantOrchestrator.queryRequestOnce({
        serverId: expectedServerId,
        requestId: targetId,
      });
      serverTaskRef.current = task;
      const result = await task.completion;
      if (!current() || token !== uncertain.token(requestId)) return;
      if (result.kind === "needs-attention" && result.reason === "busy") {
        reportError(
          "기존 조회가 진행 중이에요. 중복 조회하지 않고 결과를 기다려 주세요.",
        );
        return;
      }
      uncertain.observe(result, "manual");
      const context = getTextQuestionContext(expectedServerId);
      context.observeExecution(result, "recovery");
      syncQuestionUi(context);
      syncUncertainUi(uncertain);
      setMessages((messages) =>
        upsertAssistantExecutionMessage(messages, result, "recovery", {
          uncertainRecheck: true,
        }),
      );
    } catch {
      if (current())
        reportError(
          "원래 요청을 확인하지 못했어요. 기존 요청을 다시 보내지 않고 결과 확인이 필요해요.",
        );
    } finally {
      if (mountedRef.current && operationVersionRef.current === version) {
        serverTaskRef.current = null;
        finishOperation();
      }
    }
  };

  const acknowledgeUncertain = (
    requestId: string,
    expectedServerId?: string,
    expectedGeneration?: number,
  ) => {
    if (
      !mountedRef.current ||
      sendLockedRef.current ||
      isMockScheduleMode() ||
      !expectedServerId ||
      assistantHttpClient.getServerId() !== expectedServerId ||
      scheduleDataModeStore.getState().generation !== expectedGeneration
    )
      return;
    const context = getUncertainContext(expectedServerId);
    if (context.arm(requestId)) syncUncertainUi(context);
  };

  const handleRecoveryAction = async (
    control: AssistantRecoveryControl,
    action: AssistantRecoveryControlAction,
    viewServerId: string | null,
    generation: number,
    displayCurrent?: () => boolean,
  ) => {
    const reference = { ...control.reference },
      key = assistantRecoveryKey(reference);
    const inCurrentView = () =>
      mountedRef.current &&
      !isMockScheduleMode() &&
      scheduleDataModeStore.getState().generation === generation &&
      assistantHttpClient.getServerId() === viewServerId &&
      (displayCurrent?.() ?? true);
    if (!inCurrentView() || cleanupLocksRef.current.has(key)) return;
    const currentSnapshot = assistantLifecycle.getSnapshot();
    const recoveringTarget = recoveringRecord(currentSnapshot, key);
    if ((action === "manual" || action === "confirm-manual") && recoveringTarget) return;
    if (action === "manual") {
      const metadata = assistantRecoveryStorage.read(reference).catch(() => null);
      manualConfirmationsRef.current.set(key, {
        serverId: viewServerId,
        generation,
        snapshot: currentSnapshot,
        metadata,
      });
      publishCleanup(reference, "confirming");
      return;
    }
    if (action === "keep") {
      manualConfirmationsRef.current.delete(key);
      setCleanupStates((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return;
    }
    const execution = () =>
      committedMessagesRef.current.find(
        (message) =>
          message.role === "assistant" &&
          message.apiExecution &&
          assistantRecoveryKey(message.apiExecution.reference) === key,
      );
    const latestExecution = () => {
      const message = execution();
      return message?.role === "assistant" ? message.apiExecution : undefined;
    };
    const matchesDisplayed = () =>
      inCurrentView() &&
      reference.serverId === viewServerId &&
      control.executionToken !== undefined &&
      JSON.stringify(latestExecution()) === control.executionToken;
    let evidence: AssistantRecoveryCleanupEvidence | undefined;
    let manualMetadata: Promise<AssistantRecoveryMetadata | null> | undefined;
    if (action === "result") {
      const result = latestExecution();
      const data =
        result?.kind === "completed" &&
        parseAssistantRequestStatusResponse(result.response.data);
      if (
        !matchesDisplayed() ||
        !data ||
        data.status !== "completed" ||
        data.requestId.toLowerCase() !== reference.requestId.toLowerCase() ||
        !["outcome", "failure"].includes(data.result.kind)
      )
        return;
    } else if (action === "expiry") {
      const result = latestExecution();
      if (
        !matchesDisplayed() ||
        !result ||
        !(evidence = assistantRequestExpiryEvidence(result))
      )
        return;
    } else if (action === "confirm-manual") {
      const confirmation = manualConfirmationsRef.current.get(key);
      if (
        !confirmation ||
        confirmation.serverId !== viewServerId ||
        confirmation.snapshot !== currentSnapshot || confirmation.generation !== generation
      )
        return;
      manualMetadata = confirmation.metadata;
      manualConfirmationsRef.current.delete(key);
    } else return;
    cleanupLocksRef.current.add(key);
    if (!displayCurrent) publishCleanup(reference, "working");
    try {
      const expectedMetadata = manualMetadata && await manualMetadata;
      if (action === "confirm-manual" && !expectedMetadata) {
        if (inCurrentView()) publishCleanup(reference, "failed");
        return;
      }
      const result =
        action === "result"
          ? await assistantOrchestrator.confirmResultDisplayed(reference, {
              isCurrent: matchesDisplayed,
            })
          : action === "expiry"
            ? await assistantRecoveryStorage.cleanup(
                reference,
                reference.serverId,
                evidence!,
                { isCurrent: matchesDisplayed },
              )
            : await assistantRecoveryStorage.removeManually(
                reference,
                { confirmed: true },
                { isCurrent: () => inCurrentView() && assistantLifecycle.getSnapshot() === currentSnapshot, expectedMetadata: expectedMetadata ?? undefined },
              );
      if (inCurrentView()) {
        publishCleanup(reference, result, Boolean(displayCurrent));
        setCleanupRevision((value) => value + 1);
      }
      return result;
    } catch {
      if (inCurrentView()) publishCleanup(reference, "failed");
    } finally {
      cleanupLocksRef.current.delete(key);
    }
  };

  const retryScheduleSync = async (
    reference: AssistantRecoveryReference,
    viewServerId: string | null,
    generation: number,
  ) => {
    const ref = {
        serverId: reference.serverId,
        requestId: reference.requestId,
      },
      key = assistantRecoveryKey(ref);
    const current = () =>
      mountedRef.current &&
      !isMockScheduleMode() &&
      ref.serverId === viewServerId &&
      assistantHttpClient.getServerId() === viewServerId &&
      scheduleDataModeStore.getState().generation === generation;
    if (!current() || scheduleSyncRetryLocksRef.current.has(key)) return;
    const entry = assistantScheduleSync
      .getSnapshot()
      .find((value) => assistantRecoveryKey(value.reference) === key);
    if (
      !entry ||
      (!["refresh-error", "interrupted"].includes(entry.phase) &&
        entry.detail?.phase !== "error")
    )
      return;
    const message = committedMessagesRef.current.find(
      (value) =>
        value.role === "assistant" &&
        value.apiExecution &&
        assistantRecoveryKey(value.apiExecution.reference) === key,
    );
    const execution =
      message?.role === "assistant" ? message.apiExecution : undefined;
    const data =
      execution?.kind === "completed"
        ? parseAssistantRequestStatusResponse(execution.response.data)
        : null;
    if (
      !data ||
      data.status !== "completed" ||
      data.requestId.toLowerCase() !== ref.requestId.toLowerCase() ||
      data.result.kind !== "outcome" ||
      data.result.outcome !== "success" ||
      data.result.operation === "list" ||
      !data.result.schedulesChanged
    )
      return;
    const syncToken = Symbol(); scheduleSyncRetryLocksRef.current.set(key, syncToken);
    setRetryingScheduleSync([...scheduleSyncRetryLocksRef.current.keys()]);
    try {
      // 반환된 과거 상태를 메시지에 덮지 않는다. 최신 상태는 구독을 통해서만 읽는다.
      await assistantScheduleSync.retry(ref, { generation });
    } catch {
      // 기존 실패 안내를 유지한다. 표시 예외가 Assistant POST나 Schedule write의 근거가 되지 않는다.
      if (current())
        setScheduleSyncSnapshot(assistantScheduleSync.getSnapshot());
    } finally {
      if (scheduleSyncRetryLocksRef.current.get(key) === syncToken) scheduleSyncRetryLocksRef.current.delete(key);
      // 이 호출의 로컬 잠금만 해제하며 다른 요청의 메시지·입력·처리 상태는 변경하지 않는다.
      if (mountedRef.current)
        setRetryingScheduleSync([...scheduleSyncRetryLocksRef.current.keys()]);
    }
  };

  const handleSend = () => {
    if (!viewCurrent()) return;
    if (isVoiceInputBusy(inputUiRef.current) || localVoice.isBusy()) return;
    if (!isMockScheduleMode()) {
      void sendServerInput();
      return;
    }
    const text = inputTextRef.current.trim();
    if (
      !mountedRef.current ||
      !text ||
      sendLockedRef.current ||
      status === "processing"
    )
      return;
    sendLockedRef.current = true;
    setIsBusy(true);
    operationVersionRef.current += 1;
    pendingInputRef.current = text;

    try {
      localVoice.discard();
      const message: ConversationMessage = {
        id: Crypto.randomUUID(),
        role: "user",
        text,
      };
      setMessages((current) => [...current, message]);
      inputTextRef.current = "";
      setInputText("");
      if (!isMockScheduleMode()) {
        clearMockOperation();
        return;
      }
      setInputUi({ source: "text" });
      mockTextPendingRef.current = true;
      setStatus("processing");
    } catch {
      restoreInput(text);
      reportError("메시지를 전송하지 못했어요. 다시 시도해 주세요.");
      finishOperation();
    }
  };

  const handleInteraction = (
    messageId: string,
    action:
      | { type: "candidate"; scheduleId: string }
      | { type: "confirmation"; confirmed: boolean },
  ) => {
    if (!viewCurrent() || !mountedRef.current) return;
    if (!isMockScheduleMode()) return;
    if (
      !mountedRef.current ||
      isVoiceInputBusy(inputUiRef.current) || localVoice.isBusy() ||
      sendLockedRef.current ||
      status === "processing" ||
      activeInteractionIdRef.current !== messageId ||
      resolvedInteractionIdsRef.current.has(messageId)
    )
      return;
    const message = messages.find((item) => item.id === messageId);
    if (
      message?.role !== "assistant" ||
      !message.interaction ||
      message.interaction.resolved
    )
      return;
    const interaction = message.interaction;
    if (
      action.type === "candidate" &&
      (interaction.type !== "candidate-selection" ||
        !interaction.candidates.some(
          (candidate) => candidate.scheduleId === action.scheduleId,
        ))
    )
      return;
    if (
      action.type === "confirmation" &&
      interaction.type !== "delete-confirmation"
    )
      return;

    sendLockedRef.current = true;
    setIsBusy(true);
    const version = ++operationVersionRef.current;
    const generation = scheduleDataModeStore.getState().generation;
    const before = useScheduleStore.getState().schedules;
    let confirmationHandled = false;
    try {
      const result: { text: string; interaction?: AssistantInteraction } =
        action.type === "candidate"
          ? createMockDeleteConfirmation(action.scheduleId)
          : resolveMockDeleteConfirmation(
              (
                interaction as Extract<
                  typeof interaction,
                  { type: "delete-confirmation" }
                >
              ).scheduleId,
              action.confirmed,
            );
      if (
        operationVersionRef.current !== version ||
        !isMockScheduleMode(generation)
      )
        return;
      confirmationHandled = action.type === "confirmation";
      publishResponse(
        {
          id: Crypto.randomUUID(),
          role: "assistant",
          text: result.text,
          interaction: result.interaction,
        },
        true,
      );
    } catch {
      if (operationVersionRef.current !== version) return;
      const changed = useScheduleStore.getState().schedules !== before;
      if (changed || confirmationHandled) invalidateActiveInteraction();
      if (changed) pendingMockRef.current = null;
      reportError(
        changed || confirmationHandled
          ? "확인 처리 후 응답을 표시하지 못했어요. 일정 목록을 확인해 주세요."
          : "요청을 처리하지 못했어요. 다시 선택하거나 확인해 주세요.",
      );
    } finally {
      if (operationVersionRef.current === version) finishOperation();
    }
  };

  const mockMode = isMockScheduleMode(),
    currentServerId = assistantHttpClient.getServerId();
  const cleanupGeneration = scheduleDataModeStore.getState().generation;
  const nextCleanupScope = JSON.stringify([
    mockMode ? "mock" : "server",
    currentServerId,
    cleanupGeneration,
  ]);
  // 서버 경계가 바뀐 render에서는 이전 확인 UI를 커밋하기 전에 해당 화면 상태만 초기화한다.
  if (cleanupScope !== nextCleanupScope) {
    setCleanupScope(nextCleanupScope);
    setCleanupStates({});
  }
  useEffect(() => {
    manualConfirmationsRef.current.clear();
  }, [mockMode, currentServerId, cleanupGeneration]);
  useEffect(() => {
    if (mockMode) return;
    let subscribed = true;
    const current = () =>
      subscribed &&
      mountedRef.current &&
      !isMockScheduleMode() &&
      assistantHttpClient.getServerId() === currentServerId &&
      scheduleDataModeStore.getState().generation === cleanupGeneration;
    // 다른 서버의 기록도 수동 정리 대상으로 읽기만 하며 해당 서버로 통신하지 않는다.
    void assistantRecoveryStorage
      .readAll()
      .then((records) => {
        if (!current()) return;
        setRecoveryRecords((previous) =>
          JSON.stringify(previous) === JSON.stringify(records)
            ? previous
            : records,
        );
        setRecoveryReadError(false);
      })
      .catch(() => {
        if (current()) setRecoveryReadError(true);
      });
    return () => {
      subscribed = false;
    };
  }, [messages, mockMode, currentServerId, cleanupGeneration, cleanupRevision]);
  const recoveryMatches =
    !mockMode && recoverySnapshot.serverId === currentServerId;
  const recoveryPending =
    !mockMode &&
    currentServerId !== null &&
    (Boolean(recoverySnapshot.handoff) || ((!recoveryMatches || recoverySnapshot.initialCheck === "pending") &&
    ["idle", "recovering", "observing"].includes(recoverySnapshot.phase)));
  const recoveryProcessing =
    recoveryMatches &&
    ["recovering", "observing"].includes(recoverySnapshot.phase) &&
    recoverySnapshot.results.some(
      (entry) =>
        entry.reference.serverId === currentServerId &&
        entry.latestResult?.kind !== "needs-attention" &&
        entry.lastResponse?.data.status !== "completed" &&
        Boolean(entry.lastResponse),
    );
  const visibleMessages = messages.filter((message) => {
    const serverId =
      message.serverId !== undefined
        ? message.serverId
        : message.role === "assistant"
          ? message.apiExecution?.reference.serverId
          : undefined;
    return mockMode
      ? serverId === undefined
      : serverId !== undefined && serverId === currentServerId;
  });
  const cleanupReferences = new Map(
    recoveryRecords.map((record) => [
      assistantRecoveryKey(record),
      { serverId: record.serverId, requestId: record.requestId },
    ]),
  );
  for (const [key, value] of Object.entries(cleanupStates))
    cleanupReferences.set(key, value.reference);
  const recoveryControls: AssistantRecoveryControl[] = mockMode
    ? []
    : [...cleanupReferences].filter(([key]) => !recoveringRecord(recoverySnapshot, key) &&
        !(cleanupStates[key]?.automatic && ["removed", "not-found"].includes(cleanupStates[key].phase))).map(([key, reference]) => {
        const message = visibleMessages.find(
          (message) =>
            message.role === "assistant" &&
            message.apiExecution &&
            assistantRecoveryKey(message.apiExecution.reference) === key,
        );
        const execution =
          message?.role === "assistant" ? message.apiExecution : undefined;
        const sameServer = reference.serverId === currentServerId;
        return {
          reference,
          phase: cleanupStates[key]?.phase,
          executionToken: execution ? JSON.stringify(execution) : undefined,
          resultConfirmable:
            sameServer &&
            execution?.kind === "completed" &&
            ["outcome", "failure"].includes(
              execution.response.data.result.kind,
            ),
          expiryConfirmable:
            sameServer &&
            Boolean(execution && assistantRequestExpiryEvidence(execution)),
        };
      });
  const questionView =
    !mockMode &&
    questionUi?.serverId === currentServerId &&
    questionUi.generation === scheduleDataModeStore.getState().generation
      ? questionUi
      : null;
  const activeCandidate = questionView?.active;
  const activeConfirmation = questionView?.confirmation;
  const uncertainView =
    !mockMode &&
    uncertainUi?.serverId === currentServerId &&
    uncertainUi.generation === scheduleDataModeStore.getState().generation
      ? uncertainUi
      : null;
  const timedQuestion = activeCandidate ?? activeConfirmation;
  const timedRequestId = timedQuestion?.requestId,
    timedExpiresAt = timedQuestion?.expiresAt;
  useEffect(() => {
    if (!timedExpiresAt) return;
    const timer = setTimeout(
      () => {
        const context = textQuestionRef.current;
        if (context) syncQuestionUi(context);
      },
      Math.min(
        2_147_483_647,
        Math.max(0, Date.parse(timedExpiresAt) - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [timedRequestId, timedExpiresAt, syncQuestionUi]);

  const voiceStartAllowed = !isBusy && status !== "processing" && !recoveryPending && !recoveryProcessing &&
    (Platform.OS !== "ios" || mockMode || questionView?.voiceAvailable !== false) &&
    !uncertainView?.held && ((!activeCandidate && !activeConfirmation) || Platform.OS === "ios" && !mockMode) &&
    (mockMode || (currentServerId !== null && recoveryMatches && recoverySnapshot.initialCheck === "checked"));
  useLayoutEffect(() => {
    voiceStartAllowedRef.current = () => mountedRef.current && !sendLockedRef.current && !serverTaskRef.current && voiceStartAllowed &&
      (Platform.OS !== "ios" || isMockScheduleMode() || !currentServerId || getTextQuestionContext(currentServerId).getVoiceQuestion(Date.now()) !== "unavailable");
  }, [voiceStartAllowed, currentServerId, getTextQuestionContext]);

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
          messages={
            visibleMessages.length === messages.length
              ? messages
              : visibleMessages
          }
          isProcessing={
            status === "processing" || recoveryPending || recoveryProcessing
          }
          showProcessingNotice={!voiceInputBusy}
          interactionsDisabled={
            isBusy || status === "processing" || voiceInputBusy
          }
          activeApiCandidate={
            !recoveryPending && !isBusy && !uncertainView?.held
              ? activeCandidate
              : undefined
          }
          apiCandidateSelections={questionView?.selections}
          onApiCandidateSelection={(messageId, candidateId) => {
            if (!isMockScheduleMode())
              void sendServerInput({
                type: "selection",
                messageId,
                candidateId,
              });
          }}
          activeApiConfirmation={
            !recoveryPending && !isBusy && !uncertainView?.held
              ? activeConfirmation
              : undefined
          }
          apiConfirmations={questionView?.confirmations}
          expiredApiConfirmations={questionView?.expiredConfirmations}
          onApiConfirmation={(messageId, approved) => {
            if (!isMockScheduleMode())
              void sendServerInput({
                type: "confirmation",
                messageId,
                approved,
              });
          }}
          uncertainViews={uncertainView?.views}
          scheduleSyncEntries={
            mockMode
              ? []
              : scheduleSyncSnapshot.filter(
                  (entry) => entry.reference.serverId === currentServerId && (entry.generation === undefined || entry.generation === cleanupGeneration),
                )
          }
          retryingScheduleSync={retryingScheduleSync}
          onScheduleSyncRetry={(reference) => {
            void retryScheduleSync(
              reference,
              currentServerId,
              cleanupGeneration,
            );
          }}
          recoveryControls={recoveryControls}
          onResultDisplayed={(result) => {
            const control = recoveryControls.find(
              (value) =>
                assistantRecoveryKey(value.reference) ===
                assistantRecoveryKey(result.reference),
            );
            const message = committedMessagesRef.current.find(
              (value) => value.id === result.messageId,
            );
            if (
              !control?.resultConfirmable ||
              control.executionToken !== result.executionToken ||
              message?.role !== "assistant" ||
              !message.apiExecution ||
              JSON.stringify(message.apiExecution) !== result.executionToken ||
              !result.isCurrent()
            )
              return Promise.resolve(false);
            return handleRecoveryAction(
              control,
              "result",
              currentServerId,
              cleanupGeneration,
              result.isCurrent,
            ).then((status) => status === "removed" || status === "not-found");
          }}
          recoveryStorageError={!mockMode && recoveryReadError}
          onRecoveryAction={(control, action) => {
            void handleRecoveryAction(
              control,
              action,
              currentServerId,
              cleanupGeneration,
            );
          }}
          onUncertainCheck={(requestId) => {
            void checkUncertain(
              requestId,
              uncertainView?.serverId,
              uncertainView?.generation,
            );
          }}
          onUncertainAcknowledge={(requestId) =>
            acknowledgeUncertain(
              requestId,
              uncertainView?.serverId,
              uncertainView?.generation,
            )
          }
          onDeleteConfirmation={(messageId, confirmed) =>
            handleInteraction(messageId, { type: "confirmation", confirmed })
          }
          onCandidateSelection={(messageId, scheduleId) =>
            handleInteraction(messageId, { type: "candidate", scheduleId })
          }
        />
        <VoiceInputStatus input={inputUi} />
        <MessageInput
          onFocus={() => conversationListRef.current?.prepareForKeyboard()}
          value={inputText}
          onChangeText={(text) => {
            if (!viewCurrent()) return;
            inputRevisionRef.current += 1;
            inputTextRef.current = text;
            setInputText(text);
          }}
          onSend={handleSend}
          onStartVoice={() => { void localVoice.start(); }}
          onStopVoice={() => { void localVoice.stop(); }}
          disabled={
            isBusy ||
            status === "processing" ||
            recoveryPending ||
            voiceInputBusy
          }
          isRecording={
            inputUi.source === "voice" && inputUi.phase === "recording"
          }
          voiceDisabled={!localVoice.supported ||
            (!(inputUi.source === "voice" && inputUi.phase === "recording") && !voiceStartAllowed)}
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
