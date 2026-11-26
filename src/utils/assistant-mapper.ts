import type {
  AssistantCandidate,
  AssistantConfirmationChanges,
  AssistantRequestStatusResponse,
  AssistantResult,
  AssistantResultConfirmation,
  AssistantResultOutcome,
  AssistantScheduleSummary,
} from "@/types/assistant-api";
import type { Schedule } from "@/types/schedule";
import { scheduledAtToUiDateTime, toUiCategory } from "@/utils/schedule-mapper";

// 후보에는 Schedule ID·완료 여부가 없다. Mock의 scheduleId로 변환하지 않는다.
export type AssistantCandidateDisplay = Pick<Schedule, "title" | "date" | "time" | "category"> &
  Pick<AssistantCandidate, "candidateId" | "scheduledAt">;

// 기존 일정 카드의 Schedule 필드를 제공하되 서버 원본 시각도 보존한다.
export type AssistantScheduleDisplay = Schedule & Pick<AssistantScheduleSummary, "scheduledAt" | "updatedAt">;

export type AssistantConfirmationChangesDisplay = Partial<Pick<Schedule, "title" | "category" | "completed">> & {
  scheduledAt?: string;
  date?: string;
  time?: string;
};

export type AssistantConfirmationDisplay = Pick<AssistantResultConfirmation, "kind" | "text" | "questionId" | "expiresAt"> & {
  target: AssistantScheduleDisplay;
} & (
  | { operation: "update"; changes: AssistantConfirmationChangesDisplay }
  | { operation: "delete"; changes?: never }
);

type ListOutcome = Extract<AssistantResultOutcome, { operation: "list"; outcome: "success" }>;
export type AssistantOutcomeDisplay = Exclude<AssistantResultOutcome, ListOutcome> |
  (Omit<ListOutcome, "items"> & { items: AssistantScheduleDisplay[] });

export type AssistantResultDisplay =
  | Exclude<AssistantResult, { kind: "candidate_selection" | "confirmation" | "outcome" }>
  | (Omit<Extract<AssistantResult, { kind: "candidate_selection" }>, "candidates"> & { candidates: AssistantCandidateDisplay[] })
  | AssistantConfirmationDisplay
  | AssistantOutcomeDisplay;

export type AssistantRequestDisplay = Pick<AssistantRequestStatusResponse, "requestId" | "conversationId"> & (
  | { status: "accepted" | "processing"; result?: never }
  | { status: "completed"; result: AssistantResultDisplay }
);

// 공개 validator를 통과한 DTO를 받는다. 표시 값만 도출하며 원본·식별값을 정규화하지 않는다.
export function assistantCandidateToDisplay(dto: AssistantCandidate): AssistantCandidateDisplay {
  return {
    candidateId: dto.candidateId,
    title: dto.title,
    scheduledAt: dto.scheduledAt,
    ...scheduledAtToUiDateTime(dto.scheduledAt),
    category: toUiCategory(dto.category),
  };
}

export function assistantScheduleSummaryToDisplay(dto: AssistantScheduleSummary): AssistantScheduleDisplay {
  return {
    id: dto.id,
    title: dto.title,
    scheduledAt: dto.scheduledAt,
    ...scheduledAtToUiDateTime(dto.scheduledAt),
    category: toUiCategory(dto.category),
    completed: dto.completed,
    updatedAt: dto.updatedAt,
  };
}

export function assistantConfirmationChangesToDisplay(changes: AssistantConfirmationChanges): AssistantConfirmationChangesDisplay {
  return {
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.category !== undefined ? { category: toUiCategory(changes.category) } : {}),
    ...(changes.completed !== undefined ? { completed: changes.completed } : {}),
    ...(changes.scheduledAt !== undefined ? {
      scheduledAt: changes.scheduledAt,
      ...scheduledAtToUiDateTime(changes.scheduledAt),
    } : {}),
  };
}

export function assistantConfirmationToDisplay(result: AssistantResultConfirmation): AssistantConfirmationDisplay {
  const base = {
    kind: result.kind, text: result.text, questionId: result.questionId, expiresAt: result.expiresAt,
    target: assistantScheduleSummaryToDisplay(result.target),
  };
  // 변경 후 일정을 합성하거나 delete에 changes를 보충하지 않는다.
  return result.operation === "delete" ? { ...base, operation: "delete" } : {
    ...base, operation: "update", changes: assistantConfirmationChangesToDisplay(result.changes),
  };
}

export function assistantOutcomeToDisplay(result: AssistantResultOutcome): AssistantOutcomeDisplay {
  if (result.outcome === "success") {
    if (result.operation === "list") return { ...result, items: result.items.map(assistantScheduleSummaryToDisplay) };
    const affectedScheduleIds: [string] = [result.affectedScheduleIds[0]];
    return { ...result, affectedScheduleIds };
  }
  return { ...result };
}

export function assistantResultToDisplay(result: AssistantResult): AssistantResultDisplay {
  switch (result.kind) {
    case "candidate_selection": return { ...result, candidates: result.candidates.map(assistantCandidateToDisplay) };
    case "confirmation": return assistantConfirmationToDisplay(result);
    case "outcome": return assistantOutcomeToDisplay(result);
    case "need_more_info":
    case "failure":
    case "uncertain": return { ...result };
    default: {
      const unreachable: never = result;
      throw new RangeError(`지원하지 않는 Assistant 결과 형식입니다 (${typeof unreachable}).`);
    }
  }
}

// API 상태를 UI AssistantStatus나 성공 여부로 바꾸지 않고 서버의 연결 정보만 보존한다.
export function assistantRequestStatusToDisplay(response: AssistantRequestStatusResponse): AssistantRequestDisplay {
  const base = { requestId: response.requestId, conversationId: response.conversationId };
  return response.status === "completed"
    ? { ...base, status: "completed", result: assistantResultToDisplay(response.result) }
    : { ...base, status: response.status };
}
