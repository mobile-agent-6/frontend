import type { ConversationMessage } from "@/components/assistant/conversation-list";
import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import type { AssistantRecoveryReference } from "@/types/assistant-recovery";

const sameRequest = (a: AssistantRecoveryReference, b: AssistantRecoveryReference) =>
  a.serverId === b.serverId && a.requestId.toLowerCase() === b.requestId.toLowerCase();

// 표시 중복 제거만 담당한다. 영속 복구 정보 정리·요청 실행과는 무관하다.
export function upsertAssistantExecutionMessage(messages: ConversationMessage[], execution: AssistantExecutionResult,
  source: "request" | "recovery"): ConversationMessage[] {
  const index = messages.findIndex(message => message.role === "assistant" && message.apiExecution &&
    sameRequest(message.apiExecution.reference, execution.reference));
  const previous = index < 0 ? undefined : messages[index];
  if (previous?.role === "assistant") {
    const old = previous.apiExecution;
    // 단방향 처리 상태와 더 최근의 복구 GET 관측을 늦은 최초 요청 callback으로 되돌리지 않는다.
    if (execution.kind === "observed" && (old?.kind === "completed" ||
      old?.kind === "observed" && old.response.data.status === "processing" && execution.response.data.status === "accepted")) return messages;
    if (source === "request" && previous.apiSource === "recovery" && (old?.kind === "completed" ||
      old?.kind === "needs-attention" && old.recoveryResult?.kind === "unconfirmed" && old.recoveryResult.getResult)) return messages;
    if (execution.kind === "needs-attention" && source === "request" && old?.kind === "completed") return messages;
  }
  const text = execution.kind === "completed" ? execution.response.data.result.text
    : execution.kind === "observed" ? "서버에서 요청을 처리하고 있어요."
    : execution.reason === "deadline" ? "자동 확인 시간이 끝났어요. 요청 결과는 아직 확인이 필요해요."
    : "요청 결과를 확인하지 못했어요. 원래 요청의 확인이 필요해요.";
  const next: ConversationMessage = { id: previous?.id ?? (source === "request" ? `assistant-${execution.reference.requestId}` : `assistant-recovery-${JSON.stringify([
    execution.reference.serverId, execution.reference.requestId.toLowerCase(),
  ])}`), role: "assistant", serverId: execution.reference.serverId, text, apiExecution: execution, apiSource: source };
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return messages;
  if (index < 0) return [...messages, next];
  return messages.map((message, position) => position === index ? next : message);
}
