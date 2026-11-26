/* global __dirname: readonly */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname,"..");
const id=n=>`${n.toString(16).padStart(8,"0")}-abcd-4abc-8abc-abcdef123456`;
const origin="https://example.invalid",otherOrigin="https://other.example.invalid",serverId=`development:${origin}`;
const ref=(n=1)=>({serverId,requestId:id(n)}), request=(n=1)=>({requestId:id(n),input:{type:"text",text:"  원문  "}});
const status=(value="accepted",n=1)=>({requestId:id(n),conversationId:id(100),status:value});
const summary={id:id(200),title:"일정",scheduledAt:"2026-11-12T00:00:00Z",category:"OTHER",completed:false,updatedAt:"2026-11-11T00:00:00Z"};
const results={
  need_more_info:{kind:"need_more_info",text:"보충",questionId:id(300)},
  candidate_selection:{kind:"candidate_selection",text:"후보",questionId:id(300),expiresAt:"2026-11-12T01:00:00Z",candidates:[1,2].map(n=>({candidateId:`opaque/${n}`,title:"후보",scheduledAt:summary.scheduledAt,category:"OTHER"}))},
  confirmation:{kind:"confirmation",text:"확인",questionId:id(300),expiresAt:"2026-11-12T01:00:00Z",operation:"update",target:summary,changes:{completed:false}},
  outcome:{kind:"outcome",text:"조회",outcome:"success",operation:"list",schedulesChanged:false,items:[summary]},
  failure:{kind:"failure",text:"실패",code:"MODEL_TIMEOUT",nextAction:"retry_later"},
  uncertain:{kind:"uncertain",text:"미확인",code:"EXECUTION_RESULT_UNKNOWN",nextAction:"check_status"},
};
const completed=(kind="outcome",n=1)=>({...status("completed",n),result:results[kind]});
const json=(body,code=200)=>({status:code,headers:new Headers({"Content-Type":"application/json","X-Request-ID":id(900)}),text:async()=>JSON.stringify(body)});
const problem=(code=404,error="ASSISTANT_REQUEST_NOT_FOUND",extra={})=>({status:code,headers:new Headers({"Content-Type":"application/problem+json","X-Request-ID":id(900)}),text:async()=>JSON.stringify({type:"https://example.invalid/problem",title:"오류",detail:"문구 파싱 금지",instance:"/api/v1/assistant/requests",status:code,code:error,requestId:id(900),assistantRequestId:id(1),...extra})});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const settle=async()=>{for(let n=0;n<300;n++)await Promise.resolve();};
async function until(predicate){for(let n=0;n<500&&!predicate();n++)await Promise.resolve();assert.ok(predicate(),"예상 비동기 지점 도달");}

// 실제 API·복구·저장 계층을 로드하고 native AppState·fetch·storage·timer만 대체한다.
function harness({data=new Map(),readOnly=false}={}){
  const cache=new Map(),timers=new Map(),appListeners=new Set();let wall=1000,mono=0,timerId=0,writes=0;
  const state={calls:[],events:[],app:"active",config:null,failRead:false,failWriteAt:0,beforeRead:null,beforeWrite:null,cleanup:0,
    handle:async(url,init)=>init.method==="POST"?json({...status(),requestId:JSON.parse(init.body).requestId},202):json(completed("outcome",parseInt(url.split("/").pop().slice(0,8),16)))};
  const adapter={
    async getItem(key){if(state.beforeRead)await state.beforeRead();if(state.failRead)throw Error("읽기 실패");return data.get(key)??null;},
    async setItem(key,value){const count=++writes;if(state.beforeWrite)await state.beforeWrite(count);if(count===state.failWriteAt)throw Error("저장 실패");data.set(key,value);},
  };
  const setTimer=(fn,ms)=>{const token=++timerId;timers.set(token,{fn,at:mono+ms});return token;},clearTimer=token=>timers.delete(token);
  const send=(url,init)=>{state.calls.push({url,init,at:mono,wall});return state.handle(url,init);};
  const native={AppState:{get currentState(){return state.app;},addEventListener(event,listener){assert.equal(event,"change");appListeners.add(listener);return{remove:()=>appListeners.delete(listener)};}}};
  function load(name){
    if(name==="@/services/api/assistant-schedule-sync")return{assistantScheduleSync:{observe:async()=>null}};
    if(name==="expo/fetch")return{fetch:send};if(name==="react-native")return native;
    if(name==="@react-native-async-storage/async-storage")return adapter;if(name==="zustand/vanilla")return require(name);
    assert.ok(name.startsWith("@/"));assert.notEqual(name,"@/services/api/http");
    const file=path.join(root,"src",`${name.slice(2)}.ts`);if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:file}).outputText;
    new Function("require","module","exports","fetch","setTimeout","clearTimeout","performance","process",code)(load,module,module.exports,
      ()=>{throw Error("실제 네트워크 금지");},setTimer,clearTimer,{now:()=>mono},{env:{EXPO_PUBLIC_DEV_SERVER_BASE_URL:origin,EXPO_PUBLIC_SCHEDULE_READ_ONLY:String(readOnly)}});
    return module.exports;
  }
  const config=load("@/services/api/config");state.config=config.parseDevelopmentServerConfig(origin);
  const storage=load("@/services/storage/assistant-recovery").assistantRecoveryStorage;
  const http=load("@/services/api/assistant").createAssistantHttpClient({fetchImpl:send,recovery:storage,readConfig:()=>state.config,now:()=>wall});
  const recoveryApi=load("@/services/api/assistant-request-recovery");
  const requests=recoveryApi.createAssistantRequestRecovery({http,recovery:storage,now:()=>wall});
  const mode=load("@/stores/scheduleDataModeStore").scheduleDataModeStore;
  const api=load("@/services/api/assistant-orchestrator");
  const create=(overrides={})=>api.createAssistantOrchestrator({http,requests,storage:{...storage,cleanup:async(...args)=>{state.cleanup++;return storage.cleanup(...args);}},clock:{now:()=>wall,monotonicNow:()=>mono},...overrides});
  const service=create();
  async function advance(ms){const target=mono+ms;let rounds=0;
    while(true){const next=Math.min(...[...timers.values()].map(t=>t.at));if(next>target)break;if(++rounds>500)throw Error("타이머 무한 반복");
      wall+=next-mono;mono=next;for(const[token,timer]of[...timers])if(timer.at<=mono){timers.delete(token);timer.fn();}await settle();}
    wall+=target-mono;mono=target;await settle();
  }
  return{load,setTimer,clearTimer,state,data,storage,http,requests,recoveryApi,mode,service,create,config,timers,appListeners,advance,
    get wall(){return wall;},set wall(value){wall=value;},get mono(){return mono;},
    app(value){state.app=value;for(const listener of [...appListeners])listener(value);},
    start:(input=request(),options={})=>service.startRequest(input,{expectedServerId:serverId,onUpdate:event=>state.events.push(event),...options}),
    seed:(time=1000,n=1,originId=serverId)=>storage.saveBeforePost({serverId:originId,requestId:id(n)},time),
    methods:()=>state.calls.map(c=>c.init.method),
  };
}

test("import/factory는 I/O 없음·202 접수 후 첫 GET 즉시·accepted→processing→completed",async()=>{
  const h=harness();assert.deepEqual(h.state.calls,[]);assert.equal(h.appListeners.size,0);
  let gets=0;h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(++gets===1?status():gets===2?status("processing"):completed());
  const task=h.start();assert.equal((await task.initial).kind,"observed");assert.deepEqual(h.methods(),["POST","GET"]);assert.equal(h.state.calls[1].at,0);
  await h.advance(1999);assert.equal(gets,1);await h.advance(1);assert.equal(gets,2);await h.advance(2000);
  assert.equal((await task.completion).kind,"completed");assert.deepEqual(h.state.calls.filter(c=>c.init.method==="GET").map(c=>c.at),[0,2000,4000]);
  for(const e of h.state.events.filter(e=>e.phase==="status"&&e.response.data.status!=="completed"))assert.equal(Object.hasOwn(e.response.data,"result"),false);
  await h.advance(10000);assert.equal(gets,3);assert.equal(h.timers.size,0);assert.equal(h.appListeners.size,0);assert.equal(h.state.cleanup,0);
});

test("POST 200 replay도 추가 POST 없이 원래 ID GET",async()=>{
  const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status("processing"),200):json(completed());
  const result=await h.start().completion;assert.equal(result.kind,"completed");assert.deepEqual(h.methods(),["POST","GET"]);
});

for(const[kind,value]of Object.entries(results))test(`completed ${kind}: 원형 보존·대화 종료/쓰기 성공으로 변환 없음`,async()=>{
  const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(completed(kind));
  const result=await h.start().completion;assert.equal(result.kind,"completed");assert.deepEqual(result.response.data.result,value);
  assert.equal(result.response.data.conversationId,id(100));assert.equal(h.state.cleanup,0);assert.equal((await h.storage.read(ref())).lastResultKind,kind);
});

test("느린 GET을 기다리고 응답 완료 후 2초부터 다음 조회·중첩 0회",async()=>{
  const h=harness(),gate=deferred();let gets=0;
  h.state.handle=(url,init)=>init.method==="POST"?Promise.resolve(json(status(),202)):++gets===1?gate.promise:Promise.resolve(json(completed()));
  const task=h.start();await until(()=>gets===1);await h.advance(3000);assert.equal(gets,1);
  gate.resolve(json(status("processing")));await task.initial;await h.advance(1999);assert.equal(gets,1);await h.advance(1);
  assert.equal((await task.completion).kind,"completed");assert.deepEqual(h.state.calls.filter(c=>c.init.method==="GET").map(c=>c.at),[0,5000]);
});

test("자동 GET 119999ms는 허용·120000ms부터 금지, 대기 타이머 정리",async()=>{
  const h=harness();h.wall=117999;await h.seed(0);h.state.handle=async()=>json(status());
  const task=h.service.resumeRequest(ref());await task.initial;await h.advance(2000);assert.equal(h.state.calls.length,2);assert.equal(h.state.calls[1].wall,119999);
  await h.advance(1);const result=await task.completion;assert.equal(result.reason,"deadline");assert.equal(h.state.calls.length,2);assert.equal(h.timers.size,0);
  assert.equal((await h.storage.read(ref())).firstPostAttemptAt,0);
});

for(const kind of ["pending","completed"])test(`deadline 직전 시작한 GET의 늦은 ${kind} 응답 처리·다음 GET 없음`,async()=>{
  const h=harness();h.wall=119999;await h.seed(0);const gate=deferred();h.state.handle=()=>gate.promise;
  const task=h.service.resumeRequest(ref());await until(()=>h.state.calls.length===1);await h.advance(2);
  gate.resolve(json(kind==="completed"?completed():status("processing")));const result=await task.completion;
  assert.equal(result.kind,kind==="completed"?"completed":"needs-attention");if(kind==="pending")assert.equal(result.reason,"deadline");
  assert.equal(h.state.calls.length,1);assert.equal(h.state.cleanup,0);
});

test("120초 한도는 서버 300초 처리 상한과 독립·서버 cancel/metadata 삭제 없음",async()=>{
  const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(status("processing"));
  const task=h.start();await task.initial;await h.advance(120000);assert.equal((await task.completion).reason,"deadline");
  assert.ok(h.state.calls.every(c=>c.init.method==="POST"||c.wall<121000));assert.equal(h.methods().filter(x=>x==="POST").length,1);
  assert.equal(h.state.cleanup,0);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
});

test("시스템 시계가 뒤로 바뀌어도 같은 runtime의 단조 시계·재개로 한도 연장 없음",async()=>{
  const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(status());
  const task=h.start();await task.initial;h.app("background");assert.equal((await task.completion).reason,"paused");
  await h.advance(60000);h.wall-=59000;h.app("active");const resumed=h.service.resumeRequest(ref());await resumed.initial;
  await h.advance(60000);assert.equal((await resumed.completion).reason,"deadline");assert.equal(h.mono,120000);assert.equal(h.state.cleanup,0);
});

test("초기 POST 중 background로 중단해도 최초 단조 시각은 다음 재개에서 유지",async()=>{
  const h=harness(),gate=deferred();h.state.handle=()=>gate.promise;const task=h.start();await until(()=>h.state.calls.length===1);
  h.app("inactive");assert.equal((await task.completion).reason,"paused");gate.resolve(json(status(),202));await settle();
  await h.advance(120000);h.wall=2000;h.app("active");h.state.handle=async()=>json(status());const resumed=h.service.resumeRequest(ref());await resumed.initial;
  assert.equal((await resumed.completion).reason,"deadline");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("POST 응답 유실→기존 GET-first→GET 확인 후 2초 polling",async()=>{
  const h=harness();let gets=0;h.state.handle=async(url,init)=>{if(init.method==="POST")throw Error("유실");return json(++gets===1?status("processing"):completed());};
  const task=h.start();assert.equal((await task.initial).kind,"observed");assert.deepEqual(h.methods(),["POST","GET"]);
  await h.advance(2000);assert.equal((await task.completion).kind,"completed");assert.deepEqual(h.methods(),["POST","GET","GET"]);
});

test("허용된 제한 재전송 후 접수→GET·polling, 원래 ID/body/최초 시각 유지",async()=>{
  const h=harness();let posts=0,gets=0;h.state.handle=async(url,init)=>{
    if(init.method==="POST"){if(++posts===1)throw Error("유실");return json(status(),200);}return ++gets===1?problem():json(gets===2?status():completed());};
  const task=h.start();await task.initial;assert.deepEqual(h.methods(),["POST","GET","POST","GET"]);
  assert.equal(h.state.calls[0].init.body,h.state.calls[2].init.body);await h.advance(2000);assert.equal((await task.completion).kind,"completed");
  assert.equal(posts,2);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
});

test("재전송 응답도 유실되면 반복 POST·polling 없이 확인 필요",async()=>{
  const h=harness();h.state.handle=async(url,init)=>{if(init.method==="POST")throw Error("유실");return problem();};
  const result=await h.start().completion;assert.equal(result.reason,"unconfirmed");assert.deepEqual(h.methods(),["POST","GET","POST"]);
  await h.advance(120000);assert.equal(h.state.calls.length,3);const once=await h.service.queryRequestOnce(ref()).completion;assert.equal(once.kind,"needs-attention");assert.deepEqual(h.methods(),["POST","GET","POST","GET"]);
});

test("POST 저장 실패/HTTP 거절은 무조건 GET-first/재전송으로 바꾸지 않음",async()=>{
  for(const which of ["storage","http"]){const h=harness();if(which==="storage")h.state.failWriteAt=1;else h.state.handle=async()=>problem(503,"ASSISTANT_UNAVAILABLE");
    const result=await h.start().completion;assert.equal(result.kind,"needs-attention");assert.deepEqual(h.methods(),which==="storage"?[]:["POST"]);assert.equal(h.timers.size,0);}
});

test("GET-first 중 단조 deadline이 지나면 wall clock이 돌아가도 재전송 없음",async()=>{
  const h=harness();let posts=0,waiting=false;const stored=deferred(),gate=deferred();
  h.state.beforeWrite=count=>{if(count===1){waiting=true;return stored.promise;}};
  h.state.handle=(url,init)=>{if(init.method==="POST"){posts++;return Promise.reject(Error("유실"));}return gate.promise;};
  const task=h.start();await until(()=>waiting);await h.advance(118000);stored.resolve();
  await until(()=>h.state.calls.length===2);h.wall-=60000;await h.advance(3000);
  gate.resolve(problem());const result=await task.completion;assert.equal(result.kind,"needs-attention");assert.equal(posts,1);
  assert.equal(result.reason,"deadline");
  assert.equal(result.recoveryResult.reason,"deadline");assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
});

test("정상 polling GET 404/410/409/5xx는 구조화 오류 보존·추가 POST/자동 retry/정리 없음",async()=>{
  for(const[code,error]of [[404,"ASSISTANT_REQUEST_NOT_FOUND"],[404,"ROUTE_NOT_FOUND"],[410,"REQUEST_EXPIRED"],[409,"CONVERSATION_BUSY"],[503,"ASSISTANT_UNAVAILABLE"],[500,"INTERNAL_ERROR"]]){
    const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):problem(code,error,{blockingRequestId:id(2),activeQuestionId:id(3),activeQuestionRequestId:id(4)});
    const result=await h.start().completion;assert.equal(result.kind,"needs-attention");const failure=result.recoveryResult.getResult.error;
    assert.equal(failure.status,code);assert.equal(failure.problem.code,error);assert.equal(failure.problem.activeQuestionRequestId,id(4));assert.equal(failure.problem.blockingRequestId,id(2));
    await h.advance(5000);assert.deepEqual(h.methods(),["POST","GET"]);assert.equal(h.state.cleanup,0);assert.notEqual(await h.storage.read(ref()),null);
  }
});

test("GET timeout/네트워크/JSON·DTO 오류는 확인 필요로 종료",async()=>{
  for(const kind of ["timeout","network","json","dto"]){const h=harness(),gate=deferred();h.state.handle=(url,init)=>init.method==="POST"?Promise.resolve(json(status(),202)):
    kind==="timeout"?gate.promise:kind==="network"?Promise.reject(Error("연결 실패")):Promise.resolve(kind==="json"?{...json({}),text:async()=>"{"}:json({...status("completed"),result:{kind:"bad"}}));
    const task=h.start();await until(()=>h.state.calls.length===2);if(kind==="timeout")await h.advance(5000);
    const result=await task.completion;assert.equal(result.kind,"needs-attention");assert.equal(result.recoveryResult.getResult.error.kind,kind==="json"||kind==="dto"?"response":kind);
    gate.resolve(json(completed()));await settle();assert.deepEqual(h.methods(),["POST","GET"]);assert.equal(h.timers.size,0);
  }
});

test("중복 factory polling과 기존 복구 직접 호출을 같은 예약으로 차단",async()=>{
  const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(status());
  const task=h.start();await task.initial;const other=h.create().resumeRequest(ref());assert.equal((await other.completion).reason,"busy");
  assert.equal((await h.requests.recoverAssistantRequest(ref())).reason,"busy");assert.equal((await h.requests.startAssistantRequest(request(),{expectedServerId:serverId})).reason,"busy");
  task.cancel();assert.equal((await task.completion).reason,"aborted");assert.deepEqual(h.methods(),["POST","GET"]);assert.equal(h.timers.size,0);
});

test("Abort 전·대기 중·GET 중에는 추가 전송 없이 timer/listener 정리",async()=>{
  for(const phase of ["before","waiting","get"]){const h=harness(),controller=new AbortController(),gate=deferred();
    h.state.handle=(url,init)=>init.method==="POST"?Promise.resolve(json(status(),202)):phase==="get"?gate.promise:Promise.resolve(json(status()));
    if(phase==="before")controller.abort();const task=h.start(request(),{signal:controller.signal});
    if(phase==="waiting")await task.initial;else if(phase==="get")await until(()=>h.state.calls.length===2);
    controller.abort();assert.equal((await task.completion).reason,"aborted");const calls=h.state.calls.length;
    gate.resolve(json(completed()));await h.advance(120000);assert.equal(h.state.calls.length,calls);assert.equal(h.timers.size,0);assert.equal(h.appListeners.size,0);assert.equal(h.state.cleanup,0);
  }
});

test("background/inactive 중단·active 명시적 GET-only 재개 시 원래 deadline 유지",async()=>{
  for(const app of ["background","inactive"]){const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(status());
    const task=h.start();await task.initial;await h.advance(1000);h.app(app);assert.equal((await task.completion).reason,"paused");assert.equal(h.timers.size,0);
    await h.advance(118000);h.app("active");const resumed=h.service.resumeRequest(ref());await resumed.initial;await h.advance(1000);
    assert.equal((await resumed.completion).reason,"deadline");assert.equal(h.methods().filter(x=>x==="POST").length,1);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
  }
});

test("서버 변경·Mock 왕복 전환은 진행 응답/이벤트와 추가 조회 무효화",async()=>{
  for(const which of ["server","mode"]){const h=harness(),gate=deferred();h.state.handle=(url,init)=>init.method==="POST"?Promise.resolve(json(status(),202)):gate.promise;
    const task=h.start();await until(()=>h.state.calls.length===2);if(which==="server")h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);else{h.mode.getState().setMode("mock");h.mode.getState().setMode("server");}
    const count=h.state.events.length;gate.resolve(json(completed()));const result=await task.completion;assert.equal(result.kind,"needs-attention");assert.equal(h.state.events.length,count);assert.equal(h.state.cleanup,0);
    assert.deepEqual(h.methods(),["POST","GET"]);
  }
});

test("앱 재실행: 같은 서버의 ID마다 GET만, 다른 서버 항목 보존",async()=>{
  const h=harness();await h.seed(1000,1);await h.seed(1000,2);await h.seed(1000,3,`development:${otherOrigin}`);
  const initialized=await h.service.initializeRecovery();assert.equal(initialized.kind,"initialized");assert.equal(initialized.requests.length,2);
  await Promise.all(initialized.requests.map(r=>r.task.completion));assert.deepEqual(h.methods(),["GET","GET"]);
  assert.deepEqual(initialized.requests.map(r=>r.reference.requestId),[id(1),id(2)]);assert.notEqual(await h.storage.read({serverId:`development:${otherOrigin}`,requestId:id(3)}),null);assert.equal(h.state.cleanup,0);
});

for(const kind of ["need_more_info","candidate_selection","confirmation","uncertain","failure","outcome"])test(`재실행 ${kind} 복구는 질문·연결 ID 보존, 자동 실행/정리 없음`,async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(completed(kind));const initialized=await h.service.initializeRecovery();
  const result=await initialized.requests[0].task.completion;assert.equal(result.kind,"completed");assert.deepEqual(result.response.data.result,results[kind]);assert.equal(result.response.data.conversationId,id(100));
  assert.deepEqual(h.methods(),["GET"]);assert.equal(h.state.cleanup,0);assert.notEqual(await h.storage.read(ref()),null);
});

test("재실행 후 120초 경과: 최초 복구 GET 결과 전달 후 새 자동 루프 없음",async()=>{
  const h=harness();h.wall=200000;await h.seed(1000);h.state.handle=async()=>json(status("processing"));
  const initialized=await h.service.initializeRecovery(),entry=initialized.requests[0];assert.equal(entry.initial.kind,"observed");assert.equal((await entry.task.completion).reason,"deadline");
  await h.advance(120000);assert.deepEqual(h.methods(),["GET"]);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);
});

test("초기화는 각 최초 GET 뒤 반환하며 polling 완료까지 새 입력을 막지 않음",async()=>{
  const h=harness();await h.seed();h.state.handle=async(url,init)=>init.method==="POST"?json({...status(),requestId:JSON.parse(init.body).requestId},202):json(status());
  const initialized=await h.service.initializeRecovery();assert.equal(initialized.kind,"initialized");assert.equal(initialized.requests[0].initial.kind,"observed");
  const fresh=h.start(request(2));await until(()=>h.state.calls.some(c=>c.init.method==="POST"));fresh.cancel();initialized.requests[0].task.cancel();
  await Promise.all([fresh.completion,initialized.requests[0].task.completion]);assert.equal(h.timers.size,0);
});

test("초기 복구 조회 중 새 POST 차단·storage 읽기 실패는 기존 데이터 보존",async()=>{
  const h=harness();await h.seed();const before=[...h.data.values()].join("");const gate=deferred();h.state.beforeRead=()=>gate.promise;
  const initializing=h.service.initializeRecovery();assert.equal((await h.start(request(2)).completion).reason,"initializing");
  h.state.failRead=true;gate.resolve();assert.equal((await initializing).reason,"storage");assert.equal([...h.data.values()].join(""),before);assert.deepEqual(h.state.calls,[]);
});

test("명시적 GET-only 재조회는 120초 뒤에도 1회만 실행·POST 없음",async()=>{
  const h=harness();await h.seed(0);h.wall=500000;h.state.handle=async()=>json(status());
  const result=await h.service.queryRequestOnce(ref()).completion;assert.equal(result.kind,"observed");await h.advance(120000);assert.deepEqual(h.methods(),["GET"]);
});

test("표시 callback/최종 반환은 정리가 아니며 명시적 표시 확인에서만 기존 cleanup 사용",async()=>{
  for(const kind of ["outcome","failure","uncertain","confirmation"]){const h=harness();h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(completed(kind));
    await h.start().completion;assert.equal(h.state.cleanup,0);assert.notEqual(await h.storage.read(ref()),null);
    const cleaned=await h.service.confirmResultDisplayed(ref());assert.equal(cleaned,kind==="outcome"||kind==="failure"?"removed":"retained");assert.equal(h.state.cleanup,1);
  }
});

test("호출자 입력·callback 예외/변경은 이미 접수한 POST를 다시 실행하지 않음",async()=>{
  const h=harness(),body=request();const task=h.start(body,{onUpdate:event=>{if(event.phase==="status")throw Error("화면 표시 실패");}});
  body.input.text="다른 입력";const result=await task.completion;assert.equal(result.reason,"observer-error");assert.equal(h.methods().filter(x=>x==="POST").length,1);
  assert.equal(JSON.parse(h.state.calls[0].init.body).input.text,"  원문  ");assert.equal(h.state.cleanup,0);assert.equal(h.timers.size,0);
});

test("명시적 Mock·이미 중단된 신호는 실제 API·저장 작업을 시작하지 않음",async()=>{
  const h=harness();h.mode.getState().setMode("mock");assert.equal((await h.start().completion).reason,"policy");assert.equal((await h.service.initializeRecovery()).reason,"policy");assert.deepEqual(h.state.calls,[]);assert.equal(h.data.size,0);
});

test("POST 성공 후 metadata 갱신 실패도 기존 ID GET으로 이어지고 추가 POST 없음",async()=>{
  const h=harness();h.state.failWriteAt=2;const task=h.start();const result=await task.completion;
  assert.equal(result.kind,"completed");assert.equal(h.state.events.find(e=>e.phase==="status").response.metadata.status,"failed");
  assert.deepEqual(h.methods(),["POST","GET"]);assert.equal((await h.storage.read(ref())).lastStatus,"completed");
});

test("복구 목록이 비어도 읽기 중 서버 변경·Abort를 초기화 성공으로 반환하지 않음",async()=>{
  for(const kind of["server","abort"]){const h=harness(),gate=deferred(),controller=new AbortController();h.state.beforeRead=()=>gate.promise;
    const pending=h.service.initializeRecovery({signal:controller.signal});if(kind==="server")h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);else controller.abort();
    gate.resolve();const result=await pending;assert.equal(result.kind,"needs-attention");assert.equal(result.reason,kind==="server"?"server-mismatch":"aborted");assert.deepEqual(h.state.calls,[]);
  }
});

test("callback의 응답 변경 시도는 내부 status/result와 후속 polling을 바꾸지 않음",async()=>{
  const h=harness();let gets=0;h.state.handle=async(url,init)=>init.method==="POST"?json(status(),202):json(++gets===1?status("processing"):completed());
  const task=h.start(request(),{onUpdate:event=>{if(event.phase==="status")Reflect.set(event.response.data,"status","completed");}});
  const initial=await task.initial;assert.equal(initial.kind,"observed");assert.equal(initial.response.data.status,"processing");
  await h.advance(2000);assert.equal((await task.completion).kind,"completed");assert.equal(gets,2);
});

test("초기 clock 오류는 예약을 누수하지 않고 전송 전 차단",async()=>{
  const h=harness();
  for(const now of[()=>NaN,()=>{throw Error("시계 오류");}]){
    const invalid=h.create({clock:{now,monotonicNow:()=>0}});
    assert.equal((await invalid.startRequest(request(),{expectedServerId:serverId}).completion).reason,"clock");assert.deepEqual(h.state.calls,[]);
  }
  assert.equal((await h.service.startRequest({...request(),requestId:"bad"},{expectedServerId:serverId}).completion).reason,"invalid-request");
  assert.equal((await h.start().completion).kind,"completed");assert.deepEqual(h.methods(),["POST","GET"]);
});

test("미래의 저장 시각은 한 번 GET하되 임의의 새 120초를 만들지 않음",async()=>{
  const h=harness();await h.seed(2000);h.state.handle=async()=>json(status());
  const task=h.service.resumeRequest(ref());assert.equal((await task.initial).kind,"observed");assert.equal((await task.completion).reason,"clock");assert.deepEqual(h.methods(),["GET"]);
});

test("Mock 왕복 이후에는 원래 body 재전송 없이 현재 세대에서 GET-only 재개 가능",async()=>{
  const h=harness(),gate=deferred();h.state.handle=(url,init)=>init.method==="POST"?Promise.resolve(json(status(),202)):gate.promise;
  const task=h.start();await until(()=>h.state.calls.length===2);h.mode.getState().setMode("mock");assert.equal((await task.completion).reason,"policy");
  gate.resolve(json(status()));await settle();h.mode.getState().setMode("server");h.state.handle=async()=>json(completed());
  assert.equal((await h.service.resumeRequest(ref()).completion).kind,"completed");assert.deepEqual(h.methods(),["POST","GET","GET"]);
});

test("초기 복구 목록 읽기 중 시계가 돌아가도 이미 경과한 한도를 초기화하지 않음",async()=>{
  const h=harness();await h.seed(0);h.wall=119000;const gate=deferred();h.state.beforeRead=()=>gate.promise;h.state.handle=async()=>json(status());
  const pending=h.service.initializeRecovery();await h.advance(2000);h.wall-=100000;gate.resolve();const initialized=await pending;
  assert.equal((await initialized.requests[0].task.completion).reason,"deadline");assert.deepEqual(h.methods(),["GET"]);
});


// Stage 3: real recorder controller + Expo file store + owner + Voice API + common recovery/orchestrator.
async function voiceJob(h, { n = 1, question, canSend = () => true } = {}) {
  const { fileAdapter } = require("./helpers/voice-native.cjs");
  const { voiceSource, wavBytes } = require("./helpers/local-voice.cjs");
  const f = fileAdapter(), deps = f.api.createExpoVoiceDependencies(() => true);
  deps.setTimer = h.setTimer; deps.clearTimer = h.clearTimer;
  const recorder = voiceSource("src/services/local-voice-recording.ts").createLocalVoiceRecording(deps);
  recorder.focus(true); await recorder.start(); await recorder.stop();
  const owner = recorder.handoff(recorder.getSnapshot().file);
  assert.ok(owner); assert.equal(recorder.handoff(recorder.getSnapshot().file), null);
  const api = h.load("@/services/api/voice").createVoiceHttpClient({ assistant: h.http });
  const payload = h.load("@/services/assistant-voice-payload").createAssistantVoicePayload(owner,
    { requestId: id(n), ...(question ?? {}) }, canSend, api);
  return { f, recorder, owner, payload, bytes: wavBytes(),
    start: () => h.service.startVoiceRequest(payload, { expectedServerId: serverId, onUpdate: event => h.state.events.push(event) }) };
}
const voiceAccepted = (n = 1, input = { type: "text", text: "일정 보여줘" }) => ({ ...status("accepted", n), transcript: "일정 보여줘", input });

for (const kind of Object.keys(results)) test(`3 voice owner→raw API→common mapper ${kind}`, async () => {
  const h = harness(), v = await voiceJob(h);
  h.state.handle = async (url, init) => {
    assert.ok(await h.storage.read(ref()));
    return init.method === "POST" ? json(voiceAccepted(), 202) : json(completed(kind));
  };
  assert.equal((await v.start().completion).kind, "completed"); await settle();
  assert.deepEqual(h.methods(), ["POST", "GET"]);
  const post = h.state.calls[0]; assert.equal(post.url, `${origin}/api/v1/voice/requests?requestId=${id(1)}`);
  assert.deepEqual(post.init.body, v.bytes); assert.equal(post.init.headers["Content-Type"], "audio/wav"); assert.equal(post.init.redirect, "error");
  assert.ok(h.state.calls.every(call => !call.url.endsWith("/assistant/requests") && !call.url.endsWith("/speech")));
  assert.equal(h.state.events.filter(e => e.acceptance).length, 1);
  assert.deepEqual(h.state.events.at(-1).response.data.result, results[kind]);
  assert.equal(v.owner.getState().deleted, true); assert.equal(v.f.entries.size, 0);
  const persisted = JSON.stringify([...h.data.values()]); assert.ok(!persisted.includes("transcript")); assert.ok(!persisted.includes("PCM"));
});

for (const type of ["text", "selection", "confirmation"]) test(`3 voice follow-up ${type}: correlated query and structured acceptance`, async () => {
  const h = harness(), v = await voiceJob(h, { question: { conversationId: id(100), questionId: id(300) } });
  const input = type === "text" ? { type, questionId: id(300), text: "내일" } : type === "selection" ? { type, questionId: id(300), candidateId: "opaque/1" } : { type, questionId: id(300), approved: false };
  h.state.handle = async (url, init) => init.method === "POST" ? json(voiceAccepted(1, input), 202) : json(completed());
  assert.equal((await v.start().completion).kind, "completed");
  assert.equal(h.state.calls[0].url, `${origin}/api/v1/voice/requests?requestId=${id(1)}&conversationId=${id(100)}&questionId=${id(300)}`);
  assert.deepEqual(h.state.events.find(e => e.acceptance).acceptance.input, input);
});

for (const failure of ["network", "timeout", "malformed"]) test(`3 voice ${failure} → exact404 → one identical WAV resend → GET-only`, async () => {
  const h = harness(), v = await voiceJob(h); let posts = 0, gets = 0;
  h.state.handle = async (url, init) => {
    if (init.method === "POST") { posts++; if (posts === 1) { if (failure === "network") throw Error("synthetic"); if (failure === "timeout") return new Promise(() => {}); return json({}, 202); } return json(voiceAccepted(), 202); }
    gets++; return gets === 1 ? problem() : json(completed());
  };
  const task = v.start(); await settle(); if (failure === "timeout") await h.advance(35000);
  assert.equal((await task.completion).kind, "completed");
  assert.deepEqual(h.methods(), ["POST", "GET", "POST", "GET"]);
  assert.equal(h.state.calls[0].url, h.state.calls[2].url); assert.deepEqual(h.state.calls[0].init.body, h.state.calls[2].init.body);
  assert.equal((await h.storage.read(ref())).firstPostAttemptAt, 1000);
  assert.equal(v.owner.getState().deleted, true);
});

test("3 VOICE_BUSY waits after response 2s then GET-first, no immediate POST", async () => {
  const h = harness(), v = await voiceJob(h); let posts = 0;
  h.state.handle = async (url, init) => init.method === "POST" && ++posts === 1 ? problem(409, "VOICE_BUSY") : init.method === "POST" ? json(voiceAccepted(), 202) : posts === 1 ? problem() : json(completed());
  const task = v.start(); await settle(); assert.deepEqual(h.methods(), ["POST"]);
  await h.advance(1999); assert.equal(h.state.calls.length, 1); await h.advance(1);
  assert.equal((await task.completion).kind, "completed"); assert.deepEqual(h.methods(), ["POST", "GET", "POST", "GET"]); assert.equal(h.state.calls[1].at, 2000);
});

for (const failure of ["network", "timeout", "partial", "replay"]) test(`3 ${failure}: observed acceptance prevents additional POST`, async () => {
  const h = harness(), v = await voiceJob(h);
  h.state.handle = async (url, init) => {
    if (init.method === "GET") return json(completed());
    if (failure === "network") throw Error("synthetic");
    if (failure === "timeout") return new Promise(() => {});
    return failure === "replay" ? json(status("processing")) : json({ ...status(), transcript: 1 }, 202);
  };
  const task = v.start(); await settle(); if (failure === "timeout") await h.advance(35000);
  assert.equal((await task.completion).kind, "completed"); assert.deepEqual(h.methods(), ["POST", "GET"]);
  assert.equal(h.state.events.filter(e => e.acceptance).length, 0); assert.equal(v.owner.getState().deleted, true);
});

for (const error of ["plain404", "ROUTE_NOT_FOUND", "VOICE_UNAVAILABLE", "REQUEST_ID_CONFLICT", "general500"]) test(`3 ${error}: GET-only, original metadata retained`, async () => {
  const h = harness(), v = await voiceJob(h);
  h.state.handle = async (url, init) => init.method === "POST" ? (error === "VOICE_UNAVAILABLE" ? problem(503, error) : error === "REQUEST_ID_CONFLICT" ? problem(409, error) : error === "general500" ? problem(500,"INTERNAL_ERROR") : Promise.reject(Error("synthetic"))) :
    error === "plain404" ? { ...json({},404), headers:new Headers({"Content-Type":"application/json"}) } : problem(404,"ROUTE_NOT_FOUND");
  const task = v.start(); await settle(); await h.advance(120000);
  assert.equal((await task.completion).reason, "deadline"); assert.equal(h.methods().filter(x => x === "POST").length, 1);
  assert.ok(await h.storage.read(ref())); assert.equal(h.state.cleanup, 0); assert.equal(v.owner.getState().deleted,true);
});

test("3 resend response lost: never third POST; first deadline unchanged", async () => {
  const h=harness(),v=await voiceJob(h); h.state.handle=async(url,init)=>init.method==="POST"?Promise.reject(Error("synthetic")):problem();
  const task=v.start();await settle();assert.equal(h.methods().filter(x=>x==="POST").length,2);
  await h.advance(120000);assert.equal((await task.completion).reason,"deadline");assert.equal(h.methods().filter(x=>x==="POST").length,2);
  assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);assert.equal(v.owner.getState().deleted,true);
});

for(const failure of ["before-save","saved-abort","authority","read","changed","missing"]) test(`3 preflight ${failure}: POST zero, owner responsibility settles`, async()=>{
  const h=harness(),v=await voiceJob(h);const gate=deferred();let valid=true;
  if(failure==="before-save")h.state.failWriteAt=1;
  if(failure==="saved-abort")h.state.beforeWrite=()=>gate.promise;
  if(failure==="authority") { v.payload=h.load("@/services/assistant-voice-payload").createAssistantVoicePayload(v.owner,{requestId:id(1)},()=>valid,h.load("@/services/api/voice").createVoiceHttpClient({assistant:h.http})); valid=false; }
  if(failure==="read")v.f.native.readFails=true;
  if(failure==="changed")v.f.entries.get(v.f.managedUri).bytes[0]=0;
  if(failure==="missing")v.f.entries.delete(v.f.managedUri);
  const task=h.service.startVoiceRequest(v.payload,{expectedServerId:serverId});await settle();
  if(failure==="saved-abort"){task.cancel();gate.resolve();}
  await task.completion;await settle();assert.equal(h.state.calls.length,0);assert.equal(v.owner.getState().activeUses,0);
  assert.equal(v.owner.getState().deleted,true);
});

for(const exit of ["background","A-B-A","abort"]) test(`3 ${exit} during HTTP body: no late UI; live use released and retry discarded`,async()=>{
  const h=harness(),v=await voiceJob(h),gate=deferred();h.state.handle=async()=>({...json(voiceAccepted(),202),text:()=>gate.promise});
  const task=v.start();await until(()=>h.state.calls.length===1);await settle();
  assert.equal(v.owner.getState().activeUses,1);v.recorder.discard();assert.equal(v.f.entries.has(v.f.managedUri),true);
  if(exit==="background")h.app("background");else if(exit==="abort")task.cancel();else{h.mode.getState().setMode("mock");h.mode.getState().setMode("server");}
  assert.equal((await task.completion).kind,"needs-attention");const updates=h.state.events.length;gate.resolve(JSON.stringify(voiceAccepted()));await settle();
  assert.equal(h.state.events.length,updates);assert.equal(v.owner.getState().deleted,true);assert.equal(h.methods().filter(x=>x==="POST").length,1);
});

test("3 cleanup fails after success: runtime handle retries across next lifecycle",async()=>{
  const h=harness(),v=await voiceJob(h);v.f.native.deleteFails=true;h.state.handle=async(url,init)=>init.method==="POST"?json(voiceAccepted(),202):json(completed());
  assert.equal((await v.start().completion).kind,"completed");await settle();assert.equal(v.owner.getState().cleanupFailed,true);assert.equal(v.owner.getState().deleted,false);
  v.f.native.deleteFails=false;await h.load("@/services/assistant-voice-payload").retryVoiceFileCleanup();assert.equal(v.owner.getState().deleted,true);assert.equal(v.f.entries.size,0);
});

for(const [statusCode,code] of [[422,"SPEECH_NOT_RECOGNIZED"],[422,"VOICE_ANSWER_UNCLEAR"],[422,"AUDIO_UNSUPPORTED"],[413,"REQUEST_BODY_TOO_LARGE"],[400,"MALFORMED_REQUEST"],[409,"STALE_QUESTION"],[409,"QUESTION_EXPIRED"],[409,"CONVERSATION_BUSY"],[409,"UNRESOLVED_UNCERTAIN"]]) test(`3 correlated first rejection ${code}: narrow serialized cleanup`,async()=>{
  const h=harness(),v=await voiceJob(h);h.state.handle=async()=>problem(statusCode,code);
  const result=await v.start().completion;assert.equal(result.kind,"needs-attention");assert.equal(result.recoveryResult.definitiveRejection,true);assert.equal(await h.storage.read(ref()),null);
  assert.deepEqual(h.methods(),["POST"]);assert.equal(v.owner.getState().deleted,true);
});

for(const variant of ["missing-logical-id","wrong-status","acceptance-race","cleanup-write-fails"]) test(`3 rejection ${variant}: never grants cleanup authority`,async()=>{
  const h=harness(),v=await voiceJob(h);h.state.handle=async(url,init)=>{
    if(init.method==="GET")return json(completed());
    if(variant==="acceptance-race")h.http.exchange.noteAcceptance(ref());
    if(variant==="cleanup-write-fails")h.state.failWriteAt=2;
    return problem(variant==="wrong-status"?400:422,"SPEECH_NOT_RECOGNIZED",variant==="missing-logical-id"?{assistantRequestId:undefined}:{});
  };
  const result=await v.start().completion;assert.notEqual(result.recoveryResult?.definitiveRejection,true);assert.ok(await h.storage.read(ref()));assert.equal(h.methods().filter(x=>x==="POST").length,1);
});

test("3 GET acceptance persisted update fails: memory evidence still forbids resend",async()=>{
  const h=harness(),v=await voiceJob(h);h.state.failWriteAt=2;h.state.handle=async(url,init)=>init.method==="POST"?json(voiceAccepted(),202):json(completed());
  assert.equal((await v.start().completion).kind,"completed");assert.equal(h.http.hasAcceptanceEvidence(ref()),true);assert.equal(h.methods().filter(x=>x==="POST").length,1);
});


for(const elapsed of [119999,120000,120001])test(`3 exact retry deadline ${elapsed} ms`,async()=>{
  const h=harness(),v=await voiceJob(h),gate=deferred();let posts=0;
  h.state.handle=async(url,init)=>{if(init.method==="POST"){posts++;if(posts===1)throw Error("synthetic");return json(voiceAccepted(),202);}return posts===1?gate.promise:json(completed());};
  const task=v.start();await until(()=>h.state.calls.length===2);h.wall=1000+elapsed;gate.resolve(problem());await settle();
  if(elapsed<120000){assert.equal((await task.completion).kind,"completed");assert.equal(posts,2);}else{assert.equal((await task.completion).reason,"deadline");assert.equal(posts,1);}assert.equal(v.owner.getState().deleted,true);
});

for(const invalidate of ["authority","acceptance","deadline"])test(`3 retry storage barrier ${invalidate}: second POST blocked`,async()=>{
  const h=harness();let current=true;const v=await voiceJob(h,{canSend:()=>current}),gate=deferred();
  h.state.handle=async(url,init)=>init.method==="POST"?Promise.reject(Error("synthetic")):problem();
  h.state.beforeWrite=count=>count===2?gate.promise:Promise.resolve();const task=v.start();await until(()=>h.state.calls.length===2);await settle();
  if(invalidate==="authority")current=false;else if(invalidate==="acceptance")h.http.exchange.noteAcceptance(ref());else h.wall=121000;
  gate.resolve();await settle();if(invalidate!=="deadline")await h.advance(120000);
  assert.equal((await task.completion).kind,"needs-attention");assert.equal(h.methods().filter(x=>x==="POST").length,1);assert.ok(await h.storage.read(ref()));
});

test("3 retry rejection never erases an earlier unconfirmed attempt",async()=>{
  const h=harness(),v=await voiceJob(h);let posts=0;
  h.state.handle=async(url,init)=>init.method==="GET"?problem():++posts===1?Promise.reject(Error("synthetic")):problem(422,"SPEECH_NOT_RECOGNIZED");
  const task=v.start();await settle();await h.advance(120000);const result=await task.completion;
  assert.notEqual(result.recoveryResult.definitiveRejection,true);assert.equal(posts,2);assert.ok(await h.storage.read(ref()));
});

for(const boundary of ["same-client","second-client","different-id"])test(`3 shared admission ${boundary}`,async()=>{
  const h=harness(),a=await voiceJob(h),b=await voiceJob(h,{n:boundary==="different-id"?2:1}),gate=deferred();
  h.state.handle=async(url,init)=>init.method==="POST"?gate.promise:json(completed("outcome",parseInt(url.split("/").pop().slice(0,8),16)));
  const first=a.start();await until(()=>h.state.calls.length===1);
  const service=boundary==="same-client"?h.service:h.create();const second=service.startVoiceRequest(b.payload,{expectedServerId:serverId});await settle();
  assert.equal(h.methods().filter(x=>x==="POST").length,boundary==="different-id"?2:1);
  if(boundary!=="different-id")assert.equal((await second.completion).reason,"busy");
  gate.resolve(json(voiceAccepted(),202));await first.completion;if(boundary==="different-id"){await h.advance(120000);await second.completion;}
  await settle();assert.equal(a.owner.getState().deleted,true);assert.equal(b.owner.getState().deleted,true);
});

for(const mode of ["mock","read-only"])test(`3 transport ${mode}: no business HTTP`,async()=>{
  const h=harness({readOnly:mode==="read-only"}),v=await voiceJob(h);if(mode==="mock")h.mode.getState().setMode("mock");
  await v.start().completion;assert.equal(h.state.calls.length,0);assert.equal(v.owner.getState().deleted,true);
});


test("3 voice accepted/processing/completed uses response-relative 2s shared polling",async()=>{
  const h=harness(),v=await voiceJob(h);let gets=0;h.state.handle=async(url,init)=>init.method==="POST"?json(voiceAccepted(),202):json(++gets===1?status():gets===2?status("processing"):completed());
  const task=v.start();assert.equal((await task.initial).kind,"observed");await h.advance(1999);assert.equal(gets,1);await h.advance(1);assert.equal(gets,2);await h.advance(2000);assert.equal((await task.completion).kind,"completed");assert.deepEqual(h.state.calls.filter(c=>c.init.method==="GET").map(c=>c.at),[0,2000,4000]);assert.equal(h.state.events.filter(e=>e.acceptance).length,1);
});


for(const firstGet of ["network","timeout"])test(`3 uncertain first GET ${firstGet} then exact404 still permits one eligible resend`,async()=>{
  const h=harness(),v=await voiceJob(h);let posts=0,gets=0;
  h.state.handle=async(url,init)=>{if(init.method==="POST"){if(++posts===1)throw Error("synthetic");return json(voiceAccepted(),202);}if(++gets===1){if(firstGet==="network")throw Error("synthetic");return new Promise(()=>{});}return gets===2?problem():json(completed());};
  const task=v.start();try{await settle();if(firstGet==="timeout")await h.advance(5000);await h.advance(2000);assert.equal(posts,2);await h.advance(2000);assert.equal((await task.completion).kind,"completed");assert.equal(posts,2);assert.deepEqual(h.state.calls.filter(c=>c.init.method==="POST").map(c=>c.init.body),[v.bytes,v.bytes]);}finally{task.cancel();}
});


test("3 changed original before retry blocks second POST and reports local file failure",async()=>{
  const h=harness(),v=await voiceJob(h);h.state.handle=async(url,init)=>{if(init.method==="POST"){v.f.entries.get(v.f.managedUri).bytes[0]=0;throw Error("synthetic");}return problem();};
  const result=await v.start().completion;assert.equal(result.reason,"file");assert.deepEqual(h.methods(),["POST","GET"]);assert.ok(await h.storage.read(ref()));assert.equal(v.owner.getState().deleted,true);
});


for(const state of ["not-sent","unconfirmed","rejected","accepted","missing"])test(`review4 logical ${state} dominates latest not-sent attempt`,async()=>{
  const h=harness(),context=h.load("@/utils/assistant-text-question").createAssistantTextQuestionContext(serverId,0),token=Symbol();
  context.beginRequest(id(1));context.observeResponse(completed("confirmation"),"request");const question=context.getConfirmationQuestion(1000);
  context.beginRequest(id(2),question,undefined,undefined,token);
  const execution={kind:"needs-attention",reason:"storage",inputSource:"voice",reference:ref(2),...(state==="missing"?{}:{voiceTransmission:{postCount:state==="not-sent"?0:1,state}}),recoveryResult:{kind:"unconfirmed",reference:ref(2),reason:"storage",retransmitted:false,postResult:h.http.exchange.failure({operation:"post",serverId,assistantRequestId:id(2)},"storage")}};
  context.observeExecution(execution,"request",question);assert.equal(!!context.getConfirmationQuestion(1000),state==="not-sent"||state==="rejected");
});
test("review4 dispatch counter is zero through save, one at transport, and acceptance survives GET error",async()=>{
  const h=harness(),v=await voiceJob(h),save=deferred(),body=deferred();h.state.beforeWrite=count=>count===1?save.promise:Promise.resolve();
  h.state.handle=async()=>({...json(voiceAccepted(),202),text:()=>body.promise});const task=v.start();await settle();assert.equal(task.getVoiceTransmission().state,"not-sent");assert.equal(task.getVoiceTransmission().postCount,0);
  save.resolve();await until(()=>h.state.calls.length===1);assert.deepEqual(task.getVoiceTransmission(),{state:"unconfirmed",postCount:1});await h.advance(35000);
  task.cancel();await task.completion;body.resolve(JSON.stringify(voiceAccepted()));await settle();assert.equal(task.getVoiceTransmission().state,"accepted");assert.equal(task.getVoiceTransmission().postCount,1);assert.equal(v.owner.getState().deleted,true);
});
test("review4 old interruption token cannot clear another pending voice question hold",async()=>{
  const h=harness(),context=h.load("@/utils/assistant-text-question").createAssistantTextQuestionContext(serverId,0),old=Symbol(),current=Symbol();
  context.beginRequest(id(1));context.observeResponse(completed("confirmation"),"request");const question=context.getConfirmationQuestion(1000);
  context.beginRequest(id(2),question,undefined,undefined,old);context.beginRequest(id(3),question,undefined,undefined,current);context.setVoiceTransmission(current,()=>({state:"unconfirmed",postCount:1}));context.holdVoiceAnswer(current);
  context.observeVoiceInterruption({kind:"needs-attention",reason:"aborted",reference:ref(2),voiceTransmission:{state:"not-sent",postCount:0}},old,question);assert.equal(context.getConfirmationQuestion(1000),undefined);
});

test("review4 logical history getter keeps the original scope after options mutation",async()=>{
  const h=harness(),v=await voiceJob(h),gate=deferred(),options={expectedServerId:serverId};h.state.beforeWrite=()=>gate.promise;
  const task=h.service.startVoiceRequest(v.payload,options);try{await settle();options.expectedServerId=`development:${otherOrigin}`;assert.deepEqual(task.getVoiceTransmission(),{state:"not-sent",postCount:0});assert.equal(h.state.calls.length,0);}finally{task.cancel();gate.resolve();await task.completion;}
});


for(const accepted of [false,true])test(`review5 stored same ID accepted=${accepted}: current zero sends cannot replace history`,async()=>{
  const h=harness(),v=await voiceJob(h);await h.seed();if(accepted)await h.storage.recordResponse(ref(),status("processing"));const previous=await h.storage.read(ref());
  const result=await v.start().completion;assert.equal(h.state.calls.length,0);assert.deepEqual(await h.storage.read(ref()),previous);
  if(accepted)assert.deepEqual(result.voiceTransmission,{postCount:0,state:"accepted"});else assert.equal(result.voiceTransmission,undefined);
});
for(const phase of ["pending","failed","uppercase"])test(`review5 other owner during ${phase} read cannot borrow no-send evidence`,async()=>{
  const h=harness(),a=await voiceJob(h),b=await voiceJob(h),gate=deferred();h.state.beforeRead=()=>gate.promise;
  const task=a.start();await settle();assert.deepEqual(task.getVoiceTransmission(),{postCount:0,state:"not-sent"});
  if(phase==="failed"){h.state.failRead=true;gate.resolve();await task.completion;h.state.failRead=false;}
  const payload=phase==="uppercase"?h.load("@/services/assistant-voice-payload").createAssistantVoicePayload(b.owner,{requestId:id(1).toUpperCase()},()=>true,h.load("@/services/api/voice").createVoiceHttpClient({assistant:h.http})):b.payload;
  const result=await h.requests.startVoiceRequest(payload,{expectedServerId:serverId});assert.equal(result.kind,"unconfirmed");assert.equal(result.voiceTransmission,undefined);assert.equal(h.state.calls.length,0);
  task.cancel();gate.resolve();await task.completion;await payload.dispose();
});
test("review5 shared receipt during first lookup overrides zero current dispatches",async()=>{
  const h=harness(),v=await voiceJob(h),gate=deferred();h.state.beforeRead=()=>gate.promise;const task=v.start();await settle();
  assert.equal(task.getVoiceTransmission().state,"not-sent");h.http.exchange.noteAcceptance(ref());assert.deepEqual(task.getVoiceTransmission(),{postCount:0,state:"accepted"});
  task.cancel();gate.resolve();assert.equal((await task.completion).voiceTransmission.state,"accepted");assert.equal(h.state.calls.length,0);
});
test("review5 pre-session A-B-A keeps old payload proof away from new owner",async()=>{
  const h=harness(),a=await voiceJob(h),b=await voiceJob(h),gate=deferred();h.state.beforeRead=()=>gate.promise;const task=a.start();await settle();
  h.mode.getState().setMode("mock");h.mode.getState().setMode("server");await task.completion;
  const next=b.start();assert.equal((await next.completion).voiceTransmission,undefined);assert.equal(next.getVoiceTransmission(),undefined);assert.equal(h.state.calls.length,0);gate.resolve();await settle();assert.equal(h.state.calls.length,0);
});
