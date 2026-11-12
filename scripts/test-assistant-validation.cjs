/* global __dirname: readonly */
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

// 기존 회귀 테스트처럼 설치된 TS로 메모리에서만 변환한다. native·HTTP 모듈은 로드하지 않는다.
function loadValidation() {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
    }).outputText;
    const resolve = (name) => {
      assert.ok(name.startsWith("@/utils/"), `순수 유틸리티 외 런타임 의존 금지: ${name}`);
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function("require", "module", "exports", "fetch", code)(resolve, module, module.exports,
      () => { throw new Error("실제 네트워크 요청 금지"); });
    return module.exports;
  }
  return load(path.join(root, "src/utils/assistant-validation.ts"));
}

const v = loadValidation();
const requestId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const questionId = "44444444-4444-4444-8444-444444444444";
// Schedule ID·HTTP 추적 ID는 논리 요청 ID와 달리 v4로 제한하지 않는다.
const scheduleId = "77777777-7777-5777-8777-777777777777";
const utc = "2026-10-18T06:00:00Z";
const candidate = { candidateId: "opaque:/선택 값", title: "반품 검수", scheduledAt: utc, category: "RETURN" };
const summary = { id: scheduleId, title: "반품 검수", scheduledAt: utc, category: "RETURN", completed: false, updatedAt: utc };
const question = { text: "몇 시로 등록할까요?", questionId };
const needMore = { kind: "need_more_info", ...question };
const selection = { kind: "candidate_selection", ...question, expiresAt: utc,
  candidates: [candidate, { ...candidate, candidateId: "another", scheduledAt: "2026-10-19T06:00:00Z" }] };
const confirmation = { kind: "confirmation", ...question, expiresAt: utc,
  operation: "update", target: summary, changes: { scheduledAt: "2026-10-18T07:00:00Z" } };
const write = { kind: "outcome", text: "변경했어요.", outcome: "success", operation: "update",
  schedulesChanged: true, affectedScheduleIds: [scheduleId] };
const list = { kind: "outcome", text: "조회했어요.", outcome: "success", operation: "list", schedulesChanged: false, items: [summary] };
const failure = { kind: "failure", text: "입력을 확인해 주세요.", code: "MODEL_OUTPUT_INVALID", nextAction: "revise_input" };
const uncertain = { kind: "uncertain", text: "결과를 확인해 주세요.", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" };
const problem = { type: "https://example.invalid/problems/stale-question", title: "test", status: 409,
  detail: "test", instance: "/api/v1/assistant/requests", code: "STALE_QUESTION", requestId: scheduleId };
const accepted = { requestId, conversationId, status: "accepted" };

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
function rejects(parser, values) {
  for (const value of values) assert.equal(parser(value), null, JSON.stringify(value));
}
function accepts(parser, values) {
  for (const value of values) assert.equal(parser(value), value, "검증 결과는 원본 DTO이며 보완·정규화하지 않는다.");
}

test("UUID v4: canonical 형식·RFC variant·대문자 허용, 잘못된 버전/끝문자 거부", () => {
  assert.equal(v.isAssistantUuidV4(requestId), true);
  assert.equal(v.isAssistantUuidV4("ABCDEF12-ABCD-4ABC-BABC-ABCDEF123456"), true);
  for (const value of [null, 1, [], scheduleId, requestId.replace("-4111-", "-1111-"),
    requestId.replace("-8111-", "-7111-"), requestId.replace("-8111-", "-c111-"),
    requestId.replaceAll("-", ""), `${requestId}\n`, ` ${requestId}`, `${requestId}g`]) {
    assert.equal(v.isAssistantUuidV4(value), false);
  }
});

test("text: trim 전 Unicode 코드 포인트 1~500자, emoji·결합 문자의 경계", () => {
  for (const value of ["가", "😀".repeat(500), "가".repeat(500), "a".repeat(499) + " ", "  입력  ", "e\u0301"]) {
    assert.deepEqual(v.validateAssistantText(value), { ok: true });
  }
  for (const value of ["", "😀".repeat(501), "가".repeat(501), " " + "a".repeat(500)]) {
    assert.equal(v.validateAssistantText(value).reason, "length");
  }
  assert.equal(v.validateAssistantText(null).reason, "type");
});

test("text: Unicode 공백만 있는 입력 거부, 일반 텍스트의 TAB/LF/CR 허용", () => {
  for (const value of [" ", "\t\n\r", "\u3000", "\u00a0\u1680\u2003\u2028\u2029\u202f\u205f\u3000"]) {
    assert.equal(v.validateAssistantText(value).reason, "blank");
  }
  assert.equal(v.validateAssistantText("질문\t답변\n다음\r줄").ok, true);
  assert.equal(v.validateAssistantText("\u200b").ok, true); // Cf를 Cc로 오인해 임의 금지하지 않는다.
});

test("text: 모든 금지 Cc와 짝이 맞지 않는 surrogate를 거부", () => {
  for (let point = 0; point <= 0x9f; point++) {
    if ((point <= 0x1f || point >= 0x7f) && ![9, 10, 13].includes(point)) {
      assert.equal(v.validateAssistantText(`a${String.fromCharCode(point)}b`).reason, "control-character");
    }
  }
  for (const value of ["\ud800", "\udfff", "\ud800a", "a\udc00", "\udc00\ud800", "😀\ud800"]) {
    assert.equal(v.validateAssistantText(value).reason, "surrogate");
  }
  assert.equal(v.validateAssistantText("\ud800\udc00").ok, true);
});

test("JSON body: 실제 직렬화 UTF-8 16 KiB 경계와 한글·emoji·escape·공백", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ text: "" }));
  const exact = JSON.stringify({ text: "가".repeat(5000) + "a".repeat(16384 - overhead - 15000) });
  assert.deepEqual(v.validateAssistantJsonBodySize(exact), { ok: true, byteLength: 16384 });
  assert.deepEqual(v.validateAssistantJsonBodySize(exact + " "), { ok: false, reason: "body-too-large", byteLength: 16385 });
  for (const serialized of [JSON.stringify({ text: "😀가\n\t\"\\\ud800" }), JSON.stringify({ text: "a" }, null, 2), "\ud800", "\u0000"]) {
    assert.equal(v.validateAssistantJsonBodySize(serialized).byteLength, Buffer.byteLength(serialized, "utf8"));
  }
  // 이 함수는 크기만 검사한다. DTO/JSON 문법을 검사하거나 body를 직렬화하지 않는다.
  assert.equal(v.validateAssistantJsonBodySize("not JSON").ok, true);
});

test("입력 3종: optional questionId·opaque candidateId·boolean approved", () => {
  accepts(v.parseAssistantInput, [{ type: "text", text: "질문" }, { type: "text", text: "답변", questionId },
    { type: "selection", questionId, candidateId: "not-a-UUID/선택" },
    { type: "selection", questionId, candidateId: "" }, // OpenAPI는 minLength를 정의하지 않는다.
    { type: "confirmation", questionId, approved: false }, { type: "confirmation", questionId, approved: true }]);
  rejects(v.parseAssistantInput, [null, [], { type: "voice", text: "질문" }, { type: "text", text: " " },
    { type: "text", text: "답", questionId: null }, { type: "text", text: "답", questionId: undefined },
    { type: "text", text: "답", unknown: true }, { type: "selection", questionId, candidateId: 1 },
    { type: "selection", candidateId: "id" }, { type: "confirmation", questionId, approved: "false" },
    { type: "confirmation", questionId, approved: null }]);
});

test("요청 DTO: 첫 입력·후속 입력·불확실 인지 범위와 optional null/undefined", () => {
  const first = { requestId, input: { type: "text", text: "  요청  " } };
  accepts(v.parseAssistantRequestCreate, [first, { ...first, conversationId },
    { ...first, acknowledgedUncertainRequestId: requestId },
    { requestId, conversationId, input: { type: "text", questionId, text: "답변" } },
    { requestId, conversationId, input: { type: "selection", questionId, candidateId: "opaque" } },
    { requestId, conversationId, input: { type: "confirmation", questionId, approved: false } }]);
  assert.equal(first.input.text, "  요청  ");
  rejects(v.parseAssistantRequestCreate, [without(first, "requestId"), { ...first, requestId: scheduleId },
    { ...first, conversationId: null }, { ...first, conversationId: undefined },
    { ...first, acknowledgedUncertainRequestId: null }, { ...first, unknown: true },
    { ...first, input: { type: "text", questionId, text: "답변" } },
    { ...first, input: { type: "selection", questionId, candidateId: "opaque" } },
    { requestId, conversationId, acknowledgedUncertainRequestId: requestId, input: { type: "text", questionId, text: "답변" } },
    { requestId, conversationId, acknowledgedUncertainRequestId: requestId, input: { type: "confirmation", questionId, approved: true } }]);
});

test("후보·일정 요약: 각자의 필수 필드와 카테고리, v5 일정 ID 보존", () => {
  accepts(v.parseAssistantCandidate, [candidate, { ...candidate, candidateId: "" }, { ...candidate, title: "" }]);
  accepts(v.parseAssistantScheduleSummary, [summary]);
  for (const category of ["INBOUND", "INVENTORY", "OUTBOUND", "RETURN", "OTHER"]) {
    assert.ok(v.parseAssistantCandidate({ ...candidate, category }));
    assert.ok(v.parseAssistantScheduleSummary({ ...summary, category }));
  }
  for (const key of Object.keys(candidate)) assert.equal(v.parseAssistantCandidate(without(candidate, key)), null);
  for (const key of Object.keys(summary)) assert.equal(v.parseAssistantScheduleSummary(without(summary, key)), null);
  rejects(v.parseAssistantCandidate, [{ ...candidate, candidateId: 1 }, { ...candidate, completed: false },
    { ...candidate, category: "반품" }, { ...candidate, category: ["RETURN"] }, { ...candidate, category: "toString" }]);
  rejects(v.parseAssistantScheduleSummary, [{ ...summary, id: "not-uuid" }, { ...summary, completed: 0 },
    { ...summary, createdAt: utc }, { ...summary, updatedAt: null }]);
});

test("UTC Z datetime: 실제 날짜·초·소수초 6자리·경계, offset/잘못된 날짜 거부", () => {
  for (const scheduledAt of [utc, "2028-02-29T23:59:59.123456Z", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z"]) {
    assert.ok(v.parseAssistantCandidate({ ...candidate, scheduledAt }));
  }
  for (const scheduledAt of [null, 0, "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "0000-01-01T00:00:00Z",
    "2026-10-18T06:00:00+00:00", "2026-10-18T15:00:00+09:00", "2026-10-18T06:00:00",
    "2026-10-18 06:00:00Z", "2026-10-18T24:00:00Z", "2026-10-18T06:00:60Z", "2026-10-18T06:00:00.1234567Z", `${utc}\n`]) {
    assert.equal(v.parseAssistantCandidate({ ...candidate, scheduledAt }), null, String(scheduledAt));
    assert.equal(v.parseAssistantScheduleSummary({ ...summary, updatedAt: scheduledAt }), null);
    assert.equal(v.parseAssistantResult({ ...selection, expiresAt: scheduledAt }), null);
    assert.equal(v.parseAssistantConfirmationChanges({ scheduledAt }), null);
  }
});

test("confirmation changes: 한 필드 이상, title 1~100 코드 포인트·Cc, false 보존", () => {
  accepts(v.parseAssistantConfirmationChanges, [{ title: "😀".repeat(100) }, { title: " 제목 " },
    { scheduledAt: utc }, { category: "OTHER" }, { completed: false },
    { title: "제목", scheduledAt: utc, category: "OTHER", completed: true }]);
  rejects(v.parseAssistantConfirmationChanges, [{}, null, [], { title: "" }, { title: "　 " },
    { title: "😀".repeat(101) }, { title: " " + "😀".repeat(100) }, { title: "제목\t" }, { title: "제목\u0085" },
    { title: null }, { category: undefined }, { completed: "false" }, { unknown: 1 }]);
});

test("질문 3종: 필수 questionId·expiresAt, 후보 2~10개, update/delete changes", () => {
  accepts(v.parseAssistantResult, [needMore, selection, confirmation]);
  assert.ok(v.parseAssistantResult(without({ ...confirmation, operation: "delete" }, "changes")));
  for (const length of [2, 10]) assert.ok(v.parseAssistantResult({ ...selection, candidates: Array.from({ length }, (_, i) => ({ ...candidate, candidateId: String(i) })) }));
  for (const length of [0, 1, 11]) assert.equal(v.parseAssistantResult({ ...selection, candidates: Array(length).fill(candidate) }), null);
  rejects(v.parseAssistantResult, [without(needMore, "questionId"), { ...needMore, expiresAt: utc },
    { ...needMore, questionId: scheduleId }, without(selection, "expiresAt"), { ...selection, candidates: [candidate, {}] },
    without(confirmation, "changes"), { ...confirmation, changes: {} }, { ...confirmation, changes: null },
    { ...confirmation, operation: "delete" }, { ...confirmation, operation: "delete", changes: undefined },
    { ...confirmation, operation: "create" }, { ...confirmation, target: candidate }]);
});

test("outcome: write 성공은 ID 하나·changed true, 조회는 items·false, 취소/대상 없음", () => {
  for (const operation of ["create", "update", "delete"]) assert.ok(v.parseAssistantResult({ ...write, operation }));
  accepts(v.parseAssistantResult, [list, { ...list, items: [] }]);
  for (const outcome of ["cancelled", "no_match"]) {
    for (const operation of [undefined, "create", "list", "update", "delete"]) {
      const result = { kind: "outcome", text: "안내", outcome, schedulesChanged: false };
      if (operation) result.operation = operation;
      assert.ok(v.parseAssistantResult(result));
      for (const extra of [{ items: [] }, { affectedScheduleIds: [] }, { schedulesChanged: true }, { operation: null }]) {
        assert.equal(v.parseAssistantResult({ ...result, ...extra }), null);
      }
    }
  }
  rejects(v.parseAssistantResult, [without(write, "operation"), without(write, "affectedScheduleIds"),
    { ...write, affectedScheduleIds: [] }, { ...write, affectedScheduleIds: [scheduleId, requestId] },
    { ...write, affectedScheduleIds: ["invalid"] }, { ...write, schedulesChanged: false }, { ...write, items: [] },
    { ...write, operation: ["create"] }, { ...write, operation: null }, { ...write, outcome: "failed" },
    without(list, "items"), { ...list, items: null }, { ...list, items: [candidate] },
    { ...list, affectedScheduleIds: undefined }, { ...list, schedulesChanged: true }]);
});

test("failure: 8개 code/nextAction 조합과 uncertain 고정 조합", () => {
  const combinations = {
    MODEL_OUTPUT_INVALID: "revise_input", SCHEDULE_REJECTED: "revise_input", TARGET_AMBIGUOUS: "revise_input",
    MODEL_TIMEOUT: "retry_later", SCHEDULE_UNAVAILABLE: "retry_later", PROCESSING_INTERRUPTED: "retry_later",
    PROCESSING_TIMEOUT: "retry_later", INTERNAL_ERROR: "none",
  };
  for (const [code, nextAction] of Object.entries(combinations)) {
    assert.ok(v.parseAssistantResult({ ...failure, code, nextAction }));
    for (const wrong of ["revise_input", "retry_later", "none", "check_status", null].filter(a=>a!==nextAction)) {
      assert.equal(v.parseAssistantResult({ ...failure, code, nextAction: wrong }), null);
    }
  }
  accepts(v.parseAssistantResult, [uncertain]);
  rejects(v.parseAssistantResult, [{ ...failure, code: "UNKNOWN" }, { ...failure, schedulesChanged: false },
    { ...uncertain, code: "PROCESSING_TIMEOUT" }, { ...uncertain, nextAction: "retry_later" },
    { ...uncertain, schedulesChanged: false }, without(uncertain, "text")]);
});

test("접수/상태 응답: accepted/processing에는 result 금지, completed에는 6종 결과 필수", () => {
  accepts(v.parseAssistantRequestAcceptedResponse, [accepted]);
  accepts(v.parseAssistantRequestStatusResponse, [accepted, { ...accepted, status: "processing" }]);
  for (const result of [needMore, selection, confirmation, write, failure, uncertain]) {
    assert.ok(v.parseAssistantRequestStatusResponse({ ...accepted, status: "completed", result }));
    assert.equal(v.parseAssistantRequestStatusResponse({ ...accepted, result }), null);
  }
  rejects(v.parseAssistantRequestStatusResponse, [{ ...accepted, result: null }, { ...accepted, result: undefined },
    { ...accepted, status: "processing", result: write }, { ...accepted, status: "completed" },
    { ...accepted, status: "completed", result: { ...write, kind: "unknown" } },
    { ...accepted, conversationId: null }, { ...accepted, requestId: scheduleId }, { ...accepted, status: ["accepted"] }]);
  rejects(v.parseAssistantRequestAcceptedResponse, [{ ...accepted, status: "processing" }, { ...accepted, result: write },
    without(accepted, "conversationId"), { ...accepted, requestId: null }]);
});

test("취소: request/question target과 5종 targetState, 신규 requestId·result 필드 없음", () => {
  for (const type of ["request", "question"]) {
    const target = { type, id: requestId };
    assert.ok(v.parseAssistantCancelRequest({ target }));
    for (const targetState of ["cancelled", "not_guaranteed", "already_completed", "uncertain", "not_active"]) {
      assert.ok(v.parseAssistantCancelResponse({ target, targetState, text: "안내" }));
    }
  }
  const target = { type: "request", id: requestId };
  rejects(v.parseAssistantCancelRequest, [{ target, requestId }, { target: { ...target, type: "conversation" } },
    { target: { ...target, id: scheduleId } }, { target: { ...target, unknown: true } }, { target: null }]);
  rejects(v.parseAssistantCancelResponse, [{ target, targetState: "accepted", text: "안내" },
    { target, targetState: "cancelled", text: null }, { target, targetState: "cancelled" },
    { target, targetState: "cancelled", text: "안내", result: null }]);
});

test("Problem: 선택적 복구 필드 각각의 생략/null/v4 허용과 잘못된 타입 거부", () => {
  accepts(v.parseAssistantProblemDetails, [problem, { ...problem, errors: null }, { ...problem, errors: [] },
    { ...problem, code: "FUTURE_SERVER_CODE" }]);
  for (const field of ["assistantRequestId", "blockingRequestId", "activeQuestionId", "activeQuestionRequestId"]) {
    for (const id of [null, requestId, requestId.toUpperCase()]) assert.ok(v.parseAssistantProblemDetails({ ...problem, [field]: id }));
    for (const id of [undefined, 1, "invalid", scheduleId]) assert.equal(v.parseAssistantProblemDetails({ ...problem, [field]: id }), null);
  }
  for (const key of Object.keys(problem)) assert.equal(v.parseAssistantProblemDetails(without(problem, key)), null);
  rejects(v.parseAssistantProblemDetails, [{ ...problem, status: 200 }, { ...problem, status: 600 },
    { ...problem, status: 409.5 }, { ...problem, status: "409" }, { ...problem, requestId: "trace" },
    { ...problem, errors: undefined }, { ...problem, errors: {} }, { ...problem, unknown: true }]);
});

test("Problem validation errors: body pointer/다른 location parameter와 optional nullable 필드", () => {
  const item = { location: "body", pointer: "", code: "REQUIRED", detail: "test" };
  const validation = { ...problem, status: 422, code: "VALIDATION_ERROR", errors: [item] };
  accepts(v.parseAssistantProblemDetails, [validation, { ...validation, errors: [{ ...item, parameter: null }] }]);
  for (const location of ["query", "header", "path"]) {
    assert.ok(v.parseAssistantProblemDetails({ ...validation, errors: [{ location, parameter: "id", pointer: null, code: "INVALID_VALUE", detail: "test" }] }));
  }
  rejects(v.parseAssistantProblemDetails, [without(validation, "errors"), { ...validation, errors: null }, { ...validation, errors: [] },
    ...[{ ...item, pointer: null }, without(item, "pointer"), { ...item, pointer: 1 }, { ...item, extra: 1 },
      { ...item, parameter: undefined }, { location: "path", code: "REQUIRED", detail: "test" },
      { location: ["query"], parameter: "id", code: "REQUIRED", detail: "test" }, { ...item, detail: null }]
      .map(error=>({ ...validation, errors: [error] }))]);
});

test("모든 응답 parser: null/배열/primitive·필수 누락·추가 필드를 거부하고 원본을 변경하지 않음", () => {
  const pairs = [[v.parseAssistantCandidate, candidate], [v.parseAssistantScheduleSummary, summary],
    [v.parseAssistantResult, needMore], [v.parseAssistantResult, selection], [v.parseAssistantResult, confirmation],
    [v.parseAssistantResult, write], [v.parseAssistantResult, failure], [v.parseAssistantResult, uncertain],
    [v.parseAssistantRequestAcceptedResponse, accepted], [v.parseAssistantRequestStatusResponse, { ...accepted, status: "completed", result: list }],
    [v.parseAssistantCancelResponse, { target: { type: "question", id: questionId }, targetState: "not_active", text: "안내" }],
    [v.parseAssistantProblemDetails, problem]];
  for (const [parser, dto] of pairs) {
    rejects(parser, [null, undefined, [], "text", 1, true, { ...dto, unexpected: true }]);
    const frozen = Object.freeze(structuredClone(dto));
    assert.equal(parser(frozen), frozen);
    for (const key of Object.keys(dto)) assert.equal(parser(without(dto, key)), null, key);
  }
});

test("배열의 빈 슬롯은 유효한 후보/일정/변경 ID/validation error로 통과하지 않음", () => {
  rejects(v.parseAssistantResult, [{ ...selection, candidates: new Array(2) },
    { ...list, items: new Array(1) }, { ...write, affectedScheduleIds: new Array(1) }]);
  assert.equal(v.parseAssistantProblemDetails({ ...problem, errors: new Array(1) }), null);
});

test("TypeScript DTO union: 잘못된 상태/result·changes·outcome·failure 조합은 컴파일 오류", () => {
  const file = path.join(root, "__assistant_type_contract__.ts");
  const source = `
    import type { AssistantRequestStatusResponse, AssistantResultConfirmation, AssistantResultOutcome,
      AssistantResultFailure, AssistantConfirmationChanges, AssistantRequestCreate } from './src/types/assistant-api';
    const accepted: AssistantRequestStatusResponse = { requestId:'id', conversationId:'id', status:'accepted' };
    const list: AssistantResultOutcome = { kind:'outcome', text:'', outcome:'success', operation:'list', schedulesChanged:false, items:[] };
    const first: AssistantRequestCreate = { requestId:'id', input:{type:'text', text:'request'} };
    // @ts-expect-error completed에는 result 필수
    const missingResult: AssistantRequestStatusResponse = { requestId:'id', conversationId:'id', status:'completed' };
    // @ts-expect-error accepted에 result 금지
    const extraResult: AssistantRequestStatusResponse = { ...accepted, result:list };
    // @ts-expect-error changes는 한 필드 이상
    const emptyChanges: AssistantConfirmationChanges = {};
    // @ts-expect-error delete에는 changes 금지
    const deleteChanges: AssistantResultConfirmation = {kind:'confirmation',text:'',questionId:'id',expiresAt:'date',target:{id:'id',title:'',scheduledAt:'date',category:'OTHER',completed:false,updatedAt:'date'},operation:'delete',changes:{completed:false}};
    // @ts-expect-error write 성공에는 정확히 하나의 ID 필요
    const noId: AssistantResultOutcome = {kind:'outcome',text:'',outcome:'success',operation:'create',schedulesChanged:true,affectedScheduleIds:[]};
    // @ts-expect-error list에는 변경 ID 금지
    const listId: AssistantResultOutcome = {...list, affectedScheduleIds:['id']};
    // @ts-expect-error code와 nextAction 조합
    const wrongAction: AssistantResultFailure = {kind:'failure',text:'',code:'MODEL_TIMEOUT',nextAction:'revise_input'};
    void first;
  `;
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const host = ts.createCompilerHost({ ...options, noEmit: true });
  const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host);
  host.readFile = p=>path.resolve(p) === file ? source : readFile(p);
  host.fileExists = p=>path.resolve(p) === file || fileExists(p);
  host.writeFile = ()=>{ throw new Error("테스트 산출물 생성 금지"); };
  const program = ts.createProgram([file], { ...options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")), []);
});
