import type { ConversationMessage } from "@/components/assistant/conversation-list";
import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";
import { assistantHttpErrorNotice, getAssistantExecutionError } from "@/utils/assistant-errors";

export const ASSISTANT_CONNECTION_ERROR_NOTICE =
  "요청 결과를 확인하지 못했어요.\n\n네트워크 연결을 확인해 주세요.\n요청이 이미 처리되었을 수 있어요.";

const sameRequest = (a: AssistantRecoveryReference, b: AssistantRecoveryReference) =>
  a.serverId === b.serverId && a.requestId.toLowerCase() === b.requestId.toLowerCase();

// UI eligibility only. Transport, resend and recovery deadlines remain in the orchestrator.
function hasConnectionError(execution: AssistantExecutionResult): boolean {
  const error = getAssistantExecutionError(execution);
  return Boolean(error && ["network", "timeout"].includes(error.kind) &&
    !(error.operation === "post" && error.requestState === "not-sent"));
}

export function canRecheckAssistantMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant" || message.apiUncertain || !message.apiExecution) return false;
  const execution = message.apiExecution;
  if (execution.kind === "observed") return true;
  if (execution.kind !== "needs-attention") return false;
  if (execution.reason === "deadline") return true;
  return hasConnectionError(execution);
}

// 표시 중복 제거만 담당한다. 영속 복구 정보 정리·요청 실행과는 무관하다.
export function upsertAssistantExecutionMessage(messages: ConversationMessage[], execution: AssistantExecutionResult,
  source: "request" | "recovery", options: { uncertainRecheck?: boolean } = {}): ConversationMessage[] {
  const index = messages.findIndex(message => message.role === "assistant" && message.apiExecution &&
    sameRequest(message.apiExecution.reference, execution.reference));
  const previous = index < 0 ? undefined : messages[index];
  if (previous?.role === "assistant") {
    const old = previous.apiExecution;
    const oldError = old ? getAssistantExecutionError(old) : undefined;
    if (previous.apiUncertain && oldError?.operation === "get" && oldError.status === 410 &&
      oldError.problem?.code === "REQUEST_EXPIRED" && execution.kind === "completed") return messages;
    // 단방향 처리 상태와 더 최근의 복구 GET 관측을 늦은 최초 요청 callback으로 되돌리지 않는다.
    if (old?.kind === "completed" && ["outcome", "failure"].includes(old.response.data.result.kind) &&
      execution.kind === "completed" && execution.response.data.result.kind === "uncertain") return messages;
    if (previous.apiUncertain && old && old.kind !== "completed" && !options.uncertainRecheck &&
      execution.kind === "completed" && execution.response.data.result.kind === "uncertain") return messages;
    if (execution.kind === "observed" && (old?.kind === "completed" &&
      !(options.uncertainRecheck && old.response.data.result.kind === "uncertain") ||
      old?.kind === "observed" && old.response.data.status === "processing" && execution.response.data.status === "accepted")) return messages;
    if (source === "request" && previous.apiSource === "recovery" && (old?.kind === "completed" ||
      old?.kind === "needs-attention" && old.recoveryResult?.kind === "unconfirmed" && old.recoveryResult.getResult)) return messages;
    if (execution.kind === "needs-attention" && source === "request" && old?.kind === "completed") return messages;
  }
  const history = execution.kind === "completed" && ["outcome", "failure"].includes(execution.response.data.result.kind) ? undefined
    : execution.kind === "completed" && execution.response.data.result.kind === "uncertain" ? execution
    : previous?.role === "assistant" ? previous.apiUncertain : undefined;
  const error = getAssistantExecutionError(execution);
  const text = execution.kind === "completed" ? execution.response.data.result.text
    : execution.kind === "observed" ? "서버에서 요청을 처리하고 있어요."
    : execution.reason === "file" ? execution.voiceTransmission?.state === "not-sent"
      ? "녹음 파일을 읽거나 검증하지 못해 전송하지 않았어요. 다시 녹음해 주세요."
      : "녹음 파일을 읽거나 검증하지 못해 추가 전송하지 않았어요. 원래 요청의 결과 확인이 필요해요."
    : execution.reason === "deadline" ? "자동 확인 시간이 끝났어요. 요청 결과는 아직 확인이 필요해요."
    : history ? history.response.data.result.text
    : hasConnectionError(execution)
      ? ASSISTANT_CONNECTION_ERROR_NOTICE
    : error ? assistantHttpErrorNotice(error, execution.inputSource === "voice")
    : "요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.";
  const next: ConversationMessage = { ...(previous?.role === "assistant" && previous.apiErrorRecovery ? { apiErrorRecovery: previous.apiErrorRecovery } : {}),
    id: previous?.id ?? (source === "request" ? `assistant-${execution.reference.requestId}` : `assistant-recovery-${JSON.stringify([
    execution.reference.serverId, execution.reference.requestId.toLowerCase(),
    ])}`), role: "assistant", serverId: execution.reference.serverId, text, apiExecution: execution, apiSource: source,
    ...(history ? { apiUncertain: history } : {}) };
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return messages;
  if (index < 0) return [...messages, next];
  return messages.map((message, position) => position === index ? next : message);
}
