import type {
  AssistantCancelRequest,
  AssistantCancelResponse,
  AssistantCandidate,
  AssistantConfirmationChanges,
  AssistantInput,
  AssistantProblemDetails,
  AssistantRequestAcceptedResponse,
  AssistantRequestCreate,
  AssistantRequestStatusResponse,
  AssistantResult,
  AssistantScheduleSummary,
} from "@/types/assistant-api";
import type { ScheduleApiCategory } from "@/types/schedule";
import { parseScheduleApiDateTime, toUiCategory } from "@/utils/schedule-mapper";

// additionalProperties:false와 생략/null을 구분한다. 입력·응답을 보완하거나 정규화하지 않는다.
function isObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

const has = (value: object, key: string) => Object.hasOwn(value, key);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
function optional(value: Record<string, unknown>, key: string, validate: (value: unknown) => boolean) {
  return !has(value, key) || validate(value[key]);
}
function isArrayOf(value: unknown, validate: (item: unknown) => boolean): value is unknown[] {
  // every가 건너뛰는 빈 슬롯도 undefined로 검사한다.
  return Array.isArray(value) && Array.from(value).every(validate);
}

// 논리 요청/대화/질문은 v4, Schedule ID·HTTP 추적 ID는 OpenAPI의 uuid 형식만 검사한다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isAssistantUuidV4 = (value: unknown): value is string => isString(value) && value.length === 36 && UUID_V4.test(value);
const isUuid = (value: unknown) => isString(value) && value.length === 36 && UUID.test(value);

function isUtcDateTime(value: unknown) {
  if (!isString(value) || !value.endsWith("Z")) return false;
  try { parseScheduleApiDateTime(value); return true; } catch { return false; }
}
function isCategory(value: unknown) {
  if (!isString(value)) return false;
  try { toUiCategory(value as ScheduleApiCategory); return true; } catch { return false; }
}

// 로컬 검증 사유이며 API 오류 code가 아니다. 원문 길이를 검사하고 trim·변경하지 않는다.
export type AssistantTextValidation =
  | { ok: true }
  | { ok: false; reason: "type" | "length" | "surrogate" | "control-character" | "blank" };

export function validateAssistantText(value: unknown): AssistantTextValidation {
  if (!isString(value)) return { ok: false, reason: "type" };
  const characters = [...value];
  if (characters.length < 1 || characters.length > 500) return { ok: false, reason: "length" };
  if (characters.some((character) => {
    const point = character.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  })) return { ok: false, reason: "surrogate" };
  // Cc 중 TAB/LF/CR만 허용한다.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) {
    return { ok: false, reason: "control-character" };
  }
  if (/^\p{White_Space}+$/u.test(value)) return { ok: false, reason: "blank" };
  return { ok: true };
}

// 호출자가 직렬화한 실제 전송 JSON 문자열의 UTF-8 크기만 검사한다.
// JSON 문법·DTO 검증·JSON.stringify·전송은 별도 책임이며 공백·escape도 그대로 센다.
export function validateAssistantJsonBodySize(serializedJson: string):
  { ok: true; byteLength: number } | { ok: false; reason: "body-too-large"; byteLength: number } {
  let byteLength = 0;
  for (const character of serializedJson) {
    const point = character.codePointAt(0)!;
    byteLength += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return byteLength <= 16 * 1024 ? { ok: true, byteLength } : { ok: false, reason: "body-too-large", byteLength };
}

export function parseAssistantInput(value: unknown): AssistantInput | null {
  if (isObject(value, ["type", "text"], ["questionId"]) && value.type === "text" &&
    validateAssistantText(value.text).ok && optional(value, "questionId", isAssistantUuidV4)) return value as AssistantInput;
  if (isObject(value, ["type", "questionId", "candidateId"]) && value.type === "selection" &&
    isAssistantUuidV4(value.questionId) && isString(value.candidateId)) return value as AssistantInput;
  if (isObject(value, ["type", "questionId", "approved"]) && value.type === "confirmation" &&
    isAssistantUuidV4(value.questionId) && isBoolean(value.approved)) return value as AssistantInput;
  return null;
}

export function parseAssistantRequestCreate(value: unknown): AssistantRequestCreate | null {
  if (!isObject(value, ["requestId", "input"], ["conversationId", "acknowledgedUncertainRequestId"]) ||
    !isAssistantUuidV4(value.requestId) || !optional(value, "conversationId", isAssistantUuidV4) ||
    !optional(value, "acknowledgedUncertainRequestId", isAssistantUuidV4)) return null;
  const input = parseAssistantInput(value.input);
  if (!input) return null;
  if ((input.type !== "text" || has(input, "questionId")) && !has(value, "conversationId")) return null;
  if (has(value, "acknowledgedUncertainRequestId") && (input.type !== "text" || has(input, "questionId"))) return null;
  return value as AssistantRequestCreate;
}

export function parseAssistantCandidate(value: unknown): AssistantCandidate | null {
  return isObject(value, ["candidateId", "title", "scheduledAt", "category"]) &&
    isString(value.candidateId) && isString(value.title) && isUtcDateTime(value.scheduledAt) && isCategory(value.category)
    ? value as AssistantCandidate : null;
}

export function parseAssistantScheduleSummary(value: unknown): AssistantScheduleSummary | null {
  return isObject(value, ["id", "title", "scheduledAt", "category", "completed", "updatedAt"]) &&
    isUuid(value.id) && isString(value.title) && isUtcDateTime(value.scheduledAt) && isCategory(value.category) &&
    isBoolean(value.completed) && isUtcDateTime(value.updatedAt) ? value as AssistantScheduleSummary : null;
}

export function parseAssistantConfirmationChanges(value: unknown): AssistantConfirmationChanges | null {
  if (!isObject(value, [], ["title", "scheduledAt", "category", "completed"]) || Object.keys(value).length === 0) return null;
  if (!optional(value, "title", (title) => isString(title) && title.trim().length > 0 &&
    [...title].length <= 100 && !/\p{Cc}/u.test(title)) ||
    !optional(value, "scheduledAt", isUtcDateTime) || !optional(value, "category", isCategory) ||
    !optional(value, "completed", isBoolean)) return null;
  return value as AssistantConfirmationChanges;
}

export function parseAssistantResult(input: unknown): AssistantResult | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const question = ["kind", "text", "questionId"];
  switch (value.kind) {
    case "need_more_info":
      if (isObject(value, question) && isString(value.text) && isAssistantUuidV4(value.questionId)) return value as AssistantResult;
      break;
    case "candidate_selection":
      if (isObject(value, [...question, "expiresAt", "candidates"]) && isString(value.text) &&
        isAssistantUuidV4(value.questionId) && isUtcDateTime(value.expiresAt) &&
        isArrayOf(value.candidates, (candidate) => parseAssistantCandidate(candidate) !== null) &&
        value.candidates.length >= 2 && value.candidates.length <= 10) return value as AssistantResult;
      break;
    case "confirmation":
      if (isObject(value, [...question, "expiresAt", "operation", "target"], ["changes"]) &&
        isString(value.text) && isAssistantUuidV4(value.questionId) && isUtcDateTime(value.expiresAt) &&
        parseAssistantScheduleSummary(value.target) &&
        (value.operation === "update" ? parseAssistantConfirmationChanges(value.changes) !== null
          : value.operation === "delete" && !has(value, "changes"))) return value as AssistantResult;
      break;
    case "outcome":
      if (!isObject(value, ["kind", "text", "outcome", "schedulesChanged"], ["operation", "affectedScheduleIds", "items"]) ||
        !isString(value.text)) break;
      if (value.outcome === "success") {
        if (value.operation === "list") {
          if (value.schedulesChanged === false && !has(value, "affectedScheduleIds") &&
            isArrayOf(value.items, (item) => parseAssistantScheduleSummary(item) !== null)) return value as AssistantResult;
        } else if (isString(value.operation) && ["create", "update", "delete"].includes(value.operation) && value.schedulesChanged === true &&
          !has(value, "items") && isArrayOf(value.affectedScheduleIds, isUuid) &&
          value.affectedScheduleIds.length === 1) return value as AssistantResult;
      } else if ((value.outcome === "cancelled" || value.outcome === "no_match") && value.schedulesChanged === false &&
        !has(value, "items") && !has(value, "affectedScheduleIds") &&
        optional(value, "operation", (operation) => isString(operation) && ["create", "list", "update", "delete"].includes(operation))) {
        return value as AssistantResult;
      }
      break;
    case "failure":
      if (isObject(value, ["kind", "text", "code", "nextAction"]) && isString(value.text) && isString(value.code) && (
        (["MODEL_OUTPUT_INVALID", "SCHEDULE_REJECTED", "TARGET_AMBIGUOUS"].includes(value.code) && value.nextAction === "revise_input") ||
        (["MODEL_TIMEOUT", "SCHEDULE_UNAVAILABLE", "PROCESSING_INTERRUPTED", "PROCESSING_TIMEOUT"].includes(value.code) && value.nextAction === "retry_later") ||
        (value.code === "INTERNAL_ERROR" && value.nextAction === "none"))) return value as AssistantResult;
      break;
    case "uncertain":
      if (isObject(value, ["kind", "text", "code", "nextAction"]) && isString(value.text) &&
        value.code === "EXECUTION_RESULT_UNKNOWN" && value.nextAction === "check_status") return value as AssistantResult;
  }
  return null;
}

export function parseAssistantRequestAcceptedResponse(value: unknown): AssistantRequestAcceptedResponse | null {
  return isObject(value, ["requestId", "conversationId", "status"]) && isAssistantUuidV4(value.requestId) &&
    isAssistantUuidV4(value.conversationId) && value.status === "accepted" ? value as AssistantRequestAcceptedResponse : null;
}

export function parseAssistantRequestStatusResponse(value: unknown): AssistantRequestStatusResponse | null {
  if (!isObject(value, ["requestId", "conversationId", "status"], ["result"]) ||
    !isAssistantUuidV4(value.requestId) || !isAssistantUuidV4(value.conversationId)) return null;
  return (value.status === "completed" ? parseAssistantResult(value.result) !== null
    : (value.status === "accepted" || value.status === "processing") && !has(value, "result"))
    ? value as AssistantRequestStatusResponse : null;
}

function isCancelTarget(value: unknown) {
  return isObject(value, ["type", "id"]) && (value.type === "request" || value.type === "question") && isAssistantUuidV4(value.id);
}
export function parseAssistantCancelRequest(value: unknown): AssistantCancelRequest | null {
  return isObject(value, ["target"]) && isCancelTarget(value.target) ? value as AssistantCancelRequest : null;
}
export function parseAssistantCancelResponse(value: unknown): AssistantCancelResponse | null {
  return isObject(value, ["target", "targetState", "text"]) && isCancelTarget(value.target) && isString(value.text) &&
    isString(value.targetState) && ["cancelled", "not_guaranteed", "already_completed", "uncertain", "not_active"].includes(value.targetState)
    ? value as AssistantCancelResponse : null;
}

export function parseAssistantProblemDetails(value: unknown): AssistantProblemDetails | null {
  const recovery = ["assistantRequestId", "blockingRequestId", "activeQuestionId", "activeQuestionRequestId"];
  if (!isObject(value, ["type", "title", "status", "detail", "instance", "code", "requestId"], ["errors", ...recovery]) ||
    !["type", "title", "detail", "instance", "code"].every((key) => isString(value[key])) || !isUuid(value.requestId) ||
    !Number.isInteger(value.status) || Number(value.status) < 400 || Number(value.status) > 599 ||
    !recovery.every((key) => optional(value, key, (id) => id === null || isAssistantUuidV4(id)))) return null;
  if (has(value, "errors") && value.errors !== null) {
    if (!isArrayOf(value.errors, (item) => {
      if (!isObject(item, ["location", "code", "detail"], ["pointer", "parameter"]) ||
        !isString(item.code) || !isString(item.detail) ||
        !optional(item, "pointer", (field) => field === null || isString(field)) ||
        !optional(item, "parameter", (field) => field === null || isString(field))) return false;
      return item.location === "body" ? isString(item.pointer)
        : isString(item.location) && ["query", "header", "path"].includes(item.location) && isString(item.parameter);
    })) return null;
  }
  if (value.code === "VALIDATION_ERROR" && (!Array.isArray(value.errors) || value.errors.length === 0)) return null;
  return value as AssistantProblemDetails;
}
