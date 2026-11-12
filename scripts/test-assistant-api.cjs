/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const id = n=>`${n.toString(16).padStart(8, "0")}-abcd-4abc-8abc-abcdef123456`;
const origin = "https://example.invalid", otherOrigin = "https://other.example.invalid";
const serverId = `development:${origin}`, otherServerId = `development:${otherOrigin}`;
const conversationId = id(100), questionId = id(101), traceId = id(900);
const request = (n = 1, input = { type: "text", text: "  private input  " }) => ({ requestId: id(n), input,
  ...(input.questionId ? { conversationId } : {}) });
const reference = (n = 1) => ({ serverId, requestId: id(n) });
const accepted = (n = 1) => ({ requestId: id(n), conversationId, status: "accepted" });
const summary = { id: id(200), title: "private title", scheduledAt: "2026-11-12T00:00:00Z", category: "OTHER", completed: false, updatedAt: "2026-11-11T00:00:00Z" };
const results = {
  need_more_info: { kind: "need_more_info", text: "private question", questionId },
  candidate_selection: { kind: "candidate_selection", text: "private candidates", questionId, expiresAt: "2026-11-12T00:00:00Z",
    candidates: [1, 2].map(n=>({ candidateId: `opaque-${n}`, title: "private candidate", scheduledAt: summary.scheduledAt, category: "OTHER" })) },
  confirmation: { kind: "confirmation", text: "private confirmation", questionId, expiresAt: "2026-11-12T00:00:00Z", operation: "update", target: summary, changes: { completed: true } },
  outcome: { kind: "outcome", text: "private outcome", outcome: "success", operation: "list", schedulesChanged: false, items: [summary] },
  failure: { kind: "failure", text: "private failure", code: "MODEL_TIMEOUT", nextAction: "retry_later" },
  uncertain: { kind: "uncertain", text: "private uncertain", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
};
const complete = (kind, n = 1) => ({ ...accepted(n), status: "completed", result: results[kind] });
const json = (data, status = 200, type = "application/json", headers = {}) => ({
  status, headers: new Headers({ "Content-Type": type, "X-Request-ID": traceId, ...headers }),
  text: async ()=>JSON.stringify(data),
});
const problem = (status, code, extra = {}) => ({ type: "https://example.invalid/problem", title: "test", status,
  detail: "test", instance: "/api/v1/assistant/requests", code, requestId: traceId, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(r=>{ resolve = r; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let n = 0; n < 200 && !predicate(); n++) await Promise.resolve();
  assert.ok(predicate(), "비동기 작업이 예상 지점에 도달해야 한다.");
}
const settle = async ()=>{ for (let n = 0; n < 100; n++) await Promise.resolve(); };

function harness() {
  const data = new Map(), cache = new Map(), timers = new Map();
  let time = 0, timerId = 0, writes = 0;
  const state = { calls: [], storageCalls: [], nativeCalls: [], config: null,
    handle: async ()=>json(accepted(), 202), failRead: false, failWriteAt: 0, commitAndFailAt: 0, beforeWrite: null };
  const adapter = {
    async getItem(key) {
      state.storageCalls.push({ type: "get", key });
      if (state.failRead) throw new Error("private storage error");
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      const index = ++writes;
      state.storageCalls.push({ type: "set", key });
      if (state.beforeWrite) await state.beforeWrite(index);
      if (index === state.failWriteAt) throw new Error("private storage error");
      data.set(key, value);
      if (index === state.commitAndFailAt) throw new Error("private storage error");
    },
  };
  const send = (url, init)=>{ state.calls.push({ url, init }); return state.handle(url, init); };
  const env = { EXPO_PUBLIC_DEV_SERVER_BASE_URL: origin };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
    }).outputText;
    const resolve = name=>{
      if (name === "expo/fetch") return { fetch: (url, init)=>{ state.nativeCalls.push(init.method); return send(url, init); } };
      if (name === "@react-native-async-storage/async-storage") return adapter;
      if (name === "zustand/vanilla") return require(name);
      assert.ok(name.startsWith("@/"), name);
      assert.notEqual(name, "@/services/api/http", "Schedule HTTP runtime 의존 금지");
      return load(path.join(root, "src", `${name.slice(2)}.ts`));
    };
    new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "process", code)(
      resolve, module, module.exports, ()=>{ throw new Error("실제 네트워크 요청 금지"); },
      (fn, delay)=>{ const token = ++timerId; timers.set(token, { fn, at: time + delay, delay }); return token; },
      token=>timers.delete(token), { env });
    return module.exports;
  }
  const config = load(path.join(root, "src/services/api/config.ts"));
  state.config = config.parseDevelopmentServerConfig(origin);
  const api = load(path.join(root, "src/services/api/assistant.ts"));
  const recovery = load(path.join(root, "src/services/storage/assistant-recovery.ts")).assistantRecoveryStorage;
  const mode = load(path.join(root, "src/stores/scheduleDataModeStore.ts")).scheduleDataModeStore;
  const client = api.createAssistantHttpClient({ fetchImpl: send, recovery, readConfig: ()=>state.config, now: ()=>1000 });
  function tick(ms) {
    time += ms;
    for (const [token, timer] of [...timers]) if (timer.at <= time) { timers.delete(token); timer.fn(); }
  }
  return { state, data, timers, tick, client, api, recovery, mode, config,
    post: (body = request(), signal)=>client.postAssistantRequest(body, { expectedServerId: serverId, signal }),
    get: (n = 1, signal)=>client.getAssistantRequest(reference(n), { signal }),
    seed: n=>recovery.saveBeforePost(reference(n), 1000) };
}

test("import은 storage·네트워크를 실행하지 않고 기본 설정·Expo fetch·canonical path를 재사용", async () => {
  const h = harness();
  assert.deepEqual(h.state.calls, []);
  assert.deepEqual(h.state.storageCalls, []);
  assert.equal(h.api.assistantHttpClient.getServerId(), serverId);
  const posted = await h.api.assistantHttpClient.postAssistantRequest(request(), { expectedServerId: serverId });
  assert.equal(posted.ok, true);
  h.state.handle = async ()=>json(accepted());
  await h.api.assistantHttpClient.getAssistantRequest(reference());
  h.state.handle = async ()=>json({ target: { type: "request", id: id(1) }, targetState: "cancelled", text: "test" });
  await h.api.assistantHttpClient.cancelAssistantConversation(conversationId, { target: { type: "request", id: id(1) } },
    { expectedServerId: serverId, signal: new AbortController().signal });
  assert.deepEqual(h.state.calls.map(call=>call.url), [`${origin}/api/v1/assistant/requests`,
    `${origin}/api/v1/assistant/requests/${id(1)}`, `${origin}/api/v1/assistant/conversations/${conversationId}/cancel`]);
  assert.deepEqual(h.state.nativeCalls, ["POST", "GET", "POST"]);
  assert.ok(h.state.calls.every(call=>call.init.redirect === "error"));
});

test("POST 202는 저장 완료 후 한 번 전송·원문 보존·메타데이터 갱신, 추적 ID 분리", async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.state.beforeWrite = async index=>{ if (index === 1) { entered.resolve(); await gate.promise; } };
  const body = request();
  const pending = h.post(body);
  await entered.promise;
  assert.equal(h.state.calls.length, 0);
  body.input.text = "changed after call";
  body.requestId = id(2);
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.data.requestId, id(1));
  assert.equal(result.httpRequestId, traceId);
  assert.notEqual(result.httpRequestId, result.data.requestId);
  assert.equal(result.metadata.status, "updated");
  assert.deepEqual(JSON.parse(h.state.calls[0].init.body), request());
  assert.equal(h.state.calls[0].init.headers.get("Content-Type"), "application/json");
  assert.equal(h.state.calls[0].init.headers.get("X-Request-ID"), null);
  assert.equal(h.state.calls[0].init.headers.get("Idempotency-Key"), null);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, true);
  assert.equal(h.state.calls.length, 1);
});

test("POST 200 동일 요청 응답의 accepted/processing/completed를 검증하고 ID를 재생성하지 않음", async () => {
  for (const data of [accepted(), { ...accepted(), status: "processing" }, complete("uncertain")]) {
    const h = harness();
    h.state.handle = async ()=>json(data);
    const result = await h.post();
    assert.equal(result.ok, true);
    assert.equal(result.data.status, data.status);
    assert.equal((await h.recovery.read(reference())).lastStatus, data.status);
    assert.equal(JSON.parse(h.state.calls[0].init.body).requestId, id(1));
    assert.equal(h.state.calls.length, 1);
  }
});

test("POST 입력 text/selection/confirmation과 approved false를 그대로 전송", async () => {
  for (const input of [{ type: "text", text: "private reply", questionId },
    { type: "selection", candidateId: "opaque:/선택", questionId }, { type: "confirmation", approved: false, questionId }]) {
    const h = harness(), body = request(1, input);
    assert.equal((await h.post(body)).ok, true);
    assert.deepEqual(JSON.parse(h.state.calls[0].init.body), body);
  }
});

test("GET accepted/processing/completed 및 결과 6종은 기존 기록에 반영하고 POST/정리 없음", async () => {
  for (const kind of Object.keys(results)) {
    const h = harness(); await h.seed(1);
    for (const data of [accepted(), { ...accepted(), status: "processing" }, complete(kind)]) {
      h.state.handle = async ()=>json(data);
      const result = await h.get();
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, data);
      assert.equal(result.metadata.status, "updated");
    }
    assert.equal((await h.recovery.read(reference())).lastResultKind, kind);
    assert.equal(h.state.calls.length, 3);
    assert.ok(h.state.calls.every(call=>call.init.method === "GET" && call.init.body === undefined));
    assert.equal((await h.recovery.readAll()).length, 1);
  }
});

test("미저장 blocking/질문 ID GET은 첫 POST 시각이나 영속 기록을 만들어내지 않음", async () => {
  const h = harness(); h.state.handle = async ()=>json(complete("need_more_info"));
  const result = await h.get();
  assert.equal(result.ok, true);
  assert.equal(result.metadata.status, "not-tracked");
  assert.equal(h.data.size, 0);
  assert.equal(h.state.calls.length, 1);
});

test("cancel은 request/question·targetState 5종 검증, 새 requestId와 저장 작업 없음", async () => {
  const h = harness();
  for (const type of ["request", "question"]) for (const targetState of ["cancelled", "not_guaranteed", "already_completed", "uncertain", "not_active"]) {
    const target = { type, id: id(1) };
    h.state.handle = async ()=>json({ target, targetState, text: "test" });
    const result = await h.client.cancelAssistantConversation(conversationId, { target }, { expectedServerId: serverId, signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.equal(result.data.targetState, targetState);
    assert.equal(result.metadata.status, "not-applicable");
    assert.deepEqual(JSON.parse(h.state.calls.at(-1).init.body), { target });
  }
  assert.deepEqual(h.state.storageCalls, []);
  assert.equal(h.timers.size, 0);
});

test("cancel의 별도 수치 timeout은 만들지 않고 필수 호출자 AbortSignal로 대기 종료", async () => {
  const h = harness(), gate = deferred(), controller = new AbortController();
  const body = { target: { type: "question", id: questionId } };
  h.state.handle = ()=>gate.promise;
  assert.equal((await h.client.cancelAssistantConversation(conversationId, body, { expectedServerId: serverId })).error.kind, "request");
  const pending = h.client.cancelAssistantConversation(conversationId, body, { expectedServerId: serverId, signal: controller.signal });
  await until(()=>h.state.calls.length === 1);
  let finished = false; pending.then(()=>{ finished = true; });
  h.tick(100_000); await settle();
  assert.equal(h.timers.size, 0);
  assert.equal(finished, false);
  controller.abort();
  assert.equal((await pending).error.kind, "aborted");
  assert.equal(h.state.calls[0].init.signal.aborted, true);
  gate.resolve(json({ target: body.target, targetState: "not_active", text: "test" }));
  await settle(); assert.equal(h.state.calls.length, 1);
});

test("POST 전 저장 실패/손상 기록은 storage 오류로 fetch 0회", async () => {
  for (const fault of ["write", "read", "corrupt", "committed-then-error"]) {
    const h = harness();
    if (fault === "write") h.state.failWriteAt = 1;
    if (fault === "read") h.state.failRead = true;
    if (fault === "corrupt") h.data.set("assistant.requestRecovery.v1", "broken JSON");
    if (fault === "committed-then-error") h.state.commitAndFailAt = 1;
    const result = await h.post();
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "storage");
    assert.equal(result.error.storageStage, "before-post");
    assert.equal(result.error.requestState, "not-sent");
    assert.equal(h.state.calls.length, 0);
  }
});

test("POST 성공 후 저장 갱신 실패는 검증된 성공+metadata failed로 반환하고 재전송 없음", async () => {
  const h = harness(); h.state.failWriteAt = 2;
  const result = await h.post();
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.deepEqual(result.metadata, { status: "failed", code: "write" });
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
  assert.equal(h.state.calls.length, 1);
});

test("GET 전 저장소 읽기 실패와 GET 성공 뒤 갱신 실패를 네트워크 실패와 구분", async () => {
  const h = harness(); await h.seed(1);
  h.state.failRead = true;
  const before = await h.get();
  assert.equal(before.error.kind, "storage");
  assert.equal(before.error.storageStage, "before-get");
  assert.equal(h.state.calls.length, 0);
  h.state.failRead = false; h.state.failWriteAt = 2;
  h.state.handle = async ()=>json(complete("outcome"));
  const after = await h.get();
  assert.equal(after.ok, true);
  assert.deepEqual(after.metadata, { status: "failed", code: "write" });
  assert.equal(h.state.calls.length, 1);
});

test("POST/GET 네트워크 오류는 원래 ID·서버·복구 기록을 유지하며 자동 재시도 없음", async () => {
  const h = harness();
  h.state.handle = async ()=>{ throw new Error("private network error"); };
  for (const result of [await h.post(), await h.get()]) {
    assert.equal(result.error.kind, "network");
    assert.equal(result.error.assistantRequestId, id(1));
    assert.equal(result.error.serverId, serverId);
    assert.equal(result.error.requestState, "unconfirmed");
  }
  assert.equal(h.state.calls.length, 2);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
  assert.equal(h.timers.size, 0);
});

for (const operation of ["post", "get"]) test(`${operation.toUpperCase()} 5초 timeout·Abort 무시 응답 유실·늦은 성공에서도 재전송/갱신 없음`, async () => {
  const h = harness(), gate = deferred();
  if (operation === "get") await h.seed(1);
  h.state.handle = ()=>gate.promise;
  const pending = operation === "post" ? h.post() : h.get();
  await until(()=>h.state.calls.length === 1);
  assert.deepEqual([...h.timers.values()].map(timer=>timer.delay), [5000]);
  let finished = false; pending.then(()=>{ finished = true; });
  h.tick(4999); await settle(); assert.equal(finished, false);
  h.tick(1);
  const result = await pending;
  assert.equal(result.error.kind, "timeout");
  assert.equal(result.error.requestState, "unconfirmed");
  assert.equal(result.error.assistantRequestId, id(1));
  assert.equal(h.state.calls[0].init.signal.aborted, true);
  gate.resolve(json(accepted(), operation === "post" ? 202 : 200));
  await settle();
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("헤더 이후 body 수신도 5초 제한이며 늦은 JSON은 저장하지 않음", async () => {
  const h = harness(), body = deferred(), entered = deferred();
  h.state.handle = async ()=>({ ...json(accepted(), 202), text: ()=>{ entered.resolve(); return body.promise; } });
  const pending = h.post(); await entered.promise;
  h.tick(5000);
  const result = await pending;
  assert.equal(result.error.kind, "timeout");
  assert.equal(result.error.status, 202);
  assert.equal(result.error.httpRequestId, traceId);
  assert.equal(result.error.requestState, "response-received");
  body.resolve(JSON.stringify(accepted())); await settle();
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
});

test("호출 전/저장 중/전송 중 Abort를 구분하고 서버 취소 API를 자동 호출하지 않음", async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  assert.equal((await h.post(request(), controller.signal)).error.kind, "aborted");
  assert.deepEqual(h.state.storageCalls, []);
  const started = deferred(), gate = deferred(), duringSave = new AbortController();
  h.state.beforeWrite = async index=>{ if (index === 1) { started.resolve(); await gate.promise; } };
  const pending = h.post(request(), duringSave.signal); await started.promise;
  duringSave.abort(); gate.resolve();
  assert.equal((await pending).error.requestState, "not-sent");
  assert.equal(h.state.calls.length, 0);
  const network = deferred(), duringFetch = new AbortController(); h.state.handle = ()=>network.promise;
  const fetching = h.get(1, duringFetch.signal); await until(()=>h.state.calls.length === 1);
  duringFetch.abort(); assert.equal((await fetching).error.kind, "aborted");
  network.resolve(json(accepted())); await settle();
  assert.equal(h.state.calls.length, 1);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
});

test("잘못된 body/UUID/JSON 직렬화 결과는 저장·fetch 이전에 거절", async () => {
  const h = harness();
  const inheritedToJson = Object.assign(Object.create({ toJSON: ()=>null }), request());
  for (const body of [null, {}, { ...request(), requestId: "invalid" }, request(1, { type: "text", text: " " }),
    request(1, { type: "confirmation", questionId, approved: "false" }), { ...request(), extra: true }, inheritedToJson]) {
    assert.equal((await h.post(body)).error.kind, "request");
  }
  assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.storageCalls, []);
  assert.equal((await h.client.getAssistantRequest({ serverId, requestId: `${id(1)}/../bad` })).error.kind, "request");
  assert.equal((await h.client.cancelAssistantConversation("bad", { target: { type: "request", id: id(1) } },
    { expectedServerId: serverId, signal: new AbortController().signal })).error.kind, "request");
});

test("실제 JSON UTF-8 16 KiB 경계: 초과 시 저장·fetch 0회", async () => {
  const base = request(1, { type: "selection", questionId, candidateId: "" });
  const capacity = 16384 - Buffer.byteLength(JSON.stringify(base));
  const exact = { ...base, input: { ...base.input, candidateId: "a".repeat(capacity) } };
  const h = harness();
  assert.equal((await h.post(exact)).ok, true);
  assert.equal(Buffer.byteLength(h.state.calls[0].init.body), 16384);
  const over = harness();
  assert.equal((await over.post({ ...exact, input: { ...exact.input, candidateId: exact.input.candidateId + "가" } })).error.kind, "request");
  assert.deepEqual(over.state.calls, []); assert.deepEqual(over.state.storageCalls, []);
});

test("HTTP 오류 404/410/409/503와 복구 필드 보존, GET 404에서도 POST/자동 삭제 없음", async () => {
  const h = harness(); await h.seed(1);
  for (const [status, code] of [[404, "ASSISTANT_REQUEST_NOT_FOUND"], [410, "REQUEST_EXPIRED"],
    [409, "CONVERSATION_BUSY"], [409, "UNRESOLVED_UNCERTAIN"], [409, "STALE_QUESTION"], [503, "ASSISTANT_UNAVAILABLE"]]) {
    const details = problem(status, code, { assistantRequestId: id(1), blockingRequestId: id(2),
      activeQuestionId: questionId, activeQuestionRequestId: id(3), errors: null });
    h.state.handle = async ()=>json(details, status, "application/problem+json; charset=utf-8");
    const result = await h.get();
    assert.equal(result.error.kind, "http");
    assert.equal(result.error.status, status);
    assert.deepEqual(result.error.problem, details);
    assert.equal(result.error.httpRequestId, traceId);
    assert.equal(result.error.assistantRequestId, id(1));
    assert.ok(await h.recovery.read(reference()));
  }
  assert.equal(h.state.calls.length, 6);
  assert.ok(h.state.calls.every(call=>call.init.method === "GET"));
});

test("POST 409/422/503도 자동 재전송 없이 오류 code와 최초 복구 정보를 보존", async () => {
  for (const [status, code] of [[409, "REQUEST_ID_CONFLICT"], [422, "VALIDATION_ERROR"], [503, "DATABASE_UNAVAILABLE"]]) {
    const h = harness();
    const extra = code === "VALIDATION_ERROR" ? { errors: [{ location: "body", pointer: "/input/text", code: "TOO_LONG", detail: "test" }] } : {};
    h.state.handle = async ()=>json(problem(status, code, extra), status, "application/problem+json");
    const result = await h.post();
    assert.equal(result.error.kind, "http"); assert.equal(result.error.problem.code, code);
    assert.equal(h.state.calls.length, 1);
    assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
  }
});

test("잘못된 JSON·Content-Type·status·DTO·누락 헤더를 정상 응답으로 보정하지 않음", async () => {
  const cases = [()=>({ ...json(accepted(), 202), text: async ()=>"{" }), ()=>json(accepted(), 202, "text/html"),
    ()=>json({ requestId: id(1) }, 202), ()=>json(accepted(), 201), ()=>json(accepted(), 204),
    ()=>json(complete("outcome"), 202), ()=>json(accepted(), 202, "application/problem+json"),
    ()=>({ ...json(accepted(), 202), headers: new Headers({ "Content-Type": "application/json" }) })];
  for (const bad of cases) {
    const h = harness(); h.state.handle = async ()=>bad();
    const result = await h.post();
    assert.equal(result.error.kind, "response");
    assert.equal(h.state.calls.length, 1);
    assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
  }
  const h = harness(); await h.seed(1);
  h.state.handle = async ()=>json({ ...accepted(), status: "completed", result: { kind: "other", text: "test" } });
  assert.equal((await h.get()).error.kind, "response");
});

test("Problem의 status·추적 ID·논리 ID 불일치와 비표준 오류도 형식 오류로 구분", async () => {
  for (const data of [problem(500, "INTERNAL_ERROR"), problem(503, "ASSISTANT_UNAVAILABLE", { requestId: id(800) }),
    problem(503, "ASSISTANT_UNAVAILABLE", { assistantRequestId: id(2) }), { detail: "invalid" }]) {
    const h = harness(); await h.seed(1);
    h.state.handle = async ()=>json(data, 503, "application/problem+json");
    const result = await h.get();
    assert.equal(result.error.kind, "response"); assert.equal(result.error.status, 503);
    if (data.code) assert.equal(result.error.problem.code, data.code);
    assert.equal(h.state.calls.length, 1);
  }
});

test("POST/GET 논리 ID·기존 대화와 cancel target echo 불일치는 저장 갱신 전에 거부", async () => {
  const h = harness(); h.state.handle = async ()=>json(accepted(2), 202);
  assert.equal((await h.post()).error.kind, "response");
  await h.recovery.recordResponse(reference(), accepted());
  h.state.handle = async ()=>json({ ...accepted(), conversationId: id(102) });
  assert.equal((await h.get()).error.kind, "response");
  h.state.handle = async ()=>json({ target: { type: "question", id: id(1) }, targetState: "cancelled", text: "test" });
  assert.equal((await h.client.cancelAssistantConversation(conversationId, { target: { type: "request", id: id(1) } },
    { expectedServerId: serverId, signal: new AbortController().signal })).error.kind, "response");
  assert.equal((await h.recovery.read(reference())).conversationId, conversationId);
});

test("설정 누락/잘못된 origin/apiBaseUrl은 Mock fallback 없이 fetch 이전 거절", async () => {
  const h = harness();
  for (const value of [{ status: "missing" }, { status: "invalid" },
    { status: "ready", config: { ...h.state.config.config, apiBaseUrl: `${otherOrigin}/api/v1` } },
    { status: "ready", config: { ...h.state.config.config, baseUrl: `${origin}/api/v1` } }]) {
    h.state.config = value;
    const result = await h.post();
    assert.equal(result.error.kind, "configuration");
  }
  assert.equal(h.client.getServerId(), null);
  assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.storageCalls, []);
});

test("다른 서버 복구 GET/POST/cancel 차단 및 기존 서버 기록 보존", async () => {
  const h = harness(); await h.seed(1);
  h.state.config = h.config.parseDevelopmentServerConfig(otherOrigin);
  assert.equal((await h.get()).error.kind, "server-mismatch");
  assert.equal((await h.post()).error.kind, "server-mismatch");
  assert.equal((await h.client.cancelAssistantConversation(conversationId, { target: { type: "request", id: id(1) } },
    { expectedServerId: serverId, signal: new AbortController().signal })).error.kind, "server-mismatch");
  assert.equal(h.state.calls.length, 0);
  assert.equal((await h.recovery.readAll())[0].serverId, serverId);
});

test("저장 대기 중 서버 또는 모드 왕복 변경 시 이전 요청을 전송하지 않음", async () => {
  for (const change of [h=>{ h.state.config = h.config.parseDevelopmentServerConfig(otherOrigin); },
    h=>{ h.mode.getState().setMode("mock"); h.mode.getState().setMode("server"); }]) {
    const h = harness(), entered = deferred(), gate = deferred();
    h.state.beforeWrite = async ()=>{ entered.resolve(); await gate.promise; };
    const pending = h.post(); await entered.promise; change(h); gate.resolve();
    const result = await pending;
    assert.equal(result.error.kind, "context-changed");
    assert.equal(result.error.requestState, "not-sent");
    assert.equal(h.state.calls.length, 0);
    assert.equal((await h.recovery.readAll())[0].serverId, serverId);
  }
});

test("응답 대기 중 서버 변경은 늦은 응답의 metadata 갱신·현재 서버 성공 표시 차단", async () => {
  const h = harness(), gate = deferred(); h.state.handle = ()=>gate.promise;
  const pending = h.post(); await until(()=>h.state.calls.length === 1);
  h.state.config = h.config.parseDevelopmentServerConfig(otherOrigin);
  gate.resolve(json(accepted(), 202));
  const result = await pending;
  assert.equal(result.error.kind, "context-changed");
  assert.equal(result.error.serverId, serverId);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, false);
});

test("응답 저장 중 서버 변경도 원래 서버 기록만 갱신하고 새 서버 성공으로 반환하지 않음", async () => {
  const h = harness(), entered = deferred(), gate = deferred();
  h.state.beforeWrite = async index=>{ if (index === 2) { entered.resolve(); await gate.promise; } };
  const pending = h.post(); await entered.promise;
  h.state.config = h.config.parseDevelopmentServerConfig(otherOrigin); gate.resolve();
  assert.equal((await pending).error.kind, "context-changed");
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, true);
  assert.deepEqual(await h.recovery.readForServer(otherServerId), []);
  assert.equal(h.state.calls.length, 1);
});

test("명시적 Mock 모드는 전송·복구 저장을 차단하고 Schedule read-only 정책을 변경하지 않음", async () => {
  const h = harness(); h.mode.getState().setMode("mock");
  assert.equal((await h.post()).error.kind, "policy");
  assert.equal((await h.get()).error.kind, "policy");
  assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.storageCalls, []);
});

test("redirect·503·응답 유실은 Schedule의 10초/자동 retry 경로로 연결되지 않음", async () => {
  const h = harness();
  h.state.handle = async ()=>json(problem(503, "ASSISTANT_UNAVAILABLE"), 503, "application/problem+json");
  assert.equal((await h.post()).error.kind, "http");
  assert.equal(h.state.calls.length, 1);
  h.state.handle = async ()=>({ status: 307, headers: new Headers({ Location: otherOrigin }), text: async ()=>"" });
  assert.equal((await h.get()).error.kind, "response");
  assert.equal(h.state.calls.length, 2);
  assert.ok(h.state.calls.every(call=>call.init.redirect === "error"));
});

test("원래 body·결과·후보·Schedule 변경은 영속 저장되지 않고 성공 시 timer/listener 정리", async () => {
  const h = harness(), controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args)=>{ added++; return add(...args); };
  controller.signal.removeEventListener = (...args)=>{ removed++; return remove(...args); };
  await h.post(request(), controller.signal);
  h.state.handle = async ()=>json(complete("confirmation"));
  await h.get();
  const persisted = [...h.data.values()].join("");
  for (const word of ["private", "target", "changes", "candidateId", "text", "input", "body", "messages"]) assert.equal(persisted.includes(word), false, word);
  assert.equal(h.timers.size, 0); assert.equal(added, removed);
});
