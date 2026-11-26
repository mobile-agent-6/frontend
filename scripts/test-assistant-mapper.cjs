/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

// 설치된 TS로 메모리에서만 변환하며 HTTP·저장소·화면 모듈은 로드하지 않는다.
function loadUtilities() {
  const cache = new Map();
  function load(name) {
    assert.ok(name.startsWith("@/utils/"), `순수 유틸리티 외 의존 금지: ${name}`);
    const file = path.join(root, "src", `${name.slice(2)}.ts`);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
    }).outputText;
    new Function("require", "module", "exports", "fetch", code)(load, module, module.exports,
      ()=>{ throw new Error("실제 네트워크 요청 금지"); });
    return module.exports;
  }
  return { mapper: load("@/utils/assistant-mapper"), validator: load("@/utils/assistant-validation"),
    schedule: load("@/utils/schedule-mapper") };
}

const { mapper: m, validator: v, schedule: s } = loadUtilities();
const requestId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const questionId = "44444444-4444-4444-8444-444444444444";
const scheduleId = "77777777-7777-5777-8777-777777777777";
const scheduledAt = "2026-11-12T15:05:32.123456Z", expiresAt = "2026-11-13T00:10:00Z";
const candidate = { candidateId: "opaque:/선택 값", title: "  반품 검수  ", scheduledAt, category: "RETURN" };
const summary = { id: scheduleId, title: candidate.title, scheduledAt, category: "RETURN", completed: false,
  updatedAt: "2026-11-11T01:02:03.654321Z" };
const confirmation = (changes = { completed: true }) => ({ kind: "confirmation", text: "확인 문구", questionId,
  expiresAt, operation: "update", target: summary, changes });
const list = (items = [summary]) => ({ kind: "outcome", text: "서버 조회 문구", outcome: "success",
  operation: "list", schedulesChanged: false, items });
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function checked(parser, value) { assert.notEqual(parser(value), null); return freeze(value); }
const result = value => checked(v.parseAssistantResult, value);

test("Candidate: 불투명 candidateId와 원본 시각 보존, 없는 Schedule 필드 생성 금지", () => {
  const mapped = m.assistantCandidateToDisplay(checked(v.parseAssistantCandidate, { ...candidate }));
  assert.deepEqual(mapped, { ...candidate, category: "반품", date: "2026-11-13", time: "00:05" });
  for (const key of ["id", "scheduleId", "completed", "updatedAt", "createdAt"]) assert.equal(Object.hasOwn(mapped, key), false);
});

test("ScheduleSummary: 기존 카드 필드와 실제 일정 ID·updatedAt 보존, createdAt 보충 없음", () => {
  const mapped = m.assistantScheduleSummaryToDisplay(checked(v.parseAssistantScheduleSummary, { ...summary }));
  assert.deepEqual(mapped, { ...summary, category: "반품", date: "2026-11-13", time: "00:05" });
  assert.equal(Object.hasOwn(mapped, "createdAt"), false);
  assert.equal(Object.hasOwn(mapped, "candidateId"), false);
});

test("카테고리 5종은 기존 Schedule category 변환과 동일", () => {
  for (const [category, label] of [["INBOUND", "입고"], ["INVENTORY", "재고"], ["OUTBOUND", "출고"], ["RETURN", "반품"], ["OTHER", "기타"]]) {
    assert.equal(m.assistantCandidateToDisplay({ ...candidate, category }).category, label);
    assert.equal(m.assistantScheduleSummaryToDisplay({ ...summary, category }).category, label);
    assert.deepEqual(m.assistantConfirmationChangesToDisplay({ category }), { category: s.toUiCategory(category) });
  }
});

test("UTC Z → Asia/Seoul: 자정·정오·월말·연말·윤년·마이크로초 경계", () => {
  for (const [utc, date, time] of [
    ["2026-11-12T14:59:59.999999Z", "2026-11-12", "23:59"],
    ["2026-11-12T15:00:00Z", "2026-11-13", "00:00"],
    ["2026-11-12T03:00:00Z", "2026-11-12", "12:00"],
    ["2026-11-30T23:59:59Z", "2026-12-01", "08:59"],
    ["2026-12-31T15:00:00Z", "2027-01-01", "00:00"],
    ["2028-02-28T15:00:00Z", "2028-02-29", "00:00"],
  ]) {
    for (const mapped of [m.assistantCandidateToDisplay({ ...candidate, scheduledAt: utc }),
      m.assistantScheduleSummaryToDisplay({ ...summary, scheduledAt: utc }), m.assistantConfirmationChangesToDisplay({ scheduledAt: utc })]) {
      assert.equal(mapped.date, date); assert.equal(mapped.time, time); assert.equal(mapped.scheduledAt, utc);
    }
  }
});

test("기기 시간대가 UTC·뉴욕·서울이어도 동일한 서울 표시", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/New_York", "Asia/Seoul"]) {
      process.env.TZ = zone;
      const mapped = loadUtilities().mapper.assistantCandidateToDisplay(candidate);
      assert.equal(mapped.date, "2026-11-13"); assert.equal(mapped.time, "00:05");
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("confirmation update: target과 제시된 changes를 각각 변환하고 변경 후 일정 합성 없음", () => {
  const dto = result(confirmation({ title: "변경 제목", category: "OUTBOUND", completed: true,
    scheduledAt: "2026-12-31T15:00:00.000001Z" }));
  const mapped = m.assistantConfirmationToDisplay(dto);
  assert.equal(mapped.operation, "update"); assert.equal(mapped.questionId, questionId);
  assert.equal(mapped.expiresAt, expiresAt); assert.equal(mapped.text, dto.text);
  assert.deepEqual(mapped.target, m.assistantScheduleSummaryToDisplay(summary));
  assert.deepEqual(mapped.changes, { title: "변경 제목", category: "출고", completed: true,
    scheduledAt: dto.changes.scheduledAt, date: "2027-01-01", time: "00:00" });
  assert.equal(mapped.target.title, summary.title); assert.equal(mapped.target.completed, false);
});

for (const completed of [true, false]) test(`완료 상태 단독 변경: ${completed}를 update로 보존`, () => {
  const dto = result({ ...confirmation({ completed }), target: { ...summary, completed: !completed } });
  const mapped = m.assistantConfirmationToDisplay(dto);
  assert.equal(mapped.operation, "update"); assert.equal(mapped.target.completed, !completed);
  assert.deepEqual(mapped.changes, { completed });
});

test("선택 변경 필드는 존재하는 것만 변환하며 target으로 누락값을 채우지 않음", () => {
  for (const changes of [{ title: " 원문 제목 " }, { category: "OTHER" }, { completed: false }, { scheduledAt }]) {
    const mapped = m.assistantConfirmationToDisplay(result(confirmation(changes))).changes;
    for (const key of ["title", "category", "completed", "scheduledAt"]) assert.equal(Object.hasOwn(mapped, key), Object.hasOwn(changes, key));
    assert.equal(Object.hasOwn(mapped, "date"), Object.hasOwn(changes, "scheduledAt"));
    assert.equal(Object.hasOwn(mapped, "time"), Object.hasOwn(changes, "scheduledAt"));
    if (changes.title) assert.equal(mapped.title, changes.title);
  }
});

test("delete confirmation: 실제 target 보존, changes·가상 완료값·추가 일정 생성 없음", () => {
  const dto = result({ kind: "confirmation", text: "제목을 수정할까요?", questionId, expiresAt, operation: "delete", target: summary });
  const mapped = m.assistantConfirmationToDisplay(dto);
  assert.equal(mapped.operation, "delete"); assert.equal(mapped.target.id, scheduleId);
  assert.equal(Object.hasOwn(mapped, "changes"), false);
  assert.equal(Object.hasOwn(mapped, "schedulesChanged"), false);
});

test("outcome 조회 items: 원본 순서·ID·완료 상태를 유지하고 별도 표시 객체 생성", () => {
  const second = { ...summary, id: requestId, title: "두 번째", completed: true };
  const dto = result(list([summary, second]));
  const mapped = m.assistantOutcomeToDisplay(dto);
  assert.deepEqual(mapped.items.map(item=>item.id), [scheduleId, requestId]);
  assert.deepEqual(mapped.items.map(item=>item.completed), [false, true]);
  assert.deepEqual(mapped.items[1], m.assistantScheduleSummaryToDisplay(second));
  assert.notEqual(mapped.items, dto.items); assert.notEqual(mapped.items[0], dto.items[0]);
  assert.equal(mapped.schedulesChanged, false); assert.equal(mapped.text, dto.text);
});

test("조회 0건: 빈 items와 서버 text를 그대로 유지하며 성공 일정 보충 없음", () => {
  const dto = result(list([])), mapped = m.assistantOutcomeToDisplay(dto);
  assert.deepEqual(mapped, dto); assert.deepEqual(mapped.items, []); assert.notEqual(mapped.items, dto.items);
});

test("write outcome: 실제 affectedScheduleIds만 보존하고 후보 snapshot으로 items 합성 없음", () => {
  for (const operation of ["create", "update", "delete"]) {
    const dto = result({ kind: "outcome", text: "변경 확인", outcome: "success", operation, schedulesChanged: true, affectedScheduleIds: [scheduleId] });
    const mapped = m.assistantOutcomeToDisplay(dto);
    assert.deepEqual(mapped, dto); assert.notEqual(mapped.affectedScheduleIds, dto.affectedScheduleIds);
    assert.equal(Object.hasOwn(mapped, "items"), false);
  }
});

test("cancelled/no_match: optional operation 생략 보존, 성공·빈 조회 목록으로 변환 없음", () => {
  for (const outcome of ["cancelled", "no_match"]) for (const operation of [undefined, "create", "list", "update", "delete"]) {
    const dto = result({ kind: "outcome", text: "성공했어요", outcome, schedulesChanged: false,
      ...(operation !== undefined ? { operation } : {}) });
    const mapped = m.assistantResultToDisplay(dto);
    assert.deepEqual(mapped, dto); assert.equal(Object.hasOwn(mapped, "operation"), operation !== undefined);
    assert.equal(Object.hasOwn(mapped, "items"), false); assert.equal(Object.hasOwn(mapped, "affectedScheduleIds"), false);
  }
});

test("후보 2/10개: 순서·동일 표시·opaque ID를 유지하고 자동 선택·잘라 표시 없음", () => {
  for (const count of [2, 10]) {
    const dto = result({ kind: "candidate_selection", text: "어느 일정인가요?", questionId, expiresAt,
      candidates: Array.from({ length: count }, (_, i)=>({ ...candidate, candidateId: `opaque/${i}` })) });
    const mapped = m.assistantResultToDisplay(dto);
    assert.equal(mapped.candidates.length, count); assert.equal(mapped.questionId, questionId); assert.equal(mapped.expiresAt, expiresAt);
    assert.deepEqual(mapped.candidates.map(c=>c.candidateId), dto.candidates.map(c=>c.candidateId));
    assert.ok(mapped.candidates.every(c=>!Object.hasOwn(c, "scheduleId")));
  }
});

test("빈 candidateId도 임의 ID로 대체하지 않으며 Schedule ID와 구별", () => {
  assert.equal(m.assistantCandidateToDisplay({ ...candidate, candidateId: "" }).candidateId, "");
  assert.equal(m.assistantCandidateToDisplay({ ...candidate, candidateId: scheduleId }).candidateId, scheduleId);
  assert.equal(Object.hasOwn(m.assistantCandidateToDisplay(candidate), "id"), false);
});

test("need_more_info: 서버 questionId·text만 보존, expiresAt·interaction 상태 생성 없음", () => {
  const dto = result({ kind: "need_more_info", text: "삭제했어요", questionId });
  assert.deepEqual(m.assistantResultToDisplay(dto), dto);
  assert.equal(Object.hasOwn(m.assistantResultToDisplay(dto), "expiresAt"), false);
});

test("failure/uncertain: 성공 문구라도 kind·code·nextAction 보존, schedulesChanged 추정 없음", () => {
  for (const dto of [
    { kind: "failure", text: "완료했어요", code: "TARGET_AMBIGUOUS", nextAction: "revise_input" },
    { kind: "uncertain", text: "등록했어요", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
  ]) {
    const mapped = m.assistantResultToDisplay(result(dto)); assert.deepEqual(mapped, dto);
    for (const key of ["outcome", "schedulesChanged", "items", "affectedScheduleIds"]) assert.equal(Object.hasOwn(mapped, key), false);
  }
});

test("상태 응답: requestId/conversationId/questionId 대소문자 보존, completed를 성공으로 해석하지 않음", () => {
  const serverRequestId = "ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456";
  const serverConversationId = "ABCDEF13-ABCD-4ABC-8ABC-ABCDEF123456";
  const serverQuestionId = "ABCDEF14-ABCD-4ABC-8ABC-ABCDEF123456";
  for (const status of ["accepted", "processing", "completed"]) {
    const dto = checked(v.parseAssistantRequestStatusResponse, { requestId: serverRequestId, conversationId: serverConversationId, status,
      ...(status === "completed" ? { result: { kind: "need_more_info", text: "질문", questionId: serverQuestionId } } : {}) });
    const mapped = m.assistantRequestStatusToDisplay(dto);
    assert.deepEqual(mapped, dto); assert.equal(Object.hasOwn(mapped, "result"), status === "completed");
  }
});

test("completed 결과 6종을 구조화된 kind로 분기하고 서버 연결 정보 유지", () => {
  const values = [
    { kind: "need_more_info", text: "질문", questionId },
    { kind: "candidate_selection", text: "후보", questionId, expiresAt, candidates: [candidate, { ...candidate, candidateId: "다음 후보" }] },
    confirmation(), list(),
    { kind: "failure", text: "실패", code: "MODEL_TIMEOUT", nextAction: "retry_later" },
    { kind: "uncertain", text: "미확인", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
  ];
  for (const value of values) {
    const dto = checked(v.parseAssistantRequestStatusResponse, { requestId, conversationId, status: "completed", result: value });
    const mapped = m.assistantRequestStatusToDisplay(dto);
    assert.equal(mapped.requestId, requestId); assert.equal(mapped.conversationId, conversationId);
    assert.equal(mapped.status, "completed"); assert.equal(mapped.result.kind, value.kind);
    assert.deepEqual(mapped.result, m.assistantResultToDisplay(value));
  }
});

test("검증된 DTO 경계: nullable·잘못된 조합은 기존 validator가 거부하고 mapper로 보정하지 않음", () => {
  assert.equal(v.parseAssistantResult({ ...list(), operation: null }), null);
  assert.equal(v.parseAssistantResult({ ...confirmation(), changes: { completed: null } }), null);
  assert.equal(v.parseAssistantCandidate({ ...candidate, category: null }), null);
  assert.throws(()=>m.assistantCandidateToDisplay({ ...candidate, category: "UNKNOWN" }), RangeError);
  assert.throws(()=>m.assistantResultToDisplay({ kind: "unknown", text: "성공" }), RangeError);
});

test("입출력 분리: 원본 전체를 동결해도 변환되며 출력 변경이 DTO를 바꾸지 않음", () => {
  const dto = result(confirmation({ completed: false })), before = JSON.stringify(dto);
  const mapped = m.assistantResultToDisplay(dto);
  mapped.target.title = "표시만 변경"; mapped.changes.completed = true;
  assert.equal(JSON.stringify(dto), before);
  const candidates = result({ kind: "candidate_selection", text: "질문", questionId, expiresAt,
    candidates: [{ ...candidate }, { ...candidate, candidateId: "다른 후보" }] });
  const displayed = m.assistantResultToDisplay(candidates); displayed.candidates[0].title = "변경";
  assert.equal(candidates.candidates[0].title, candidate.title);
});

test("Schedule mapper 회귀: 동일 표시·정밀도 보존·제목/완료만 수정할 때 시각 재생성 없음", () => {
  const dto = { ...summary, createdAt: summary.updatedAt };
  const { scheduledAt: originalTime, updatedAt, ...display } = m.assistantScheduleSummaryToDisplay(summary);
  assert.deepEqual(display, s.scheduleDtoToSchedule(dto));
  assert.equal(originalTime, summary.scheduledAt); assert.equal(updatedAt, summary.updatedAt);
  assert.deepEqual(s.buildScheduleUpdate(display, { completed: true }), { completed: true });
  assert.deepEqual(s.buildScheduleUpdate(display, { title: "변경" }), { title: "변경" });
});

test("표시 타입: 후보와 Schedule·삭제와 수정·API 상태를 서로 잘못 대입할 수 없음", () => {
  const file = path.join(root, "__assistant_display_contract__.ts");
  const source = `
    import type { AssistantCandidateDisplay, AssistantScheduleDisplay, AssistantConfirmationDisplay, AssistantRequestDisplay } from './src/utils/assistant-mapper';
    import type { Schedule } from './src/types/schedule';
    declare const candidate: AssistantCandidateDisplay;
    declare const summary: AssistantScheduleDisplay;
    const card: Schedule = summary;
    // @ts-expect-error 후보에는 실제 Schedule ID와 completed가 없음
    const wrongCard: Schedule = candidate;
    // @ts-expect-error candidateId를 scheduleId로 간주하지 않음
    const scheduleId = candidate.scheduleId;
    // @ts-expect-error delete에는 changes 없음
    const invalidDelete: AssistantConfirmationDisplay = {kind:'confirmation',text:'',questionId:'q',expiresAt:'date',operation:'delete',target:summary,changes:{completed:false}};
    // @ts-expect-error API accepted에 결과 없음
    const invalidStatus: AssistantRequestDisplay = {requestId:'r',conversationId:'c',status:'accepted',result:{kind:'need_more_info',text:'',questionId:'q'}};
    void card;
  `;
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, root).options, noEmit: true };
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = p=>path.resolve(p) === file ? source : read(p);
  host.fileExists = p=>path.resolve(p) === file || exists(p);
  host.writeFile = ()=>{ throw new Error("테스트 산출물 생성 금지"); };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});
