import type { AssistantExecutionResult } from "@/services/api/assistant-orchestrator";
import { getAssistantExecutionError } from "@/utils/assistant-errors";

type RiskState = "uncertain" | "pending" | "unknown" | "expired" | "resolved";
type Risk = { requestId: string; state: RiskState; acknowledged: boolean; revision: number; manualBarrier?: boolean };
export type AssistantUncertainView = {
  requestId: string; state: RiskState; acknowledged: boolean; armed: boolean; canAcknowledge: boolean;
  pendingRequestId?: string;
};

// 인지 의사·접수 증거는 현재 화면 실행 세션에만 둔다. 채팅·body·영속 복구 정보와 별개다.
export function createAssistantUncertainContext(serverId: string, generation: number) {
  const risks = new Map<string, Risk>();
  const submissions = new Map<string, { riskId: string; accepted: boolean }>();
  const ineligible = new Set<string>();
  const resolvedIds = new Set<string>();
  let blockingId: string | undefined, missingBlockingId = false, armedId: string | undefined;
  const keyOf = (id: string) => id.toLowerCase();

  function update(id: string, state: RiskState, manualBarrier = false) {
    const key = keyOf(id), previous = risks.get(key);
    if (previous?.state === "resolved" && state !== "resolved" || previous?.state === "expired" && state !== "resolved" && state !== "expired") return;
    if (previous?.state !== state) {
      risks.set(key, { requestId: id, state, acknowledged: previous?.acknowledged ?? false,
        revision: (previous?.revision ?? 0) + 1, manualBarrier });
      if (armedId === key) armedId = undefined;
    } else if (previous && manualBarrier) previous.manualBarrier = true;
    if ((state === "resolved" || state === "expired") && blockingId === key) blockingId = undefined;
  }

  function accepted(requestId: string) {
    const submission = submissions.get(keyOf(requestId));
    if (!submission || submission.accepted) return;
    submission.accepted = true;
    const risk = risks.get(submission.riskId);
    if (risk) { risk.acknowledged = true; risk.revision++; }
    if (blockingId === submission.riskId) blockingId = undefined;
    armedId = undefined;
  }

  function observe(execution: AssistantExecutionResult, source: "request" | "recovery" | "manual" = "recovery") {
    if (execution.reference.serverId !== serverId) return;
    const id = execution.reference.requestId, key = keyOf(id), previous = risks.get(key);
    if (execution.kind !== "needs-attention") {
      if (execution.response.serverId !== serverId || keyOf(execution.response.data.requestId) !== key) return;
      if (submissions.has(key)) accepted(id);
      if (execution.kind === "completed") {
        submissions.delete(key);
        const kind = execution.response.data.result.kind;
        if (kind === "uncertain") {
          if (!resolvedIds.has(key) && (!previous?.manualBarrier || source === "manual")) update(id, "uncertain");
        } else if (kind === "outcome" || kind === "failure") {
          // 먼저 확인한 확정 결과를 늦은 uncertain 관측으로 다시 보류하지 않는다.
          resolvedIds.add(key);
          if (previous || blockingId === key) update(id, "resolved");
        } else if (previous && source === "manual") update(id, "unknown", true);
      } else if (previous && source === "manual") update(id, "pending", true);
      return;
    }
    if (execution.lastResponse && submissions.has(key)) accepted(id);
    const error = getAssistantExecutionError(execution);
    if (previous && source === "manual") {
      const expired = error?.kind === "http" && error.operation === "get" && error.status === 410 && error.problem?.code === "REQUEST_EXPIRED";
      update(id, expired ? "expired" : "unknown", true);
    }
    if (error?.kind === "http" && error.operation === "get" && error.status === 410 && error.problem?.code === "REQUEST_EXPIRED") submissions.delete(key);
    if (error?.kind !== "http" || error.operation !== "post") return;
    if (error.problem?.code === "UNRESOLVED_UNCERTAIN") {
      armedId = undefined;
      blockingId = error.problem.blockingRequestId ? keyOf(error.problem.blockingRequestId) : undefined;
      missingBlockingId = !blockingId;
      if (blockingId) { ineligible.delete(blockingId); if (!risks.has(blockingId)) update(error.problem.blockingRequestId!, "unknown"); }
    } else if (error.problem?.code === "ACKNOWLEDGEMENT_NOT_APPLICABLE") {
      const submission = submissions.get(key);
      if (submission) ineligible.add(submission.riskId);
      armedId = undefined;
      if (error.problem.blockingRequestId) {
        blockingId = keyOf(error.problem.blockingRequestId); missingBlockingId = false;
        if (!risks.has(blockingId)) update(error.problem.blockingRequestId, "unknown");
      }
    }
  }

  function views(): AssistantUncertainView[] {
    return [...risks.entries()].map(([key, risk]) => {
      const pending = [...submissions.entries()].find(([, value]) => value.riskId === key);
      return { requestId: risk.requestId, state: risk.state, acknowledged: risk.acknowledged, armed: armedId === key,
        pendingRequestId: pending?.[0], canAcknowledge: risk.state === "uncertain" && !risk.acknowledged && submissions.size === 0 &&
          !missingBlockingId && (!blockingId || blockingId === key) && !ineligible.has(key) };
    }).filter(view => view.state !== "resolved" || view.pendingRequestId);
  }
  function isHeld() { return missingBlockingId || Boolean(blockingId) || submissions.size > 0 ||
    [...risks.values()].some(risk => !risk.acknowledged && !["resolved", "expired"].includes(risk.state)); }
  function arm(requestId: string): boolean {
    const view = views().find(value => keyOf(value.requestId) === keyOf(requestId));
    if (!view?.canAcknowledge || view.armed) return false;
    armedId = keyOf(requestId); return true;
  }
  function acknowledgmentForNewText(): string | undefined {
    const risk = armedId ? risks.get(armedId) : undefined;
    return risk && views().some(value => keyOf(value.requestId) === armedId && value.canAcknowledge) ? risk.requestId : undefined;
  }
  function begin(requestId: string, acknowledgedId: string) {
    submissions.set(keyOf(requestId), { riskId: keyOf(acknowledgedId), accepted: false }); armedId = undefined;
  }
  function finish(execution: AssistantExecutionResult) {
    const key = keyOf(execution.reference.requestId), submission = submissions.get(key);
    if (!submission || submission.accepted || execution.kind !== "needs-attention") return;
    const error = getAssistantExecutionError(execution);
    const recovery = execution.recoveryResult;
    const beforePostStorage = recovery?.kind === "unconfirmed" && recovery.reason === "storage" &&
      !recovery.postResult && !recovery.getResult && !execution.lastResponse;
    // GET을 보내지 못했다는 사실은 앞선 POST 미전송의 증거가 아니다.
    if (beforePostStorage || error?.operation === "post" && (error.requestState === "not-sent" || error.kind === "http")) {
      submissions.delete(key);
      if (views().some(view => keyOf(view.requestId) === submission.riskId && view.canAcknowledge)) armedId = submission.riskId;
    }
  }
  function getCheckTarget(id: string) {
    const view = views().find(value => keyOf(value.requestId) === keyOf(id));
    return view ? view.pendingRequestId ?? view.requestId : undefined;
  }
  function token(id: string) { const risk = risks.get(keyOf(id)); return JSON.stringify([risk?.revision, risk?.state, risk?.acknowledged]); }
  return { serverId, generation, observe, views, isHeld, arm, acknowledgmentForNewText, begin, finish, accepted, getCheckTarget, token };
}
