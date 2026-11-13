/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const key = "assistant.requestRecovery.v1";
const server = "development:https://example.invalid";
const otherServer = "development:https://other.example.invalid";
const id = (n) => `${n.toString(16).padStart(8, "0")}-abcd-4abc-8abc-abcdef123456`;
const ref = (n, serverId = server) => ({ serverId, requestId: id(n) });
const conversationId = id(100), questionId = id(101);
const response = (n, status = "accepted", result, conversation = conversationId) => ({
  requestId: id(n), conversationId: conversation, status, ...(result ? { result } : {}),
});
const outcomes = {
  outcome: { kind: "outcome", text: "private result", outcome: "success", operation: "list", schedulesChanged: false, items: [] },
  failure: { kind: "failure", text: "private failure", code: "MODEL_TIMEOUT", nextAction: "retry_later" },
  uncertain: { kind: "uncertain", text: "private uncertain", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
  need_more_info: { kind: "need_more_info", text: "private question", questionId },
  candidate_selection: { kind: "candidate_selection", text: "private candidates", questionId, expiresAt: "2026-11-12T00:00:00Z",
    candidates: [1, 2].map(n=>({ candidateId: `opaque-${n}`, title: `private title ${n}`, scheduledAt: "2026-11-12T01:00:00Z", category: "OTHER" })) },
  confirmation: { kind: "confirmation", text: "private confirmation", questionId, expiresAt: "2026-11-12T00:00:00Z", operation: "update",
    target: { id: id(200), title: "private target", scheduledAt: "2026-11-12T01:00:00Z", category: "OTHER", completed: false, updatedAt: "2026-11-11T00:00:00Z" },
    changes: { title: "private changes" } },
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r=>{ resolve = r; });
  return { promise, resolve };
};

function memory() {
  const data = new Map([["settings.savedPiIp", "settings-marker"]]);
  const calls = [];
  const fault = { read: false, write: false, afterWrite: false, beforeWrite: null };
  const storage = {
    async getItem(k) {
      calls.push({ method: "get", key: k });
      await Promise.resolve();
      if (fault.read) throw new Error("private adapter error");
      return data.get(k) ?? null;
    },
    async setItem(k, value) {
      calls.push({ method: "set", key: k, value });
      if (fault.beforeWrite) await fault.beforeWrite();
      if (fault.write) throw new Error("private adapter error");
      data.set(k, value);
      if (fault.afterWrite) throw new Error("private adapter error");
    },
  };
  return { data, calls, fault, storage };
}

function modules(adapter) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
    }).outputText;
    const resolve = name=>{
      if (name === "@react-native-async-storage/async-storage") return adapter;
      assert.ok(name.startsWith("@/utils/") || name === "@/services/api/config", `네트워크/native/store 의존 금지: ${name}`);
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function("require", "module", "exports", "fetch", "process", code)(resolve, module, module.exports,
      ()=>{ throw new Error("실제 네트워크 요청 금지"); }, { env: {} });
    return module.exports;
  }
  return {
    api: load(path.join(root, "src/services/storage/assistant-recovery.ts")),
    pure: load(path.join(root, "src/utils/assistant-recovery.ts")),
  };
}
const setup = () => {
  const h = memory();
  const { api, pure } = modules(h.storage);
  return { ...h, api, pure, store: api.assistantRecoveryStorage };
};
const errorCode = code=>error=>{
  assert.equal(error.name, "AssistantRecoveryStorageError");
  assert.equal(error.code, code);
  assert.equal(error.message.includes("private adapter error"), false);
  return true;
};
async function completed(h, n, kind) {
  await h.store.saveBeforePost(ref(n), 1000);
  return h.store.recordResponse(ref(n), response(n, "completed", outcomes[kind]));
}
function acceptedEvidence(oldId, nextId, input = { type: "text", text: "private input", questionId }, acknowledgement) {
  return { type: "next-input-accepted", httpStatus: 202,
    request: { requestId: id(nextId), ...(input.questionId ? { conversationId } : {}), input,
      ...(acknowledgement ? { acknowledgedUncertainRequestId: id(oldId) } : {}) },
    response: response(nextId) };
}

test("import/factory 생성은 읽기·쓰기·GET 복구를 시작하지 않음", () => {
  const h = setup();
  h.api.createAssistantRecoveryStorage(h.storage);
  assert.deepEqual(h.calls, []);
});

test("최초 저장·조회·서버별 조회 및 다시 만든 storage에서 복원", async () => {
  const h = setup();
  assert.deepEqual(await h.store.readAll(), []);
  const saved = await h.store.saveBeforePost(ref(1), 1000);
  assert.deepEqual(saved, { ...ref(1), firstPostAttemptAt: 1000, lastPostAttemptAt: 1000, acceptConfirmed: false });
  assert.deepEqual(await h.store.read(ref(1)), saved);
  assert.deepEqual(await h.store.readForServer(server), [saved]);
  assert.equal(await h.store.read(ref(2)), null);
  const restarted = modules(h.storage).api.assistantRecoveryStorage;
  assert.deepEqual(await restarted.readAll(), [saved]);
  assert.deepEqual(JSON.parse(h.data.get(key)), { version: 1, entries: [saved] });
  assert.equal(h.data.get("settings.savedPiIp"), "settings-marker");
  assert.ok(h.calls.every(call=>call.key === key));
});

test("같은 서버의 새 요청이 기존 항목을 덮어쓰지 않고 재시도는 최초 시각 보존", async () => {
  const h = setup();
  await h.store.saveBeforePost(ref(1), 1000);
  await h.store.saveBeforePost(ref(2), 1500);
  await h.store.recordResponse(ref(1), response(1));
  await h.store.saveBeforePost(ref(1), 2000);
  assert.equal((await h.store.readAll()).length, 2);
  assert.deepEqual(await h.store.read(ref(1)), { ...ref(1), firstPostAttemptAt: 1000, lastPostAttemptAt: 2000,
    acceptConfirmed: true, conversationId, lastStatus: "accepted" });
  // wall clock 보정만으로 기록을 버리거나 최초 시각을 다시 쓰지 않는다.
  await h.store.saveBeforePost(ref(1), 900);
  assert.equal((await h.store.read(ref(1))).firstPostAttemptAt, 1000);
  assert.equal((await h.store.read(ref(1))).lastPostAttemptAt, 900);
});

test("UUID 대소문자는 서버 정규화와 일치하며 같은 논리 요청이 중복 저장되지 않음", async () => {
  const h = setup();
  await h.store.saveBeforePost({ ...ref(1), requestId: id(1).toUpperCase() }, 1000);
  await h.store.recordResponse(ref(1), { ...response(1), requestId: id(1).toUpperCase(), conversationId: conversationId.toUpperCase() });
  await h.store.saveBeforePost(ref(1), 2000);
  assert.equal((await h.store.readAll()).length, 1);
  assert.equal((await h.store.read(ref(1))).conversationId, conversationId);
});

test("접수·진행·완료 6종 갱신은 메타데이터만 저장하고 결과 표시 전에는 삭제하지 않음", async () => {
  const h = setup();
  for (const [i, kind] of Object.keys(outcomes).entries()) {
    const n = i + 1;
    await h.store.saveBeforePost(ref(n), 1000);
    await h.store.recordResponse(ref(n), response(n));
    assert.equal((await h.store.read(ref(n))).lastResultKind, undefined);
    await h.store.recordResponse(ref(n), response(n, "processing"));
    assert.equal((await h.store.read(ref(n))).lastStatus, "processing");
    await h.store.recordResponse(ref(n), response(n, "completed", outcomes[kind]));
    const entry = await h.store.read(ref(n));
    assert.equal(entry.lastResultKind, kind);
    assert.equal(entry.acceptConfirmed, true);
    assert.equal(entry.firstPostAttemptAt, 1000);
    assert.deepEqual(Object.keys(entry).sort(), ["serverId", "requestId", "firstPostAttemptAt", "lastPostAttemptAt", "acceptConfirmed", "conversationId", "lastStatus", "lastResultKind"].sort());
  }
  const raw = h.data.get(key);
  for (const forbidden of ["private", "input", "body", "messages", "target", "changes", "candidateId", "text", "token"]) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test("POST 전 저장 Promise는 내구 쓰기 완료까지 대기하며 실패하면 전송 경로가 실행되지 않음", async () => {
  const h = setup(), started = deferred(), gate = deferred();
  h.fault.beforeWrite = async ()=>{ started.resolve(); await gate.promise; };
  let postCount = 0;
  const pending = h.store.saveBeforePost(ref(1), 1000).then(()=>{ postCount++; });
  await started.promise;
  assert.equal(postCount, 0);
  assert.equal(h.data.has(key), false);
  gate.resolve(); await pending;
  assert.equal(postCount, 1);
  h.fault.write = true;
  await assert.rejects(h.store.saveBeforePost(ref(2), 1000).then(()=>{ postCount++; }), errorCode("write"));
  assert.equal(postCount, 1);
  assert.equal(await h.store.read(ref(2)), null);
});

test("쓰기 반영 뒤 예외여도 성공으로 처리하지 않고 같은 ID 재시도는 최초 기록을 유지", async () => {
  const h = setup();
  h.fault.afterWrite = true;
  let sent = false;
  await assert.rejects(h.store.saveBeforePost(ref(1), 1000).then(()=>{ sent = true; }), errorCode("write"));
  assert.equal(sent, false);
  h.fault.afterWrite = false;
  await h.store.saveBeforePost(ref(1), 2000);
  assert.equal((await h.store.readAll()).length, 1);
  assert.equal((await h.store.read(ref(1))).firstPostAttemptAt, 1000);
});

test("읽기 실패는 빈 성공으로 바꾸지 않으며 실패 후 큐도 다음 작업을 처리", async () => {
  const h = setup();
  h.fault.read = true;
  await assert.rejects(h.store.readAll(), errorCode("read"));
  await assert.rejects(h.store.saveBeforePost(ref(1), 1000), errorCode("read"));
  assert.equal(h.calls.some(call=>call.method === "set"), false);
  h.fault.read = false;
  await h.store.saveBeforePost(ref(1), 1000);
  assert.equal((await h.store.readAll()).length, 1);
});

test("잘못된 저장 JSON/schema/중복은 자동 삭제·부분 복원·덮어쓰기를 하지 않음", async () => {
  const h = setup();
  const entry = { ...ref(1), firstPostAttemptAt: 1000, lastPostAttemptAt: 1000, acceptConfirmed: false };
  const invalid = ["not JSON", "null", "[]", "{}", JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [], extra: true }), JSON.stringify({ version: 1, entries: null }),
    ...[{ ...entry, body: "private input" }, { ...entry, requestId: "invalid" }, { ...entry, acceptConfirmed: "false" },
      { ...entry, firstPostAttemptAt: null }, { ...entry, lastPostAttemptAt: -1 }, { ...entry, lastPostAttemptAt: 1.5 },
      { ...entry, serverId: "another-server" }, { ...entry, conversationId },
      { ...entry, acceptConfirmed: true, conversationId, lastStatus: "completed" }]
      .map(bad=>JSON.stringify({ version: 1, entries: [entry, bad] })),
    JSON.stringify({ version: 1, entries: [entry, { ...entry, requestId: entry.requestId.toUpperCase() }] })];
  for (const raw of invalid) {
    h.data.set(key, raw);
    await assert.rejects(h.store.readAll(), errorCode("invalid-data"));
    await assert.rejects(h.store.saveBeforePost(ref(2), 2000), errorCode("invalid-data"));
    assert.equal(h.data.get(key), raw);
  }
  assert.equal(h.calls.some(call=>call.method === "set"), false);
});

test("메타데이터 validator는 상태별 optional/null·유효한 시각·추가 payload를 구분", () => {
  const h = setup();
  const entry = { ...ref(1), firstPostAttemptAt: 1000, lastPostAttemptAt: 1000, acceptConfirmed: false };
  assert.ok(h.pure.parseAssistantRecoveryMetadata(entry));
  for (const invalid of [null, [], { ...entry, firstPostAttemptAt: NaN }, { ...entry, lastPostAttemptAt: Infinity },
    { ...entry, lastPostAttemptAt: Number.MAX_SAFE_INTEGER + 1 }, { ...entry, conversationId: undefined },
    { ...entry, acceptConfirmed: true }, { ...entry, acceptConfirmed: true, conversationId, lastStatus: "processing", lastResultKind: "outcome" },
    { ...entry, acceptConfirmed: true, conversationId, lastStatus: "completed", lastResultKind: ["outcome"] },
    { ...entry, acceptConfirmed: true, conversationId, lastStatus: "completed", lastResultKind: "unknown" }]) {
    assert.equal(h.pure.parseAssistantRecoveryMetadata(invalid), null);
  }
});

test("서버 식별은 기존 canonical origin 정책을 따르고 주소 세대/DB를 추정하지 않음", () => {
  const h = setup();
  assert.equal(h.pure.isAssistantRecoveryServerId(server), true);
  for (const invalid of ["", null, "development:https://EXAMPLE.invalid", `${server}/`, `${server}/api/v1`,
    "development:https://user:secret@example.invalid", `${server}?token=secret`, "settings.savedPiIp"]) {
    assert.equal(h.pure.isAssistantRecoveryServerId(invalid), false);
  }
});

test("서버별 분리: 같은 requestId도 독립 보존, 서버 변경·불일치에서 자동 삭제 없음", async () => {
  const h = setup();
  await h.store.saveBeforePost(ref(1), 1000);
  await h.store.saveBeforePost(ref(1, otherServer), 2000);
  assert.equal((await h.store.readAll()).length, 2);
  assert.equal((await h.store.readForServer(server))[0].firstPostAttemptAt, 1000);
  assert.equal((await h.store.readForServer(otherServer))[0].firstPostAttemptAt, 2000);
  assert.deepEqual(await h.store.readForServer("development:https://third.example.invalid"), []);
  assert.equal(await h.store.cleanup(ref(1), otherServer, { type: "request-expired", method: "GET", httpStatus: 410, code: "REQUEST_EXPIRED" }), "retained");
  assert.equal((await h.store.readAll()).length, 2);
});

test("여러 factory의 동시 저장·접수 갱신·재시도·조회가 항목/필드를 유실하지 않음", async () => {
  const h = setup(), second = h.api.createAssistantRecoveryStorage(h.storage);
  const operations = [];
  for (let n = 1; n <= 20; n++) {
    const target = n % 2 ? h.store : second;
    operations.push(target.saveBeforePost(ref(n), 1000));
    operations.push(target.recordResponse(ref(n), response(n)));
    operations.push(target.saveBeforePost(ref(n), 2000));
  }
  const lastRead = second.readAll();
  await Promise.all(operations);
  const all = await lastRead;
  assert.equal(all.length, 20);
  assert.ok(all.every(entry=>entry.acceptConfirmed && entry.lastStatus === "accepted" && entry.firstPostAttemptAt === 1000 && entry.lastPostAttemptAt === 2000));
});

test("늦은 pending 응답은 진행/완료 상태를 되돌리지 않고 완료 결과는 uncertain 확정만 허용", async () => {
  const h = setup();
  await h.store.saveBeforePost(ref(1), 1000);
  await h.store.recordResponse(ref(1), response(1, "processing"));
  assert.equal((await h.store.recordResponse(ref(1), response(1))).lastStatus, "processing");
  await h.store.recordResponse(ref(1), response(1, "completed", outcomes.uncertain));
  assert.equal((await h.store.recordResponse(ref(1), response(1))).lastResultKind, "uncertain");
  await h.store.recordResponse(ref(1), response(1, "completed", outcomes.outcome));
  await assert.rejects(h.store.recordResponse(ref(1), response(1, "completed", outcomes.uncertain)), errorCode("conflict"));
  assert.equal((await h.store.read(ref(1))).lastResultKind, "outcome");
  await completed(h, 2, "uncertain");
  await h.store.recordResponse(ref(2), response(2, "completed", outcomes.failure));
  assert.equal((await h.store.read(ref(2))).lastResultKind, "failure");
  await completed(h, 3, "need_more_info");
  await assert.rejects(h.store.recordResponse(ref(3), response(3, "completed", outcomes.outcome)), errorCode("conflict"));
});

test("기록 없는 응답·다른 요청/대화·비표준 DTO는 기존 데이터를 덮지 않음", async () => {
  const h = setup();
  await assert.rejects(h.store.recordResponse(ref(1), response(1)), errorCode("not-found"));
  await h.store.saveBeforePost(ref(1), 1000);
  await assert.rejects(h.store.recordResponse(ref(1), response(2)), errorCode("invalid-input"));
  await assert.rejects(h.store.recordResponse(ref(1), { ...response(1), body: "private" }), errorCode("invalid-input"));
  await h.store.recordResponse(ref(1), response(1));
  await assert.rejects(h.store.recordResponse(ref(1), response(1, "accepted", undefined, id(102))), errorCode("conflict"));
  assert.equal((await h.store.read(ref(1))).conversationId, conversationId);
});

test("accepted/processing/uncertain/질문은 결과 표시·404·timeout·시간 경과로 삭제하지 않음", async () => {
  const h = setup();
  for (const [i, kind] of ["unconfirmed", "accepted", "processing", "uncertain", "need_more_info", "candidate_selection", "confirmation"].entries()) {
    const n = i + 1;
    await h.store.saveBeforePost(ref(n), 0);
    if (kind === "accepted" || kind === "processing") await h.store.recordResponse(ref(n), response(n, kind));
    else if (outcomes[kind]) await h.store.recordResponse(ref(n), response(n, "completed", outcomes[kind]));
    assert.equal(await h.store.cleanup(ref(n), server, { type: "result-displayed" }), "retained");
    for (const reason of ["polling-stopped", "request-not-found", "network", "timeout", "server-mismatch", "unknown-error"]) {
      assert.equal(await h.store.cleanup(ref(n), server, { type: "unconfirmed", reason }), "retained");
    }
    assert.ok(await h.store.read(ref(n)));
  }
});

test("outcome/failure도 응답 수신만으로 지우지 않으며 표시 후 명시적 정리 가능", async () => {
  const h = setup();
  for (const [n, kind] of [[1, "outcome"], [2, "failure"]]) {
    await completed(h, n, kind);
    assert.ok(await h.store.read(ref(n)));
    assert.equal(await h.store.cleanup(ref(n), server, { type: "unconfirmed", reason: "timeout" }), "retained");
    assert.equal(await h.store.cleanup(ref(n), server, { type: "result-displayed" }), "removed");
    assert.equal(await h.store.read(ref(n)), null);
    assert.equal(await h.store.cleanup(ref(n), server, { type: "result-displayed" }), "not-found");
  }
});

test("질문은 GET 결과로 비활성을 추정하지 않고 별도 확인된 답변·취소·만료·not_active에서 정리", async () => {
  const h = setup();
  let n = 0;
  for (const kind of ["need_more_info", "candidate_selection", "confirmation"]) {
    for (const reason of ["answered", "cancelled", "expired", "not_active"]) {
      n++;
      await completed(h, n, kind);
      assert.equal(await h.store.cleanup(ref(n), server, { type: "question-inactive-confirmed", reason: "unknown" }), "retained");
      assert.equal(await h.store.cleanup(ref(n), server, { type: "question-inactive-confirmed", reason }), "removed");
    }
  }
  await h.store.saveBeforePost(ref(++n), 1000);
  assert.equal(await h.store.cleanup(ref(n), server, { type: "question-inactive-confirmed", reason: "cancelled" }), "retained");
});

test("GET 410/POST 409 REQUEST_EXPIRED만 허용하고 404·다른 method/status/code는 보존", async () => {
  const h = setup();
  await completed(h, 1, "uncertain");
  const expired = { type: "request-expired", method: "GET", httpStatus: 410, code: "REQUEST_EXPIRED" };
  for (const evidence of [{ ...expired, httpStatus: 404, code: "ASSISTANT_REQUEST_NOT_FOUND" },
    { ...expired, method: "POST" }, { ...expired, httpStatus: 409 }, { ...expired, code: "ROUTE_NOT_FOUND" }, null, { type: "unknown" }]) {
    assert.equal(await h.store.cleanup(ref(1), server, evidence), "retained");
  }
  assert.equal(await h.store.cleanup(ref(1), server, expired), "removed");
  await h.store.saveBeforePost(ref(2), 1000);
  assert.equal(await h.store.cleanup(ref(2), server, { ...expired, method: "POST", httpStatus: 409 }), "removed");
});

test("질문 교체는 같은 대화 후속 입력의 2xx 접수와 새 기록 영속 확인 뒤에만 정리", async () => {
  const h = setup();
  for (const [i, input] of [{ type: "text", text: "private reply", questionId },
    { type: "selection", candidateId: "opaque", questionId }, { type: "confirmation", approved: false, questionId }].entries()) {
    const old = i * 2 + 1, next = old + 1;
    await completed(h, old, "confirmation");
    const evidence = acceptedEvidence(old, next, input);
    assert.equal(await h.store.cleanup(ref(old), server, evidence), "retained");
    await h.store.saveBeforePost(ref(next), 2000);
    assert.equal(await h.store.cleanup(ref(old), server, evidence), "retained");
    await h.store.recordResponse(ref(next), evidence.response);
    assert.equal(await h.store.cleanup(ref(old), server, { ...evidence, httpStatus: 409 }), "retained");
    assert.equal(await h.store.cleanup(ref(old), server, evidence), "removed");
    assert.ok(await h.store.read(ref(next)));
  }
});

test("다른 대화·서버·동일 ID·일반 새 text는 과거 질문의 교체 근거가 아님", async () => {
  const h = setup();
  await completed(h, 1, "need_more_info");
  await h.store.saveBeforePost(ref(2), 2000);
  await h.store.recordResponse(ref(2), response(2, "accepted", undefined, id(103)));
  const wrongConversation = acceptedEvidence(1, 2);
  wrongConversation.request.conversationId = id(103);
  wrongConversation.response.conversationId = id(103);
  assert.equal(await h.store.cleanup(ref(1), server, wrongConversation), "retained");
  await h.store.saveBeforePost(ref(3, otherServer), 2000);
  await h.store.recordResponse(ref(3, otherServer), response(3));
  assert.equal(await h.store.cleanup(ref(1), server, acceptedEvidence(1, 3)), "retained");
  assert.equal(await h.store.cleanup(ref(1), server, acceptedEvidence(1, 1)), "retained");
  const text = acceptedEvidence(1, 2, { type: "text", text: "private new task" });
  text.response.conversationId = id(103);
  assert.equal(await h.store.cleanup(ref(1), server, text), "retained");
});

test("uncertain 인지는 위험 ID가 같은 새 text의 2xx 접수까지 보존, 거절·선택·후속 답변으로 해제 안 함", async () => {
  const h = setup();
  await completed(h, 1, "uncertain");
  const evidence = acceptedEvidence(1, 2, { type: "text", text: "private new task" }, true);
  await h.store.saveBeforePost(ref(2), 2000);
  assert.equal(await h.store.cleanup(ref(1), server, evidence), "retained");
  await h.store.recordResponse(ref(2), response(2));
  for (const bad of [{ ...evidence, httpStatus: 422 },
    { ...evidence, request: { ...evidence.request, acknowledgedUncertainRequestId: id(99) } },
    acceptedEvidence(1, 2), { ...evidence, response: response(3) },
    { ...evidence, request: { ...evidence.request, conversationId, input: { type: "confirmation", questionId, approved: true } } }]) {
    assert.equal(await h.store.cleanup(ref(1), server, bad), "retained");
  }
  assert.equal(await h.store.cleanup(ref(1), server, evidence), "removed");
  assert.ok(await h.store.read(ref(2)));
  assert.equal(h.data.get(key).includes("private"), false);
});

test("uncertain이 확정 outcome/failure로 바뀌어도 결과 표시 후에만 정리", async () => {
  const h = setup();
  await completed(h, 1, "uncertain");
  await h.store.recordResponse(ref(1), response(1, "completed", outcomes.failure));
  assert.ok(await h.store.read(ref(1)));
  assert.equal(await h.store.cleanup(ref(1), server, { type: "result-displayed" }), "removed");
});

test("수동 정리는 명시적 확인 후 선택 항목만 삭제하고 서버 취소/결과 변경을 만들지 않음", async () => {
  const h = setup();
  await completed(h, 1, "uncertain");
  await h.store.saveBeforePost(ref(2, otherServer), 2000);
  await assert.rejects(h.store.removeManually(ref(1), { confirmed: false }), errorCode("invalid-input"));
  assert.equal((await h.store.read(ref(1))).lastResultKind, "uncertain");
  assert.equal(await h.store.removeManually(ref(1), { confirmed: true }), "removed");
  assert.equal((await h.store.readAll()).length, 1);
  assert.equal(await h.store.removeManually(ref(1), { confirmed: true }), "not-found");
});

test("상태 갱신·정리 쓰기 실패는 호출자에 오류를 전달하고 후속 작업을 막지 않음", async () => {
  const h = setup();
  await h.store.saveBeforePost(ref(1), 1000);
  h.fault.write = true;
  await assert.rejects(h.store.recordResponse(ref(1), response(1)), errorCode("write"));
  assert.equal((await h.store.read(ref(1))).acceptConfirmed, false);
  h.fault.write = false;
  await h.store.recordResponse(ref(1), response(1, "completed", outcomes.outcome));
  h.fault.write = true;
  await assert.rejects(h.store.cleanup(ref(1), server, { type: "result-displayed" }), errorCode("write"));
  await assert.rejects(h.store.removeManually(ref(1), { confirmed: true }), errorCode("write"));
  assert.ok(await h.store.read(ref(1)));
  h.fault.write = false;
  assert.equal(await h.store.cleanup(ref(1), server, { type: "result-displayed" }), "removed");
});

test("입력 ref·응답·정리 증거를 큐 대기 중 바꿔도 호출 당시 확인 사실만 사용", async () => {
  const h = setup();
  await completed(h, 1, "confirmation");
  await h.store.saveBeforePost(ref(2), 2000);
  await h.store.recordResponse(ref(2), response(2));
  const started = deferred(), gate = deferred();
  h.fault.beforeWrite = async ()=>{ started.resolve(); await gate.promise; };
  const reference = ref(3);
  const blocked = h.store.saveBeforePost(reference, 3000);
  await started.promise;
  reference.requestId = id(99);
  const received = response(2, "processing");
  const update = h.store.recordResponse(ref(2), received);
  received.conversationId = id(99);
  const evidence = acceptedEvidence(1, 2);
  const clean = h.store.cleanup(ref(1), server, evidence);
  evidence.request.requestId = id(99);
  evidence.response.conversationId = id(99);
  gate.resolve(); await blocked; await update;
  assert.equal(await clean, "removed");
  assert.ok(await h.store.read(ref(3)));
  assert.equal(await h.store.read(ref(99)), null);
  const read = await h.store.read(ref(2));
  read.conversationId = id(99);
  assert.equal((await h.store.read(ref(2))).conversationId, conversationId);
});

test("임의 추가 body/채팅 필드·잘못된 ref/시각은 저장하지 않음", async () => {
  const h = setup();
  for (const input of [{ ...ref(1), body: "private" }, { ...ref(1), messages: [] }, { serverId: server },
    { ...ref(1), requestId: "invalid" }, { ...ref(1), serverId: "invalid" }, null]) {
    await assert.rejects(h.store.saveBeforePost(input, 1000), errorCode("invalid-input"));
  }
  for (const time of [NaN, Infinity, -1, 1.5, "1000", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(h.store.saveBeforePost(ref(1), time), errorCode("invalid-input"));
  }
  assert.equal(h.data.has(key), false);
  await assert.rejects(h.store.readForServer("invalid"), errorCode("invalid-input"));
});

test("타입: 완료·접수 메타데이터와 정리 확인의 잘못된 조합은 컴파일 오류", () => {
  const file = path.join(root, "__assistant_recovery_types__.ts");
  const source = `
    import type { AssistantRecoveryMetadata, AssistantRecoveryCleanupEvidence } from './src/types/assistant-recovery';
    const base = { serverId:'server', requestId:'id', firstPostAttemptAt:1, lastPostAttemptAt:1 };
    const fresh: AssistantRecoveryMetadata = {...base, acceptConfirmed:false};
    // @ts-expect-error 미접수에는 대화 ID 없음
    const wrongFresh: AssistantRecoveryMetadata = {...base, acceptConfirmed:false, conversationId:'id'};
    // @ts-expect-error 접수 확인에는 conversationId 필요
    const missingConversation: AssistantRecoveryMetadata = {...base, acceptConfirmed:true, lastStatus:'accepted'};
    // @ts-expect-error completed에는 결과 종류 필요
    const missingKind: AssistantRecoveryMetadata = {...base, acceptConfirmed:true, conversationId:'id', lastStatus:'completed'};
    // @ts-expect-error processing에는 결과 종류 없음
    const pendingKind: AssistantRecoveryMetadata = {...base, acceptConfirmed:true, conversationId:'id', lastStatus:'processing', lastResultKind:'outcome'};
    // @ts-expect-error POST 상세 만료는 409이며 GET은 410
    const wrongExpired: AssistantRecoveryCleanupEvidence = {type:'request-expired',method:'POST',httpStatus:410,code:'REQUEST_EXPIRED'};
    void fresh;
  `;
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, root).options, noEmit: true };
  const host = ts.createCompilerHost(options), readFile = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = p=>path.resolve(p) === file ? source : readFile(p);
  host.fileExists = p=>path.resolve(p) === file || exists(p);
  host.writeFile = ()=>{ throw new Error("테스트 산출물 생성 금지"); };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});
