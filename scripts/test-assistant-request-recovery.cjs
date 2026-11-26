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
const ref = (n=1)=>({ serverId, requestId: id(n) });
const request = (n=1)=>({ requestId: id(n), input: { type: "text", text: "  원문 입력  " } });
const accepted = (status="accepted")=>({ requestId: id(1), conversationId: id(100), status });
const summary = { id: id(200), title: "일정", scheduledAt: "2026-11-12T00:00:00Z", category: "OTHER", completed: false, updatedAt: "2026-11-11T00:00:00Z" };
const results = {
  need_more_info: { kind: "need_more_info", text: "추가 정보", questionId: id(101) },
  candidate_selection: { kind: "candidate_selection", text: "후보", questionId: id(101), expiresAt: "2026-11-12T01:00:00Z",
    candidates: [1,2].map(n=>({ candidateId: `opaque/${n}`, title: "후보", scheduledAt: summary.scheduledAt, category: "OTHER" })) },
  confirmation: { kind: "confirmation", text: "확인", questionId: id(101), expiresAt: "2026-11-12T01:00:00Z", operation: "update", target: summary, changes: { completed: false } },
  outcome: { kind: "outcome", text: "조회", outcome: "success", operation: "list", schedulesChanged: false, items: [summary] },
  failure: { kind: "failure", text: "실패", code: "MODEL_TIMEOUT", nextAction: "retry_later" },
  uncertain: { kind: "uncertain", text: "미확인", code: "EXECUTION_RESULT_UNKNOWN", nextAction: "check_status" },
};
const json = (body,status=200)=>({ status, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": id(900) }), text: async()=>JSON.stringify(body) });
const problem = (status=404,code="ASSISTANT_REQUEST_NOT_FOUND",extra={})=>({ status,
  headers: new Headers({ "Content-Type": "application/problem+json", "X-Request-ID": id(900) }),
  text: async()=>JSON.stringify({ type: "https://example.invalid/problem", title: "오류", detail: "문구를 해석하지 않음", instance: "/api/v1/assistant/requests", status, code, requestId: id(900), assistantRequestId: id(1), ...extra }) });
const deferred = ()=>{ let resolve; const promise=new Promise(r=>{ resolve=r; }); return {promise,resolve}; };
async function until(predicate){ for(let n=0;n<300&&!predicate();n++)await Promise.resolve();assert.ok(predicate()); }
const settle = async()=>{for(let n=0;n<100;n++)await Promise.resolve();};

// 실제 HTTP·저장소 코드를 실행하되 fetch·AsyncStorage·시계만 프로세스 전용 대역으로 바꾼다.
function harness({ data=new Map() }={}) {
  const cache=new Map(),timers=new Map();let time=1000,timerId=0,writes=0,reads=0;
  const state={ calls:[], storageCalls:[], config:null, failRead:false, failWriteAt:0, beforeWrite:null,
    handle:async(url,init)=>{if(init.method==="POST")throw new Error("응답 유실");return problem();} };
  const adapter={
    async getItem(key){state.storageCalls.push("read");reads++;if(state.failRead)throw new Error("읽기 실패");return data.get(key)??null;},
    async setItem(key,value){state.storageCalls.push("write");const index=++writes;if(state.beforeWrite)await state.beforeWrite(index);
      if(index===state.failWriteAt)throw new Error("쓰기 실패");data.set(key,value);},
  };
  const send=(url,init)=>{state.calls.push({url,init});return state.handle(url,init);};
  function load(name){
    if(name==="expo/fetch")return {fetch:send};
    if(name==="@react-native-async-storage/async-storage")return adapter;
    if(name==="zustand/vanilla")return require(name);
    assert.ok(name.startsWith("@/"));assert.notEqual(name,"@/services/api/http");
    const file=path.join(root,"src",`${name.slice(2)}.ts`);if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:file}).outputText;
    new Function("require","module","exports","fetch","setTimeout","clearTimeout","process",code)(load,module,module.exports,
      ()=>{throw new Error("실제 네트워크 금지");},
      (fn,delay)=>{const token=++timerId;timers.set(token,{fn,at:time+delay});return token;},token=>timers.delete(token),{env:{EXPO_PUBLIC_DEV_SERVER_BASE_URL:origin}});
    return module.exports;
  }
  const config=load("@/services/api/config");state.config=config.parseDevelopmentServerConfig(origin);
  const storage=load("@/services/storage/assistant-recovery").assistantRecoveryStorage;
  const mode=load("@/stores/scheduleDataModeStore").scheduleDataModeStore;
  const createHttp=()=>load("@/services/api/assistant").createAssistantHttpClient({fetchImpl:send,recovery:storage,readConfig:()=>state.config,now:()=>time});
  const http=createHttp();
  const api=load("@/services/api/assistant-request-recovery");
  const create=(client=http)=>api.createAssistantRequestRecovery({http:client,recovery:storage,now:()=>time});
  const controller=create();
  return {state,data,storage,mode,http,config,create,createHttp,controller,timers,
    get reads(){return reads;},get time(){return time;},set time(value){time=value;},
    tick(ms){time+=ms;for(const [key,t]of [...timers])if(t.at<=time){timers.delete(key);t.fn();}},
    start:(input=request(),signal)=>controller.startAssistantRequest(input,{expectedServerId:serverId,signal}),
    recover:signal=>controller.recoverAssistantRequest(ref(),{signal}),
    methods:()=>state.calls.map(c=>c.init.method),
  };
}

test("import/factory만으로 I/O 없음, POST 응답 유실 후 원래 ID GET 우선 및 동일 body 재전송 1회",async()=>{
  const h=harness();assert.deepEqual(h.state.calls,[]);assert.deepEqual(h.state.storageCalls,[]);
  const initial=await h.start();assert.equal(initial.kind,"unconfirmed");
  h.state.handle=async(url,init)=>init.method==="GET"?problem():json(accepted(),200);
  const recovered=await h.recover();assert.equal(recovered.kind,"confirmed");assert.equal(recovered.via,"resend");assert.equal(recovered.retransmitted,true);
  assert.deepEqual(h.methods(),["POST","GET","POST"]);
  assert.equal(h.state.calls[1].url,`${origin}/api/v1/assistant/requests/${id(1)}`);
  assert.equal(h.state.calls[0].init.body,h.state.calls[2].init.body);
  assert.equal(recovered.response.httpRequestId,id(900));assert.equal(recovered.response.data.requestId,id(1));
});

for(const status of ["accepted","processing"])test(`GET 200 ${status} 보존·POST 재전송 없음`,async()=>{
  const h=harness();await h.start();h.state.handle=async()=>json(accepted(status));
  const result=await h.recover();assert.equal(result.kind,"confirmed");assert.equal(result.via,"get");assert.equal(result.response.data.status,status);
  assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).acceptConfirmed,true);
});

for(const [kind,value]of Object.entries(results))test(`GET completed ${kind}는 원본 의미·DTO 보존`,async()=>{
  const h=harness();await h.start();h.state.handle=async()=>json({...accepted("completed"),result:value});
  const result=await h.recover();assert.equal(result.kind,"confirmed");assert.deepEqual(result.response.data.result,value);
  assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).lastResultKind,kind);
});

test("정확한 not-found 외 404/410/409/500/503은 재전송 없이 Problem 복구 필드 보존",async()=>{
  for(const [status,code]of [[404,"ROUTE_NOT_FOUND"],[410,"REQUEST_EXPIRED"],[409,"CONVERSATION_BUSY"],[409,"UNRESOLVED_UNCERTAIN"],[409,"STALE_QUESTION"],[500,"INTERNAL_ERROR"],[503,"MODEL_UNAVAILABLE"]]){
    const h=harness();await h.start();h.state.handle=async()=>problem(status,code,{blockingRequestId:id(2),activeQuestionId:id(3),activeQuestionRequestId:id(4)});
    const result=await h.recover();assert.equal(result.kind,"unconfirmed");assert.equal(result.getResult.error.status,status);assert.equal(result.getResult.error.problem.code,code);
    assert.equal(result.getResult.error.problem.activeQuestionRequestId,id(4));assert.equal(result.getResult.error.problem.blockingRequestId,id(2));
    assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
  }
});

test("GET 네트워크 오류·잘못된 JSON/DTO/Content-Type은 POST 0회",async()=>{
  for(const handle of [async()=>{throw Error("네트워크");},async()=>({...json({}),text:async()=>"{"}),async()=>json({...accepted("completed"),result:{kind:"invalid"}}),async()=>({...json(accepted()),headers:new Headers({"Content-Type":"text/html"})})]){
    const h=harness();await h.start();h.state.handle=handle;const result=await h.recover();
    assert.equal(result.kind,"unconfirmed");assert.ok(["network","response"].includes(result.getResult.error.kind));assert.deepEqual(h.methods(),["POST","GET"]);
  }
});

test("GET 5초 timeout·늦은 404에서도 재전송·삭제 없음",async()=>{
  const h=harness();await h.start();const gate=deferred();h.state.handle=()=>gate.promise;
  const pending=h.recover();await until(()=>h.state.calls.length===2);h.tick(5000);
  const result=await pending;assert.equal(result.getResult.error.kind,"timeout");gate.resolve(problem());await settle();
  assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
});

test("최초 POST timeout 뒤 늦은 접수 응답이 GET processing 확인을 덮지 않음",async()=>{
  const h=harness(),gate=deferred();h.state.handle=()=>gate.promise;const pending=h.start();await until(()=>h.state.calls.length===1);h.tick(5000);await pending;
  h.state.handle=async()=>json(accepted("processing"));assert.equal((await h.recover()).kind,"confirmed");
  gate.resolve(json(accepted(),202));await settle();assert.equal((await h.storage.read(ref())).lastStatus,"processing");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("정상 POST 202/200 접수 확인 뒤 GET 404여도 재전송 금지",async()=>{
  for(const status of [202,200]){const h=harness();h.state.handle=async()=>json(accepted(),status);assert.equal((await h.start()).kind,"confirmed");
    h.state.handle=async()=>problem();const result=await h.recover();assert.equal(result.reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET"]);}
});

test("POST 성공 후 recordResponse 실패도 메모리의 접수 증거로 재전송 차단",async()=>{
  const h=harness();h.state.failWriteAt=2;h.state.handle=async()=>json(accepted(),202);
  const original=await h.start();assert.equal(original.kind,"confirmed");assert.equal(original.response.metadata.status,"failed");assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
  h.state.handle=async()=>problem();assert.equal((await h.recover()).reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("GET 200 후 metadata 저장 실패도 재전송 금지 증거 유지",async()=>{
  const h=harness();await h.start();h.state.failWriteAt=2;h.state.handle=async()=>json(accepted());
  const first=await h.recover();assert.equal(first.kind,"confirmed");assert.equal(first.response.metadata.status,"failed");
  h.state.handle=async()=>problem();assert.equal((await h.recover()).reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET","GET"]);
});

test("다른 HTTP factory의 GET 접수 확인·저장 실패도 runtime 접수 증거로 공유",async()=>{
  const h=harness();await h.start();h.state.failWriteAt=2;h.state.handle=async()=>json(accepted());
  const outside=await h.createHttp().getAssistantRequest(ref());assert.equal(outside.ok,true);assert.equal(outside.metadata.status,"failed");
  assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
  h.state.handle=async()=>problem();assert.equal((await h.create().recoverAssistantRequest(ref())).reason,"accept-confirmed");
  assert.deepEqual(h.methods(),["POST","GET","GET"]);
});

test("제한 재전송 성공 뒤 metadata 저장 실패도 추가 재전송 금지",async()=>{
  const h=harness();await h.start();h.state.failWriteAt=3;
  h.state.handle=async(url,init)=>init.method==="GET"?problem():json(accepted(),200);
  const result=await h.recover();assert.equal(result.kind,"confirmed");assert.equal(result.response.metadata.status,"failed");
  h.state.handle=async()=>problem();assert.equal((await h.recover()).reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET","POST","GET"]);
});

test("호출자 body/옵션 변경에도 최초 직렬화 원문·모든 후속 입력 식별값 보존",async()=>{
  for(const input of [{type:"text",text:"  원문 입력  "},{type:"selection",questionId:id(3),candidateId:"opaque/선택"},{type:"confirmation",questionId:id(3),approved:false}]){
    const h=harness(),body={requestId:id(1),...(input.questionId?{conversationId:id(100)}:{}),input:{...input}},gate=deferred();
    h.state.beforeWrite=index=>index===1?gate.promise:undefined;
    const options={expectedServerId:serverId};const pending=h.controller.startAssistantRequest(body,options);await until(()=>h.state.storageCalls.includes("write"));
    body.requestId=id(2);body.input={type:"text",text:"다른 본문"};options.expectedServerId=otherServerId;gate.resolve();await pending;
    h.state.beforeWrite=null;h.state.handle=async(url,init)=>init.method==="GET"?problem():json(accepted(),200);await h.recover();
    assert.deepEqual(h.methods(),["POST","GET","POST"]);assert.equal(h.state.calls[0].init.body,h.state.calls[2].init.body);
    assert.deepEqual(JSON.parse(h.state.calls[2].init.body).input,input);assert.equal(JSON.parse(h.state.calls[2].init.body).requestId,id(1));
    const persisted=[...h.data.values()].join("");for(const word of ["원문 입력","opaque/선택","input","messages","body"])assert.equal(persisted.includes(word),false);
  }
});

for(const elapsed of [119999,120000,120001])test(`최초 POST부터 ${elapsed}ms: 120초 미만에만 재전송`,async()=>{
  const h=harness();await h.start();h.time=1000+elapsed;await h.recover();
  assert.deepEqual(h.methods(),elapsed<120000?["POST","GET","POST"]:["POST","GET"]);
  const saved=await h.storage.read(ref());assert.equal(saved.firstPostAttemptAt,1000);
  assert.equal(saved.lastPostAttemptAt,elapsed<120000?h.time:1000);
});

test("재전송으로 최초 시각 초기화 없음·응답 재유실 뒤 후속 복구도 GET만",async()=>{
  const h=harness();await h.start();h.time=2000;const first=await h.recover();assert.equal(first.retransmitted,true);
  const saved=await h.storage.read(ref());assert.equal(saved.firstPostAttemptAt,1000);assert.equal(saved.lastPostAttemptAt,2000);
  h.time=121000;const second=await h.recover();assert.equal(second.reason,"retry-used");assert.deepEqual(h.methods(),["POST","GET","POST","GET"]);
});

test("앱 재실행으로 body 없는 새 runtime에서는 저장된 ID GET만",async()=>{
  const old=harness();await old.start();const restarted=harness({data:old.data});
  const result=await restarted.recover();assert.equal(result.reason,"missing-session-body");assert.deepEqual(restarted.methods(),["GET"]);
  assert.equal((await restarted.storage.read(ref())).firstPostAttemptAt,1000);
});

test("원래 서버 변경은 GET/POST 전송 차단·기존 기록 보존",async()=>{
  const h=harness();await h.start();h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);
  assert.equal((await h.recover()).reason,"server-mismatch");assert.deepEqual(h.methods(),["POST"]);
  assert.equal((await h.storage.read(ref())).serverId,serverId);assert.deepEqual(await h.storage.readForServer(otherServerId),[]);
});

test("GET 중 서버 변경 또는 Mock 왕복 변경은 재전송 차단",async()=>{
  for(const change of [h=>{h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);},h=>{h.mode.getState().setMode("mock");h.mode.getState().setMode("server");}]){
    const h=harness();await h.start();const gate=deferred();h.state.handle=()=>gate.promise;const pending=h.recover();await until(()=>h.state.calls.length===2);
    change(h);gate.resolve(problem());assert.equal((await pending).kind,"unconfirmed");assert.deepEqual(h.methods(),["POST","GET"]);
  }
});

test("같은 runtime의 여러 factory·UUID 대소문자 경쟁에서도 복구 GET/POST 각 1회",async()=>{
  const h=harness();await h.start();const gate=deferred();h.state.handle=(url,init)=>init.method==="GET"?gate.promise:Promise.resolve(json(accepted(),200));
  const pending=h.recover();await until(()=>h.state.calls.length===2);
  const duplicate=await h.create().recoverAssistantRequest({...ref(),requestId:id(1).toUpperCase()});assert.equal(duplicate.reason,"busy");
  gate.resolve(problem());await pending;assert.deepEqual(h.methods(),["POST","GET","POST"]);
});

test("최초 POST 진행 중 중복 start/recover도 전송하지 않음",async()=>{
  const h=harness(),gate=deferred();h.state.handle=()=>gate.promise;const pending=h.start();await until(()=>h.state.calls.length===1);
  assert.equal((await h.create().recoverAssistantRequest(ref())).reason,"busy");assert.equal((await h.start()).reason,"busy");
  gate.resolve(json(accepted(),202));await pending;assert.deepEqual(h.methods(),["POST"]);
});

test("최초 POST 전 저장 실패 시 fetch 0회·실패를 성공으로 바꾸지 않음",async()=>{
  const h=harness();h.state.failWriteAt=1;const result=await h.start();assert.equal(result.reason,"storage");assert.equal(result.postResult.error.storageStage,"before-post");assert.deepEqual(h.state.calls,[]);
});

test("재전송 전 저장 실패 시 추가 POST 0회, 최초 기록 보존",async()=>{
  const h=harness();await h.start();h.state.failWriteAt=2;const result=await h.recover();assert.equal(result.reason,"storage");assert.equal(result.retransmitted,false);
  assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
});

test("저장소 조회 실패·손상 데이터는 GET/POST 실행 전에 차단",async()=>{
  for(const corrupt of [false,true]){const h=harness();await h.start();if(corrupt)for(const key of h.data.keys())h.data.set(key,"{");else h.state.failRead=true;
    const result=await h.recover();assert.equal(result.reason,"storage");assert.deepEqual(h.methods(),["POST"]);}
});

test("GET 404 이후 저장소 조회 오류에서도 원래 Problem을 잃지 않음",async()=>{
  const h=harness();await h.start();h.state.handle=async()=>{h.state.failRead=true;return problem();};
  const result=await h.recover();assert.equal(result.reason,"storage");assert.equal(result.getResult.error.problem.code,"ASSISTANT_REQUEST_NOT_FOUND");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("복구 metadata의 요청 ID·최초/직전 시각 불일치에서는 재전송 금지",async()=>{
  for(const change of [e=>{e.requestId=id(2);},e=>{e.firstPostAttemptAt=0;},e=>{e.lastPostAttemptAt=1100;}]){
    const h=harness();await h.start();for(const [key,value]of h.data){const saved=JSON.parse(value);change(saved.entries[0]);h.data.set(key,JSON.stringify(saved));}
    const result=await h.recover();assert.equal(result.reason,"metadata-mismatch");assert.deepEqual(h.methods(),["POST","GET"]);
  }
});

test("다른 경로에서 접수를 확인했으면 404여도 저장소 증거로 재전송 금지",async()=>{
  const h=harness();await h.start();await h.storage.recordResponse(ref(),accepted());assert.equal((await h.recover()).reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("재전송 저장 장벽 대기 중 120초 경과/서버 변경/Abort에서 fetch 금지",async()=>{
  for(const change of [h=>{h.time=121000;},h=>{h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);},(h,c)=>c.abort()]){
    const h=harness();await h.start();const gate=deferred(),controller=new AbortController();
    h.state.beforeWrite=index=>index===2?gate.promise:undefined;const pending=h.recover(controller.signal);
    await until(()=>h.state.storageCalls.filter(x=>x==="write").length===2);change(h,controller);gate.resolve();
    const result=await pending;assert.equal(result.kind,"unconfirmed");assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
  }
});

test("재전송 직전 새 접수 증거가 생기면 HTTP 저장 장벽 뒤 검사에서 차단",async()=>{
  const h=harness();await h.start();const client={...h.http,postAssistantRequest:async(body,options)=>{
    await h.storage.recordResponse(ref(),accepted());return h.http.postAssistantRequest(body,options);
  }};
  const result=await h.create(client).recoverAssistantRequest(ref());assert.equal(result.reason,"accept-confirmed");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("호출 전 Abort와 GET 중 Abort 후에는 새 신호로 호출해도 자동 재전송 없음",async()=>{
  for(const during of [false,true]){
    const h=harness();await h.start();const controller=new AbortController(),gate=deferred();let pending;
    if(during){h.state.handle=()=>gate.promise;pending=h.recover(controller.signal);await until(()=>h.state.calls.length===2);controller.abort();}
    else{controller.abort();pending=h.recover(controller.signal);}
    assert.equal((await pending).reason,"aborted");gate.resolve(problem());await settle();h.state.handle=async()=>problem();
    assert.equal((await h.recover()).reason,"aborted");assert.equal(h.methods().filter(x=>x==="POST").length,1);
    assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
  }
});

test("최초 POST 중 로컬 Abort는 서버 취소 없이 GET-only 복구로 남음",async()=>{
  const h=harness(),controller=new AbortController(),gate=deferred();h.state.handle=()=>gate.promise;
  const pending=h.start(request(),controller.signal);await until(()=>h.state.calls.length===1);controller.abort();
  assert.equal((await pending).reason,"aborted");gate.resolve(json(accepted(),202));await settle();
  h.state.handle=async()=>problem();assert.equal((await h.recover()).reason,"aborted");assert.deepEqual(h.methods(),["POST","GET"]);
  assert.equal((await h.storage.read(ref())).acceptConfirmed,false);
});

test("HTTP의 fetch 직전 검사 예외는 미전송 policy 오류이며 네트워크 실패로 위장하지 않음",async()=>{
  const h=harness();const result=await h.http.postAssistantRequest(request(),{expectedServerId:serverId,beforeSend:()=>{throw Error("검사 실패");}});
  assert.equal(result.error.kind,"policy");assert.equal(result.error.requestState,"not-sent");assert.deepEqual(h.state.calls,[]);
});

test("명시적 Mock 모드는 네트워크·복구 저장 없이 차단",async()=>{
  const h=harness();h.mode.getState().setMode("mock");assert.equal((await h.start()).reason,"policy");assert.equal((await h.recover()).reason,"policy");
  assert.deepEqual(h.state.calls,[]);assert.deepEqual(h.state.storageCalls,[]);
});

test("기존 기록·같은 runtime 재호출에는 임의 body를 채워 최초 POST하지 않음",async()=>{
  const h=harness();await h.storage.saveBeforePost(ref(),1000);assert.equal((await h.start()).reason,"existing-request");assert.deepEqual(h.state.calls,[]);
  const fresh=harness();await fresh.start();assert.equal((await fresh.start({...request(),input:{type:"text",text:"변경"}})).reason,"existing-request");assert.deepEqual(fresh.methods(),["POST"]);
});

test("GET 404에 timeout/retry 타이머·반복 polling·Schedule HTTP 의존 없음",async()=>{
  const h=harness();await h.start();await h.recover();assert.equal(h.timers.size,0);h.tick(500000);
  await settle();assert.deepEqual(h.methods(),["POST","GET","POST"]);assert.equal(h.data.size,1);
});
