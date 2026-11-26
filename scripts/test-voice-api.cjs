/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const id = n=>`${n.toString(16).padStart(8, "0")}-abcd-4abc-8abc-abcdef123456`;
const origin = "https://example.invalid";
const serverId = `development:${origin}`;
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
  const send = (url, init)=>{ assert.ok([origin,"https://other.example.invalid","http://192.0.2.5:8000"].some(base=>url.startsWith(`${base}/api/v1/`)), "real business HTTP forbidden"); state.calls.push({ url, init }); return state.handle(url, init); };
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
  const voice = load(path.join(root, "src/services/api/voice.ts")).createVoiceHttpClient({ assistant: client });
  const validation = load(path.join(root, "src/utils/voice-validation.ts"));
  return { voice, validation, state, data, timers, tick, client, api, recovery, mode, config,
    makeVoice: (assistant = client) => load(path.join(root, "src/services/api/voice.ts")).createVoiceHttpClient({ assistant }),
    env, send, commitConnection: load(path.join(root, "src/stores/scheduleDataModeStore.ts")).commitVerifiedConnection,
    post: (body = request(), signal)=>client.postAssistantRequest(body, { expectedServerId: serverId, signal }),
    get: (n = 1, signal)=>client.getAssistantRequest(reference(n), { signal }),
    seed: n=>recovery.saveBeforePost(reference(n), 1000) };
}

const bytes = () => new Uint8Array([82, 73, 70, 70, 0, 255]);
const voiceAccepted = (input = { type: "text", text: "synthetic" }) => ({ ...accepted(), transcript: "synthetic transcript", input });
const opts = () => ({ expectedServerId: serverId });
const post = (h, extra = {}, options = opts()) => h.voice.postVoiceRequest({ requestId: id(1), bytes: bytes(), ...extra }, options);
const speech = (h, options = opts()) => h.voice.getSpeech(reference(), options);
const binary = (chunks, length, extra = {}) => {
  const state = { cancelled: 0, released: 0, reads: 0 };
  return { status: 200, headers: new Headers({ "Content-Type": "audio/wav", "X-Request-ID": traceId,
    ...(length === undefined ? {} : { "Content-Length": String(length) }), ...extra }), state,
    arrayBuffer: () => { throw new Error("unbounded fallback forbidden"); },
    body: { getReader: () => ({ read: async () => { state.reads++; const value = chunks.shift(); if (value instanceof Error) throw value;
      return value === undefined ? { done: true } : { done: false, value }; },
      cancel: async () => { state.cancelled++; }, releaseLock: () => { state.released++; } }) } };
};
function ready() { const h = harness(); h.state.handle = async () => json(voiceAccepted(), 202); return h; }
test("raw snapshot, exact route, headers, trace separation, schema v1", async () => {
  const h = ready(), gate = deferred(), entered = deferred(), original = bytes();
  h.state.beforeWrite = async () => { entered.resolve(); await gate.promise; };
  const pending = post(h, { bytes: original }); await entered.promise;
  assert.equal(h.state.calls.length, 0); original.fill(0); gate.resolve();
  const r = await pending; assert.equal(r.ok, true); assert.equal(r.httpRequestId, traceId);
  const call = h.state.calls[0]; assert.equal(call.url, `${origin}/api/v1/voice/requests?requestId=${id(1)}`);
  assert.deepEqual(call.init.body, bytes()); assert.equal(call.init.headers["Content-Type"], "audio/wav");
  assert.equal(call.init.redirect, "error"); assert.equal(call.init.method, "POST");
  assert.deepEqual(r.data.state, accepted()); assert.equal(r.data.acceptance.transcript, "synthetic transcript");
  const stored = [...h.data.values()].join(); assert.ok(!stored.includes("transcript")); assert.ok(!stored.includes("synthetic"));
  assert.equal((await h.recovery.read(reference())).acceptConfirmed, true);
  assert.equal((await post(h)).error.kind, "policy"); assert.equal(h.state.calls.length, 1);
});
for (const input of [{ type: "text", questionId, text: "different wording" }, { type: "selection", questionId, candidateId: "opaque" }, { type: "confirmation", questionId, approved: false }]) {
  test(`follow-up ${input.type}`, async () => { const h = ready(); h.state.handle = async () => json(voiceAccepted(input), 202);
    assert.equal((await post(h, { conversationId, questionId })).ok, true);
    assert.equal(h.state.calls[0].url, `${origin}/api/v1/voice/requests?requestId=${id(1)}&conversationId=${conversationId}&questionId=${questionId}`); });
}
for (const extra of [{ requestId: "bad" }, { conversationId }, { questionId }, { conversationId, questionId: "bad" }, { bytes: [] }, { bytes: new Uint8Array() }, { bytes: new Uint8Array(1048577) }]) {
  test(`invalid request ${JSON.stringify(Object.keys(extra))} ${String(extra.bytes?.length)}`, async () => { const h = ready(); assert.equal((await post(h, extra)).ok, false); assert.equal(h.state.calls.length, 0); });
}
for (const field of ["requestId", "conversationId", "status", "transcript", "input"]) test(`202 missing ${field}`, async () => {
  const h = ready(), value = voiceAccepted(); delete value[field]; h.state.handle = async () => json(value, 202);
  assert.equal((await post(h)).error.kind, "response");
});
for (const patch of [{ extra: true }, { requestId: id(2) }, { conversationId: "bad" }, { status: "processing" }, { transcript: null },
  { input: { type: "text", text: "" } }, { input: { type: "confirmation", questionId, approved: "yes" } }, { input: { type: "selection", questionId, candidateId: "x", extra: 1 } }]) {
  test(`202 strict ${JSON.stringify(patch)}`, async () => { const h = ready(); h.state.handle = async () => json({ ...voiceAccepted(), ...patch }, 202); assert.equal((await post(h)).error.kind, "response"); });
}
for (const kind of ["accepted", "processing", ...Object.keys(results)]) test(`replay ${kind}`, async () => {
  const h = ready(), value = results[kind] ? complete(kind) : { ...accepted(), status: kind };
  h.state.handle = async () => json(value); const r = await post(h); assert.equal(r.ok, true); assert.deepEqual(r.data, { state: value });
});
test("replay cannot contain transcript", async () => { const h = ready(); h.state.handle = async () => json(voiceAccepted()); assert.equal((await post(h)).ok, false); });
test("storage failure sends zero requests", async () => { const h = ready(); h.state.failWriteAt = 1; assert.equal((await post(h)).error.kind, "storage"); assert.equal(h.state.calls.length, 0); });
for (const back of [false, true]) test(`storage barrier generation A-B${back ? "-A" : ""}`, async () => {
  const h = ready(), gate = deferred(), entered = deferred(); h.state.beforeWrite = async () => { entered.resolve(); await gate.promise; };
  const p = post(h); await entered.promise; h.mode.getState().setMode("mock"); if (back) h.mode.getState().setMode("server"); gate.resolve();
  assert.equal((await p).error.kind, "context-changed"); assert.equal(h.state.calls.length, 0);
});
test("beforeSend authority and concurrent same-ID guard", async () => { const h = ready(); assert.equal((await post(h, {}, { ...opts(), beforeSend: () => false })).error.kind, "policy"); assert.equal(h.state.calls.length, 0); });
test("record failure retains shared acceptance", async () => { const h = ready(); h.state.failWriteAt = 2; const r = await post(h); assert.equal(r.ok, true); assert.equal(r.metadata.status, "failed"); assert.equal(h.client.hasAcceptanceEvidence(reference()), true); assert.equal((await post(h)).error.kind, "policy"); });
test("GET evidence prevents voice POST even when record fails", async () => { const h = ready(); await h.seed(1); h.state.failWriteAt = 2; h.state.handle = async () => json(accepted()); assert.equal((await h.get()).ok, true); assert.equal((await post(h)).error.kind, "policy"); assert.equal(h.state.calls.length, 1); });
test("malformed 202 partial evidence blocks resend but never succeeds", async () => { const h = ready(); h.state.handle = async () => json({ ...voiceAccepted(), input: null }, 202); assert.equal((await post(h)).ok, false); assert.equal(h.client.hasAcceptanceEvidence(reference()), true); assert.equal((await post(h)).error.kind, "policy"); });
for (const action of ["timeout", "abort", "generation"]) test(`pending JSON body ${action}, late evidence only`, async () => {
  const h = ready(), body = deferred(), controller = new AbortController(); h.state.handle = async () => ({ ...json(null, 202), text: () => body.promise });
  const p = post(h, {}, { ...opts(), signal: controller.signal }); await until(() => h.state.calls.length === 1); await settle();
  if (action === "timeout") { assert.ok([...h.timers.values()].some(t => t.delay === 35000)); h.tick(35000); }
  if (action === "abort") controller.abort();
  if (action === "generation") { h.mode.getState().resetConnectionAuthority(); body.resolve(JSON.stringify(voiceAccepted())); }
  const r = await p; assert.equal(r.ok, false); assert.equal(r.error.kind, action === "generation" ? "context-changed" : action === "abort" ? "aborted" : "timeout");
  body.resolve(JSON.stringify(voiceAccepted())); await settle(); assert.equal(h.client.hasAcceptanceEvidence(reference()), true);
});
for (const [status, code] of [[422,"AUDIO_UNSUPPORTED"],[413,"REQUEST_BODY_TOO_LARGE"],[422,"SPEECH_NOT_RECOGNIZED"],[422,"VOICE_ANSWER_UNCLEAR"],[503,"VOICE_UNAVAILABLE"],[409,"VOICE_BUSY"],[409,"STALE_QUESTION"],[409,"QUESTION_EXPIRED"],[409,"SPEECH_NOT_READY"],[503,"TTS_UNAVAILABLE"],[409,"REQUEST_EXPIRED"],[404,"ASSISTANT_REQUEST_NOT_FOUND"],[404,"ROUTE_NOT_FOUND"],[500,"INTERNAL_ERROR"]]) test(`Problem ${status} ${code}`, async () => {
  const h = ready(); h.state.handle = async () => json(problem(status, code, { assistantRequestId: id(1) }), status, "application/problem+json");
  const r = await post(h); assert.equal(r.error.kind, "http"); assert.equal(r.error.problem.code, code); assert.equal(r.error.httpRequestId, traceId); assert.equal(h.state.calls.length, 1);
  if (code === "ROUTE_NOT_FOUND") assert.equal(h.validation.classifyVoiceProblem(status, code), "unconfirmed");
});
for (const [name, response] of [["bad JSON", { ...json(null, 202), text: async () => "{" }], ["bad media", json(voiceAccepted(), 202, "text/plain")], ["redirect", { ...json(voiceAccepted(), 202), redirected: true }], ["wrong status", json(voiceAccepted(), 201)], ["problem correlation", json(problem(409,"VOICE_BUSY",{assistantRequestId:id(5)}),409,"application/problem+json")]]) test(name, async () => { const h=ready(); h.state.handle=async()=>response; assert.equal((await post(h)).ok,false); });
for (const [name, chunks, length, ok] of [["normal",[bytes()],6,true],["no length",[bytes()],undefined,true],["invalid length",[bytes()],"bad",false],["negative length",[bytes()],-1,false],["oversized declared",[],8388609,false],["oversized actual",[new Uint8Array(8388608),bytes()],undefined,false],["exact max",[new Uint8Array(8388608)],8388608,true],["truncated",[bytes()],8,false],["false small length",[bytes()],2,false],["stream error",[bytes(),new Error("stream")],undefined,false]]) test(`speech ${name}`, async () => {
  const h=ready(), response=binary(chunks,length); h.state.handle=async()=>response; const r=await speech(h); assert.equal(r.ok,ok); assert.ok(response.state.cancelled>0); assert.equal(response.state.released,1);
  assert.equal(h.state.calls[0].url,`${origin}/api/v1/voice/requests/${id(1)}/speech`);
});
for (const action of ["timeout","abort","generation"]) test(`speech pending chunk ${action}`,async()=>{
  const h=ready(), gate=deferred(), controller=new AbortController(), response=binary([]); let cancelled=0,released=0;
  response.body.getReader=()=>({read:()=>gate.promise,cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}}); h.state.handle=async()=>response;
  const p=speech(h,{...opts(),signal:controller.signal}); await until(()=>h.state.calls.length===1); await settle();
  if(action==="timeout") h.tick(35000); if(action==="abort") controller.abort(); if(action==="generation") {h.mode.getState().resetConnectionAuthority(); gate.resolve({done:false,value:bytes()});}
  assert.equal((await p).ok,false); assert.ok(cancelled>0); gate.resolve({done:true}); await settle(); assert.equal(released,1);
});
test("speech rejects media and missing stream without arrayBuffer",async()=>{for(const response of [binary([],undefined,{"Content-Type":"audio/mpeg"}),{...binary([]),body:null}]){const h=ready();h.state.handle=async()=>response;assert.equal((await speech(h)).ok,false);}});
test("upper UUID and exact input size boundary", async () => {
  const h=ready();assert.equal((await post(h,{requestId:id(1).toUpperCase(),bytes:new Uint8Array(1048576)})).ok,true);
});
test("follow-up conversation and question correlations",async()=>{
  for(const patch of [{conversationId:id(7)}, {input:{type:"text",text:"x",questionId:id(7)}}]){
    const h=ready();h.state.handle=async()=>json({...voiceAccepted({type:"text",text:"x",questionId}),...patch},202);
    assert.equal((await post(h,{conversationId,questionId})).ok,false);
  }
});
test("concurrent same ID is blocked during storage",async()=>{
  const h=ready(), gate=deferred(), entered=deferred(); h.state.beforeWrite=async()=>{entered.resolve();await gate.promise;};
  const p=post(h);await entered.promise;assert.equal((await post(h)).error.kind,"policy");gate.resolve();assert.equal((await p).ok,true);assert.equal(h.state.calls.length,1);
});
test("beforeSend generation change blocks actual fetch",async()=>{
  const h=ready();const r=await post(h,{}, {...opts(),beforeSend:()=>{h.mode.getState().resetConnectionAuthority();return true;}});
  assert.equal(r.error.kind,"context-changed");assert.equal(h.state.calls.length,0);
});
test("invalid signal and expected generation fail before transport",async()=>{
  const h=ready();assert.equal((await post(h,{}, {...opts(),signal:{aborted:false}})).error.kind,"request");
  assert.equal((await post(h,{}, {...opts(),expectedGeneration:99})).error.kind,"context-changed");assert.equal(h.state.calls.length,0);
});
test("wrong status for voice code is response error",async()=>{
  const h=ready();h.state.handle=async()=>json(problem(500,"VOICE_BUSY"),500,"application/problem+json");assert.equal((await post(h)).error.kind,"response");
  assert.equal(h.validation.classifyVoiceProblem(500,"AUDIO_UNSUPPORTED"),"unconfirmed");
});
test("network failure is unconfirmed without retry",async()=>{const h=ready();h.state.handle=async()=>{throw new Error("network");};const r=await post(h);assert.equal(r.error.kind,"network");assert.equal(r.error.requestState,"unconfirmed");assert.equal(h.state.calls.length,1);});
for(const route of ["post","speech"]) test(`pending header ${route} timeout and late response`,async()=>{
  const h=ready(), gate=deferred();h.state.handle=()=>gate.promise;const p=route==="post"?post(h):speech(h);await until(()=>h.state.calls.length===1);h.tick(35000);assert.equal((await p).error.kind,"timeout");
  gate.resolve(route==="post"?json(voiceAccepted(),202):binary([bytes()]));await settle();
});
test("synthetic registry rejects missing route and exhausted fixture without fallback",async()=>{
  const h=ready(), fixtures=[json(voiceAccepted(),202)];
  h.state.handle=async(url,init)=>{if(init.method!=="POST"||!url.includes("/voice/requests?"))throw new Error("unregistered route");if(!fixtures.length)throw new Error("fixture exhausted");return fixtures.shift();};
  assert.equal((await post(h)).ok,true);assert.equal((await speech(h)).ok,false);
  assert.equal((await post(h,{requestId:id(2)})).error.kind,"network");assert.equal(h.state.calls.length,3);
});
test("speech standard errors use GET expiry status",async()=>{
  for(const [status,code] of [[410,"REQUEST_EXPIRED"],[409,"VOICE_BUSY"],[409,"SPEECH_NOT_READY"],[503,"TTS_UNAVAILABLE"]]){const h=ready();h.state.handle=async()=>json(problem(status,code),status,"application/problem+json");assert.equal((await speech(h)).error.kind,"http");assert.equal(h.state.calls.length,1);}
});

test("review BLOCKER1 abort during acceptance storage retains evidence without success", async () => {
  const h=ready(), gate=deferred(), entered=deferred(), controller=new AbortController();
  h.state.beforeWrite=async index=>{if(index===2){entered.resolve();await gate.promise;}};
  const pending=post(h,{}, {...opts(),signal:controller.signal});await entered.promise;controller.abort();gate.resolve();
  const r=await pending;assert.equal(r.ok,false);assert.equal(r.error.kind,"aborted");assert.equal(r.error.requestState,"response-received");
  assert.equal((await h.recovery.read(reference())).acceptConfirmed,true);assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);
  assert.equal((await post(h)).error.kind,"policy");
});
for(const status of [202,200]) test(`review BLOCKER2 stale valid ${status} persists original metadata`, async()=>{
  const h=ready(), gate=deferred();h.state.handle=async()=>({...json(null,status),text:()=>gate.promise});
  const p=post(h);await until(()=>h.state.calls.length===1);await settle();h.mode.getState().resetConnectionAuthority();
  gate.resolve(JSON.stringify(status===202?voiceAccepted():accepted()));const r=await p;assert.equal(r.error.kind,"context-changed");
  assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);assert.equal((await h.recovery.read(reference())).acceptConfirmed,true);
});
for(const upper of [false,true]) test(`review BLOCKER3 clients share in-flight ID lock uppercase=${upper}`,async()=>{
  const h=ready(), other=h.makeVoice(), gate=deferred(), entered=deferred();
  h.state.beforeWrite=async index=>{if(index===1){entered.resolve();await gate.promise;}};
  const p=post(h);await entered.promise;
  const second=other.postVoiceRequest({requestId:upper?id(1).toUpperCase():id(1),bytes:bytes()},opts());await settle();gate.resolve();
  const [a,b]=await Promise.all([p,second]);assert.equal(a.ok,true);assert.equal(b.ok,false);assert.equal(b.error.kind,"policy");assert.equal(h.state.calls.length,1);
});
for(const upper of [false,true]) test(`review BLOCKER3 HTTP overlap across clients uppercase=${upper}`,async()=>{
  const h=ready(), other=h.makeVoice(), gate=deferred();h.state.handle=()=>gate.promise;
  const a=post(h);await until(()=>h.state.calls.length===1);
  const b=other.postVoiceRequest({requestId:upper?id(1).toUpperCase():id(1),bytes:bytes()},opts());await settle();
  const count=h.state.calls.length;gate.resolve(json(voiceAccepted(),202));await Promise.all([a,b]);assert.equal(count,1);
});

for(const failed of [false,true]) for(const change of ["none","B","ABA"]) test(`review acceptance storage Abort failed=${failed} change=${change}`,async()=>{
  const h=ready(), gate=deferred(), entered=deferred(), c=new AbortController();
  if(failed)h.state.failWriteAt=2;h.state.beforeWrite=async i=>{if(i===2){entered.resolve();await gate.promise;}};
  const p=post(h,{}, {...opts(),signal:c.signal});await entered.promise;c.abort();
  if(change!=="none"){h.mode.getState().setMode("mock");if(change==="ABA")h.mode.getState().setMode("server");}
  gate.resolve();const r=await p;assert.equal(r.ok,false);assert.equal(r.error.kind,change==="none"?"aborted":"context-changed");
  assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);assert.equal((await h.recovery.read(reference())).acceptConfirmed,!failed);assert.equal(h.state.calls.length,1);
});
for(const kind of ["timeout","abort"]) test(`review ${kind} late valid response remains memory-only`,async()=>{
  const h=ready(), gate=deferred(), c=new AbortController();h.state.handle=async()=>({...json(null,202),text:()=>gate.promise});
  const p=post(h,{}, {...opts(),signal:c.signal});await until(()=>h.state.calls.length===1);await settle();
  if(kind==="timeout")h.tick(35000);else c.abort();assert.equal((await p).ok,false);
  gate.resolve(JSON.stringify(voiceAccepted()));await settle();assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed,false);assert.equal(h.state.storageCalls.filter(x=>x.type==="set").length,1);
});
for(const patch of [{input:null},{requestId:id(2)},{conversationId:id(7)}]) test(`review stale partial or mismatch ${JSON.stringify(patch)}`,async()=>{
  const h=ready(), gate=deferred();h.state.handle=async()=>({...json(null,202),text:()=>gate.promise});
  const p=post(h,{conversationId,questionId});await until(()=>h.state.calls.length===1);await settle();h.mode.getState().resetConnectionAuthority();
  gate.resolve(JSON.stringify({...voiceAccepted({type:"text",text:"x",questionId}),...patch}));assert.equal((await p).ok,false);
  assert.equal((await h.recovery.read(reference())).acceptConfirmed,false);assert.equal(h.voice.hasAcceptanceEvidence(reference()),patch.input===null);
});
for(const recreate of [false,true]) test(`review stale response cannot restore deleted/recreated metadata recreate=${recreate}`,async()=>{
  const h=ready(), gate=deferred();h.state.handle=async()=>({...json(null,202),text:()=>gate.promise});
  const p=post(h);await until(()=>h.state.calls.length===1);await settle();
  await h.recovery.removeManually(reference(),{confirmed:true});if(recreate)await h.recovery.saveBeforePost(reference(),2000);
  h.mode.getState().resetConnectionAuthority();gate.resolve(JSON.stringify(voiceAccepted()));assert.equal((await p).ok,false);
  const saved=await h.recovery.read(reference());if(recreate){assert.equal(saved.firstPostAttemptAt,2000);assert.equal(saved.acceptConfirmed,false);}else assert.equal(saved,null);
  assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);
});
test("review stale valid response storage failure retains memory evidence",async()=>{
  const h=ready(), gate=deferred();h.state.failWriteAt=2;h.state.handle=async()=>({...json(null,202),text:()=>gate.promise});
  const p=post(h);await until(()=>h.state.calls.length===1);await settle();h.state.config=h.config.parseDevelopmentServerConfig("https://other.example.invalid");h.mode.getState().resetConnectionAuthority();gate.resolve(JSON.stringify(voiceAccepted()));
  assert.equal((await p).error.kind,"context-changed");assert.equal(h.voice.hasAcceptanceEvidence(reference()),true);assert.equal((await h.recovery.read(reference())).acceptConfirmed,false);
});
test("review stale original server response persists despite current server B",async()=>{
  const h=ready(), gate=deferred();h.state.handle=async()=>({...json(null,202),text:()=>gate.promise});const p=post(h);await until(()=>h.state.calls.length===1);await settle();
  h.state.config=h.config.parseDevelopmentServerConfig("https://other.example.invalid");h.mode.getState().resetConnectionAuthority();gate.resolve(JSON.stringify(voiceAccepted()));
  assert.equal((await p).error.kind,"context-changed");assert.equal((await h.recovery.read(reference())).acceptConfirmed,true);
  assert.equal((await h.recovery.read({serverId:"development:https://other.example.invalid",requestId:id(1)})),null);
});
for(const pre of [false,true]) test(`review Abort before/during save pre=${pre}`,async()=>{
  const h=ready(), c=new AbortController(), gate=deferred(), entered=deferred();
  if(pre)c.abort();else h.state.beforeWrite=async()=>{entered.resolve();await gate.promise;};
  const p=post(h,{}, {...opts(),signal:c.signal});if(!pre){await entered.promise;c.abort();gate.resolve();}
  const r=await p;assert.equal(r.error.kind,"aborted");assert.equal(r.error.requestState,"not-sent");assert.equal(h.state.calls.length,0);
  assert.equal((await h.recovery.read(reference()))!==null,!pre);
});
test("review options snapshot fixes signal and callback before storage await",async()=>{
  const h=ready(), gate=deferred(), entered=deferred(), c=new AbortController();let originalCalls=0;
  h.state.beforeWrite=async()=>{entered.resolve();await gate.promise;};const options={...opts(),signal:c.signal,beforeSend:()=>{originalCalls++;return false;}};
  const p=post(h,{},options);await entered.promise;options.signal=new AbortController().signal;options.beforeSend=()=>true;options.expectedServerId="changed";gate.resolve();
  assert.equal((await p).error.kind,"policy");assert.equal(originalCalls,1);assert.equal(h.state.calls.length,0);
});
test("review options signal replacement cannot evade original Abort",async()=>{
  const h=ready(), gate=deferred(), entered=deferred(), c=new AbortController();h.state.beforeWrite=async()=>{entered.resolve();await gate.promise;};
  const options={...opts(),signal:c.signal};const p=post(h,{},options);await entered.promise;options.signal=new AbortController().signal;c.abort();gate.resolve();assert.equal((await p).error.kind,"aborted");assert.equal(h.state.calls.length,0);
});
test("review beforeSend throw is not network uncertainty and callback evidence blocks send",async()=>{
  for(const throwError of [true,false]){const h=ready();const r=await post(h,{}, {...opts(),beforeSend:()=>{if(throwError)throw new Error("callback");h.client.exchange.noteAcceptance(reference());return true;}});
  assert.equal(r.error.kind,"policy");assert.equal(r.error.requestState,"not-sent");assert.equal(h.state.calls.length,0);}
});
for(const signal of [{aborted:"no",addEventListener(){},removeEventListener(){}},{aborted:false,addEventListener(){}},null]) test(`review invalid AbortSignal ${JSON.stringify(signal)}`,async()=>{
  const h=ready();assert.equal((await post(h,{}, {...opts(),signal})).error.kind,"request");assert.equal(h.state.storageCalls.length,0);
});
test("review speech expected server mismatch and malformed input return errors",async()=>{
  const h=ready();assert.equal((await speech(h,{expectedServerId:"development:https://other.example.invalid"})).error.kind,"server-mismatch");
  for(const ref of [null,{}, {serverId,requestId:"bad"}])assert.equal((await h.voice.getSpeech(ref,opts())).error.kind,"request");
  for(const options of [null,{}, {expectedServerId:0}])assert.equal((await h.voice.getSpeech(reference(),options)).error.kind,"request");assert.equal(h.state.calls.length,0);
});
test("review shared lock allows other IDs and servers",async()=>{
  const h=ready(), gate=deferred();h.state.handle=(url)=>url.includes(`requestId=${id(1)}`)&&url.startsWith(origin)?gate.promise:Promise.resolve(json({...voiceAccepted(),requestId:id(2)},202));
  const p=post(h);await until(()=>h.state.calls.length===1);
  assert.equal((await h.makeVoice().postVoiceRequest({requestId:id(2),bytes:bytes()},opts())).ok,true);
  const target=h.config.parseDevelopmentServerConfig("https://other.example.invalid");const other=h.makeVoice(h.api.createAssistantHttpClient({fetchImpl:h.send,recovery:h.recovery,readConfig:()=>target,now:()=>1000}));
  h.state.handle=(url)=>url.startsWith(origin)?gate.promise:Promise.resolve(json(voiceAccepted(),202));
  assert.equal((await other.postVoiceRequest({requestId:id(1),bytes:bytes()},{expectedServerId:target.config.serverId})).ok,true);
  gate.resolve(json(voiceAccepted(),202));await p;assert.equal(h.state.calls.length,3);
});
test("review old late finally does not unlock newer invocation after timeout and ABA",async()=>{
  const h=ready(), other=h.makeVoice(), old=deferred(), fresh=deferred();h.state.handle=()=>old.promise;
  const a=post(h);await until(()=>h.state.calls.length===1);h.tick(35000);assert.equal((await a).error.kind,"timeout");
  h.mode.getState().setMode("mock");h.mode.getState().setMode("server");h.state.handle=()=>fresh.promise;
  const b=other.postVoiceRequest({requestId:id(1),bytes:bytes()},opts());await until(()=>h.state.calls.length===2);
  old.resolve(json(null,500,"text/plain"));await settle();assert.equal((await post(h)).error.kind,"policy");
  fresh.resolve(json(voiceAccepted(),202));assert.equal((await b).ok,true);assert.equal(h.state.calls.length,2);
});

for(const scenario of ["EOF","actual overflow","declared overflow","read failure"])test(`review reader single cleanup ${scenario}`,async()=>{
  const h=ready(), response=binary(scenario==="actual overflow"?[new Uint8Array(8388608),bytes()]:scenario==="read failure"?[new Error("read")]:[bytes()],scenario==="declared overflow"?8388609:undefined);
  h.state.handle=async()=>response;assert.equal((await speech(h)).ok,scenario==="EOF");assert.equal(response.state.cancelled,1);assert.equal(response.state.released,1);assert.equal(h.state.calls[0].init.signal.aborted,true);
});
for(const mode of ["reject","throw","delay","release throws"])test(`review reader cleanup ${mode} cannot replace result`,async()=>{
  const h=ready(), gate=deferred();let cancels=0,releases=0;const response=binary([]);response.body.getReader=()=>({read:async()=>({done:true}),cancel:()=>{cancels++;if(mode==="throw")throw new Error("cancel");if(mode==="reject")return Promise.reject(new Error("cancel"));return mode==="delay"?gate.promise:Promise.resolve();},releaseLock:()=>{releases++;if(mode==="release throws")throw new Error("release");}});
  h.state.handle=async()=>response;assert.equal((await speech(h)).ok,true);assert.equal(cancels,1);assert.equal(releases,1);gate.resolve();await settle();
});
for(const action of ["timeout","abort","ABA"])test(`review pending read noncooperative cancel ${action}`,async()=>{
  const h=ready(), read=deferred(), cancel=deferred(), c=new AbortController(), response=binary([]);let cancels=0,releases=0;
  response.body.getReader=()=>({read:()=>read.promise,cancel:()=>{cancels++;return cancel.promise;},releaseLock:()=>{releases++;}});h.state.handle=async()=>response;
  const p=speech(h,{...opts(),signal:c.signal});await until(()=>h.state.calls.length===1);await settle();
  if(action==="timeout")h.tick(35000);else if(action==="abort")c.abort();else{h.mode.getState().setMode("mock");h.mode.getState().setMode("server");read.resolve({done:false,value:bytes()});}
  const r=await p;assert.equal(r.error.kind,action==="timeout"?"timeout":action==="abort"?"aborted":"context-changed");assert.equal(cancels,1);assert.equal(releases,1);
  read.resolve({done:true});cancel.resolve();await settle();assert.equal(cancels,1);assert.equal(releases,1);
});
test("review late speech headers discard body without reading",async()=>{
  const h=ready(), gate=deferred(), response=binary([bytes()]);h.state.handle=()=>gate.promise;const p=speech(h);await until(()=>h.state.calls.length===1);h.tick(35000);assert.equal((await p).error.kind,"timeout");
  gate.resolve(response);await settle();assert.equal(response.state.reads,0);assert.equal(response.state.cancelled,1);assert.equal(response.state.released,1);
});
test("review real ReadableStream lock is released on timeout",async()=>{
  const h=ready(), response=binary([]);let cancelled=0;const body=new ReadableStream({cancel(){cancelled++;}});response.body=body;h.state.handle=async()=>response;
  const p=speech(h);await until(()=>body.locked);h.tick(35000);assert.equal((await p).error.kind,"timeout");await settle();assert.equal(body.locked,false);assert.equal(cancelled,1);
});
test("review empty chunks do not change payload or retain chunk copies",async()=>{
  const h=ready(), response=binary([...Array.from({length:10000},()=>new Uint8Array()),bytes()]);h.state.handle=async()=>response;
  const r=await speech(h);assert.equal(r.ok,true);assert.deepEqual(r.data,bytes());assert.equal(response.state.cancelled,1);assert.equal(response.state.released,1);
});
test("review virtual Pi requires connection authority and exact port 8000",async()=>{
  const h=ready();h.env.EXPO_PUBLIC_SERVER_TARGET="pi";
  const target=h.config.createPiCandidate("192.0.2.5");const client=h.makeVoice(h.api.createAssistantHttpClient({recovery:h.recovery,now:()=>1000}));
  assert.equal((await client.postVoiceRequest({requestId:id(1),bytes:bytes()},{expectedServerId:target.serverId})).ok,false);assert.equal(h.state.calls.length,0);
  h.commitConnection(target,{kind:"http",fetchImpl:h.send});assert.equal((await client.postVoiceRequest({requestId:id(1),bytes:bytes()},{expectedServerId:target.serverId})).ok,true);
  assert.equal(h.state.calls[0].url,`http://192.0.2.5:8000/api/v1/voice/requests?requestId=${id(1)}`);
  h.state.handle=async()=>binary([bytes()]);assert.equal((await client.getSpeech({serverId:target.serverId,requestId:id(1)},{expectedServerId:target.serverId})).ok,true);
  assert.equal(h.state.calls[1].url,`http://192.0.2.5:8000/api/v1/voice/requests/${id(1)}/speech`);
});
for(const base of ["http://192.0.2.5:8081","http://192.0.2.5:8080","http://192.0.2.5:8000/extra"])test(`review invalid Pi target ${base}`,async()=>{
  const h=ready();h.state.config={status:"ready",config:{baseUrl:base,apiBaseUrl:`${base}/api/v1`,serverId:`pi:${base}`}};
  assert.equal((await post(h,{}, {expectedServerId:`pi:${base}`})).error.kind,"configuration");assert.equal(h.state.calls.length,0);
});
test("review Mock data mode and read-only block Voice POST",async()=>{
  for(const readOnly of [false,true]){const h=ready();if(readOnly)h.env.EXPO_PUBLIC_SCHEDULE_READ_ONLY="true";else h.mode.getState().setMode("mock");
  assert.equal((await post(h)).error.kind,"policy");assert.equal(h.state.calls.length,0);assert.equal(h.state.storageCalls.length,0);}
});
test("review mock transport never falls back to native HTTP",async()=>{
  const h=ready(), target=h.config.createDevelopmentTarget(origin,"mock");h.state.config={status:"ready",config:target};
  const unsafe=h.makeVoice(h.api.createAssistantHttpClient({readConfig:()=>h.state.config,recovery:h.recovery}));
  assert.equal((await unsafe.postVoiceRequest({requestId:id(1),bytes:bytes()},{expectedServerId:target.serverId})).error.kind,"configuration");assert.equal(h.state.calls.length,0);assert.equal(h.state.nativeCalls.length,0);
  h.state.handle=async()=>{throw new Error("exhausted mock fixture");};assert.equal((await post(h,{}, {expectedServerId:target.serverId})).error.kind,"network");assert.equal(h.state.nativeCalls.length,0);assert.equal(h.state.calls.length,1);
});
for(const [status,code] of [[500,"CONVERSATION_BUSY"],[410,"REQUEST_EXPIRED"],[503,"REQUEST_ID_CONFLICT"],[422,"ASSISTANT_REQUEST_NOT_FOUND"]])test(`review exact POST error pair ${status}/${code}`,async()=>{
  const h=ready();h.state.handle=async()=>json(problem(status,code),status,"application/problem+json");assert.equal((await post(h)).error.kind,"response");assert.equal((await h.recovery.read(reference())).acceptConfirmed,false);
});
test("review absent logical ID remains HTTP error without cleanup authority",async()=>{
  const h=ready();h.state.handle=async()=>json(problem(422,"AUDIO_UNSUPPORTED"),422,"application/problem+json");const r=await post(h);
  assert.equal(r.error.kind,"http");assert.equal(r.error.problem.assistantRequestId,undefined);assert.equal(r.error.httpRequestId,traceId);assert.equal(r.error.assistantRequestId,id(1));
  assert.equal(h.validation.classifyVoiceProblem(422,"AUDIO_UNSUPPORTED"),"rejection-candidate");assert.equal((await h.recovery.read(reference())).acceptConfirmed,false);
  assert.equal(h.validation.classifyVoiceProblem(404,"ROUTE_NOT_FOUND"),"unconfirmed");assert.equal(h.validation.classifyVoiceProblem(409,"VOICE_BUSY"),"unconfirmed");
  assert.equal(h.validation.classifyVoiceProblem(409,"REQUEST_EXPIRED",true),"unconfirmed");assert.equal(h.validation.classifyVoiceProblem(410,"REQUEST_EXPIRED",true),"expired");
});
