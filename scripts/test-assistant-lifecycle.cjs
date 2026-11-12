/* global __dirname: readonly */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {test}=require("node:test");
const ts=require("typescript");
const root=path.resolve(__dirname,"..");
const origin="https://example.invalid",otherOrigin="https://other.example.invalid",serverId=`development:${origin}`;
const id=n=>`${n.toString(16).padStart(8,"0")}-abcd-4abc-8abc-abcdef123456`;
const ref=(n=1,server=serverId)=>({serverId:server,requestId:id(n)});
const pending=(n=1)=>({requestId:id(n),conversationId:id(100),status:"processing"});
const done=(kind="outcome",n=1)=>({...pending(n),status:"completed",result:kind==="uncertain"
  ?{kind:"uncertain",text:"미확인",code:"EXECUTION_RESULT_UNKNOWN",nextAction:"check_status"}
  :kind==="need_more_info"?{kind:"need_more_info",text:"추가 정보",questionId:id(300)}
  :{kind:"outcome",text:"조회 결과",outcome:"success",operation:"list",schedulesChanged:false,items:[]}});
const json=(data,code=200)=>({status:code,headers:new Headers({"Content-Type":"application/json","X-Request-ID":id(900)}),text:async()=>JSON.stringify(data)});
const problem=(code=404,error="ASSISTANT_REQUEST_NOT_FOUND")=>({status:code,headers:new Headers({"Content-Type":"application/problem+json","X-Request-ID":id(900)}),text:async()=>JSON.stringify({type:"https://example.invalid/problem",title:"오류",detail:"해석하지 않는 문구",instance:"/api/v1/assistant/requests",status:code,code:error,requestId:id(900),assistantRequestId:id(1)})});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const settle=async()=>{for(let n=0;n<400;n++)await Promise.resolve();};
async function until(predicate){for(let n=0;n<700&&!predicate();n++)await Promise.resolve();assert.ok(predicate(),"예상 지점 도달");}

// root effect와 실제 복구 계층을 실행하되 native·네트워크·저장 데이터는 전용 대역으로 격리한다.
function harness({initialMode="server",baseUrl=origin,readOnly=false}={}){
  const cache=new Map(),data=new Map(),timers=new Map(),listeners=new Set();let wall=1000,mono=0,timerId=0;
  const state={app:"active",config:null,calls:[],reads:0,writes:0,cleanup:0,inits:0,failRead:false,beforeRead:null,
    handle:async(url,init)=>{assert.equal(init.method,"GET","lifecycle에서 POST 금지");return json(done("outcome",parseInt(url.split("/").pop().slice(0,8),16)));}};
  const adapter={async getItem(key){state.reads++;if(state.beforeRead)await state.beforeRead();if(state.failRead)throw Error("저장소 읽기 실패");return data.get(key)??null;},async setItem(key,value){state.writes++;data.set(key,value);}};
  const setTimer=(fn,ms)=>{const key=++timerId;timers.set(key,{fn,at:mono+ms});return key;},clearTimer=key=>timers.delete(key);
  const send=(url,init)=>{state.calls.push({url,init,at:mono});return state.handle(url,init);};
  const env={EXPO_PUBLIC_DEV_SERVER_BASE_URL:baseUrl,EXPO_PUBLIC_SCHEDULE_DATA_MODE:initialMode,EXPO_PUBLIC_SCHEDULE_READ_ONLY:readOnly?"true":"false"};
  const native={AppState:{get currentState(){return state.app;},addEventListener(event,listener){assert.equal(event,"change");listeners.add(listener);return{remove:()=>listeners.delete(listener)};}},Platform:{OS:"ios"},useColorScheme:()=>"light"};
  const hookSlots=[];let hookIndex=0,effects=[];
  const navigation={isReady:()=>true,addListener:()=>()=>{}},routes=[];
  const router={replace:route=>routes.push(route)};
  const react={useRef:initial=>{const i=hookIndex++;return hookSlots[i]??(hookSlots[i]={current:initial});},useEffect:(setup,deps)=>{
    const i=hookIndex++,previous=hookSlots[i];if(!previous||deps.some((value,n)=>value!==previous.deps[n]))effects.push(()=>{previous?.cleanup?.();hookSlots[i]={setup,deps,cleanup:setup()};});
  }};
  const Stack=()=>null;Stack.Screen=function StackScreen(){return null;};
  function load(name){
    if(name==="@/services/api/assistant-schedule-sync")return{assistantScheduleSync:{observe:async()=>null}};
    if(name==="expo/fetch")return{fetch:send};if(name==="react-native")return native;
    if(name==="@react-native-async-storage/async-storage")return adapter;if(name==="zustand/vanilla")return require(name);
    if(name==="react")return react;if(name==="react/jsx-runtime")return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==="expo-router")return{DarkTheme:{dark:true},DefaultTheme:{dark:false},Stack,ThemeProvider:()=>null,useNavigationContainerRef:()=>navigation,usePathname:()=>"/",useRouter:()=>router};
    assert.ok(name.startsWith("@/"));assert.notEqual(name,"@/services/api/http");
    const file=path.join(root,"src",name==="@/app/_layout"?"app/_layout.tsx":`${name.slice(2)}.ts`);
    if(cache.has(file))return cache.get(file).exports;const module={exports:{}};cache.set(file,module);
    const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText;
    new Function("require","module","exports","fetch","setTimeout","clearTimeout","performance","process",code)(load,module,module.exports,()=>{throw Error("실제 네트워크 금지");},setTimer,clearTimer,{now:()=>mono},{env});
    return module.exports;
  }
  const config=load("@/services/api/config");state.config=config.parseDevelopmentServerConfig(baseUrl);
  const storage=load("@/services/storage/assistant-recovery").assistantRecoveryStorage;
  const mode=load("@/stores/scheduleDataModeStore").scheduleDataModeStore;
  const http=load("@/services/api/assistant").createAssistantHttpClient({fetchImpl:send,recovery:storage,readConfig:()=>state.config,now:()=>wall});
  const requests=load("@/services/api/assistant-request-recovery").createAssistantRequestRecovery({http,recovery:storage,now:()=>wall});
  const orchestrator=load("@/services/api/assistant-orchestrator").createAssistantOrchestrator({http,requests,storage:{...storage,cleanup:async(...args)=>{state.cleanup++;return storage.cleanup(...args);}},clock:{now:()=>wall,monotonicNow:()=>mono}});
  const api=load("@/services/api/assistant-lifecycle");
  const service=api.createAssistantLifecycle({http,orchestrator:{initializeRecovery:options=>{state.inits++;return orchestrator.initializeRecovery(options);}}});
  async function advance(ms){const target=mono+ms;let count=0;while(true){const next=Math.min(...[...timers.values()].map(t=>t.at));if(next>target)break;if(++count>500)throw Error("타이머 반복");wall+=next-mono;mono=next;for(const[key,t]of[...timers])if(t.at<=mono){timers.delete(key);t.fn();}await settle();}wall+=target-mono;mono=target;await settle();}
  return{state,storage,data,mode,http,config,orchestrator,service,api,listeners,timers,advance,routes,
    get wall(){return wall;},set wall(value){wall=value;},
    seed:(n=1,first=1000,server=serverId)=>storage.saveBeforePost(ref(n,server),first),
    app(value){state.app=value;for(const listener of[...listeners])listener(value);},
    renderRoot(){hookIndex=0;effects=[];const tree=load("@/app/_layout").default();effects.forEach(run=>run());return tree;},
    replayEffects(){const slots=hookSlots.filter(slot=>slot?.setup);slots.forEach(slot=>slot.cleanup?.());slots.forEach(slot=>{slot.cleanup=slot.setup();});},
    unmountRoot(){hookSlots.filter(slot=>slot?.setup).forEach(slot=>slot.cleanup?.());},
  };
}

test("실제 root mount effect: cold start GET-only·결과 보관·기존 초기 경로 유지",async()=>{
  const h=harness();assert.equal(h.state.reads,0);await h.seed();assert.equal(h.listeners.size,0);
  const tree=h.renderRoot();assert.equal(tree.props.children.props.children.length,4);assert.deepEqual(h.routes,["/(tabs)/assistant"]);
  await until(()=>h.api.assistantLifecycle.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].init.method,"GET");
  assert.equal(h.state.calls[0].url,`${origin}/api/v1/assistant/requests/${id(1)}`);assert.equal(h.api.assistantLifecycle.getSnapshot().results[0].latestResult.kind,"completed");
  h.unmountRoot();await settle();assert.equal(h.listeners.size,0);assert.equal(h.state.cleanup,0);
});

test("root 재렌더·StrictMode effect 재연결에도 중복 초기화/GET/listener 없음",async()=>{
  const h=harness();await h.seed();h.renderRoot();h.replayEffects();h.renderRoot();
  await until(()=>h.api.assistantLifecycle.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,1);assert.equal(h.listeners.size,1);assert.equal(h.routes.length,1);
  h.unmountRoot();await settle();assert.equal(h.listeners.size,0);
});

test("복구 기록 없음은 GET 0회·정상 빈 결과, import/factory만으로 I/O 없음",async()=>{
  const h=harness();assert.equal(h.state.reads,0);assert.equal(h.listeners.size,0);const detach=h.service.attach();
  await until(()=>h.service.getSnapshot().phase==="settled");assert.deepEqual(h.service.getSnapshot().results,[]);assert.equal(h.state.calls.length,0);detach();await settle();
});

test("동일 서버 기록만 GET하고 다른 서버 기록은 보존",async()=>{
  const h=harness();await h.seed(1);await h.seed(2,1000,`development:${otherOrigin}`);const detach=h.service.attach();
  await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,1);assert.equal(h.service.getSnapshot().results.length,1);
  assert.notEqual(await h.storage.read(ref(2,`development:${otherOrigin}`)),null);detach();await settle();
});

test("다른 서버 기록만 있으면 요청 0회·원래 metadata 삭제 없음",async()=>{
  const h=harness();await h.seed(1,1000,`development:${otherOrigin}`);const original=[...h.data.values()].join("");const detach=h.service.attach();
  await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,0);assert.equal([...h.data.values()].join(""),original);detach();await settle();
});

test("복수 attach·재연결·반복 active는 초기화와 관리 listener를 공유",async()=>{
  const h=harness();await h.seed();const one=h.service.attach(),two=h.service.attach();one();const three=h.service.attach();two();
  for(let n=0;n<5;n++)h.app("active");await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.inits,1);assert.equal(h.state.calls.length,1);assert.equal(h.listeners.size,1);
  three();await settle();assert.equal(h.listeners.size,0);
});

test("foreground 전환은 원래 ID GET-only·반복 active에 조회 중첩 없음",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(pending());const detach=h.service.attach();
  await until(()=>h.service.getSnapshot().results[0]?.latestResult?.kind==="observed");h.app("background");await settle();assert.equal(h.service.getSnapshot().phase,"paused");assert.equal(h.timers.size,0);
  await h.advance(1000);h.app("active");for(let n=0;n<8;n++)h.app("active");await until(()=>h.state.calls.length===2);await settle();
  assert.equal(h.state.inits,2);assert.ok(h.state.calls.every(c=>c.init.method==="GET"));assert.ok(h.state.calls.every(c=>c.url.endsWith(id(1))));
  await h.advance(1999);assert.equal(h.state.calls.length,2);h.state.handle=async()=>json(done());await h.advance(1);
  await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,3);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);detach();await settle();
});

test("120초 이후 active 복귀는 한 번 GET하고 자동 polling을 새로 시작하지 않음",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(pending());const detach=h.service.attach();
  await until(()=>h.service.getSnapshot().results[0]?.latestResult?.kind==="observed");h.app("inactive");await settle();await h.advance(120000);h.app("active");
  await until(()=>h.service.getSnapshot().phase==="needs-attention");const snapshot=h.service.getSnapshot();assert.equal(snapshot.results[0].latestResult.reason,"deadline");assert.equal(h.state.calls.length,2);
  await h.advance(120000);assert.equal(h.state.calls.length,2);assert.equal(h.timers.size,0);assert.equal((await h.storage.read(ref())).firstPostAttemptAt,1000);detach();await settle();
});

test("빠른 background/active 반복은 이전 작업 중단 뒤 최신 전환만 복구",async()=>{
  const h=harness();await h.seed();const gate=deferred();h.state.handle=()=>gate.promise;const detach=h.service.attach();await until(()=>h.state.calls.length===1);
  h.app("background");h.app("active");h.app("inactive");h.app("active");h.state.handle=async()=>json(done());gate.resolve(json(done()));
  await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,2);assert.equal(h.timers.size,0);assert.ok(h.state.calls.every(c=>c.init.method==="GET"));detach();await settle();
});

test("unmount/Abort 뒤 listener·작업 정리 및 늦은 응답 반영 금지",async()=>{
  for(const abort of[false,true]){const h=harness();await h.seed();const gate=deferred(),controller=new AbortController();h.state.handle=()=>gate.promise;
    const detach=h.service.attach({signal:controller.signal});await until(()=>h.state.calls.length===1);if(abort)controller.abort();else detach();await settle();
    assert.equal(h.listeners.size,0);assert.equal(h.timers.size,0);const snapshot=h.service.getSnapshot();assert.equal(snapshot.phase,"stopped");
    gate.resolve(json(done()));await h.advance(120000);assert.equal(h.service.getSnapshot(),snapshot);assert.equal(h.state.calls.length,1);assert.equal(h.state.cleanup,0);
  }
});

test("Abort된 연결은 구독·metadata 조회·HTTP를 시작하지 않음",async()=>{
  const h=harness(),controller=new AbortController();controller.abort();h.service.attach({signal:controller.signal});await settle();assert.equal(h.listeners.size,0);assert.equal(h.state.reads,0);assert.equal(h.state.calls.length,0);
});

test("GET 오류·storage 오류는 성공/빈 결과로 바꾸지 않고 복구 metadata 보존",async()=>{
  for(const kind of["404","503","storage"]){const h=harness();await h.seed();const original=[...h.data.values()].join("");if(kind==="storage")h.state.failRead=true;else h.state.handle=async()=>problem(kind==="404"?404:503,kind==="404"?"ASSISTANT_REQUEST_NOT_FOUND":"ASSISTANT_UNAVAILABLE");
    const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="needs-attention");const snapshot=h.service.getSnapshot();
    if(kind==="storage")assert.equal(snapshot.initialization.reason,"storage");else assert.equal(snapshot.results[0].latestResult.recoveryResult.getResult.error.status,Number(kind));
    assert.equal([...h.data.values()].join(""),original);assert.equal(h.state.cleanup,0);detach();await settle();
  }
});

test("서버 설정 누락/오류와 Mock 모드는 GET 0회로 안전하게 종료",async()=>{
  for(const options of[{baseUrl:""},{baseUrl:"invalid"},{initialMode:"mock"}]){const h=harness(options);const detach=h.service.attach();await settle();assert.equal(h.service.getSnapshot().phase,"unavailable");assert.equal(h.state.calls.length,0);assert.equal(h.state.reads,0);detach();await settle();}
});

test("서버 설정 변경 중 늦은 결과는 폐기하고 다른 서버에 요청하지 않음",async()=>{
  const h=harness();await h.seed();const gate=deferred();h.state.handle=()=>gate.promise;const detach=h.service.attach();await until(()=>h.state.calls.length===1);
  h.state.config=h.config.parseDevelopmentServerConfig(otherOrigin);gate.resolve(json(done()));await until(()=>h.service.getSnapshot().phase==="unavailable");
  assert.equal(h.service.getSnapshot().issue,"server-mismatch");assert.equal(h.service.getSnapshot().results.length,0);assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].url.startsWith(origin),true);
  assert.notEqual(await h.storage.read(ref()),null);detach();await settle();
});

test("Mock 전환은 기존 작업을 무효화하고 server 복귀에서 GET-only 재확인",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(pending());const detach=h.service.attach();await until(()=>h.service.getSnapshot().results[0]?.latestResult?.kind==="observed");
  h.mode.getState().setMode("mock");await settle();assert.equal(h.service.getSnapshot().phase,"unavailable");const count=h.state.calls.length;h.app("active");await h.advance(5000);assert.equal(h.state.calls.length,count);
  h.state.handle=async()=>json(done());h.mode.getState().setMode("server");await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,count+1);assert.ok(h.state.calls.every(c=>c.init.method==="GET"));detach();await settle();
});

test("Schedule read-only에서도 허용된 복구 GET만 사용하고 쓰기 정책은 유지",async()=>{
  const h=harness({readOnly:true});await h.seed();const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.calls.length,1);assert.equal(h.state.calls[0].init.method,"GET");assert.equal(h.state.cleanup,0);detach();await settle();
});

test("결과는 작업 5가 구독/조회 가능하고 UI 표시 전 cleanup·채팅 영속 저장 없음",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(done("uncertain"));let updates=0;const unsubscribe=h.service.subscribe(()=>{updates++;});
  const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="settled");const snapshot=h.service.getSnapshot(),entry=snapshot.results[0];
  assert.equal(entry.latestResult.response.data.result.kind,"uncertain");assert.equal(entry.lastResponse.data.conversationId,id(100));assert.ok(updates>0);
  assert.equal(Reflect.set(entry.lastResponse.data.result,"kind","outcome"),false);assert.equal(h.state.cleanup,0);assert.notEqual(await h.storage.read(ref()),null);
  const persisted=[...h.data.values()].join("");assert.equal(persisted.includes("미확인"),false);assert.equal(persisted.includes("messages"),false);unsubscribe();const before=updates;
  h.app("background");await settle();assert.equal(updates,before);detach();await settle();
});

test("화면 구독자 예외와 복구 초기화 예외는 전체 앱 실행을 막지 않음",async()=>{
  const h=harness();await h.seed();h.service.subscribe(()=>{throw Error("구독자 실패");});const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="settled");detach();await settle();
  const failing=h.api.createAssistantLifecycle({http:h.http,orchestrator:{initializeRecovery:async()=>{throw Error("하위 예외");}}});const stop=failing.attach();
  await until(()=>failing.getSnapshot().phase==="needs-attention");assert.equal(failing.getSnapshot().issue,"unexpected");stop();await settle();
});

test("storage 조회 중 unmount도 늦은 초기화 결과를 버리고 데이터는 보존",async()=>{
  const h=harness();await h.seed();const reads=h.state.reads,gate=deferred();h.state.beforeRead=()=>gate.promise;const detach=h.service.attach();await until(()=>h.state.reads>reads);detach();await settle();const snapshot=h.service.getSnapshot();
  gate.resolve();await settle();assert.equal(h.service.getSnapshot(),snapshot);assert.equal(h.state.calls.length,0);assert.notEqual(await h.storage.read(ref()),null);
});

test("cold start가 inactive/unknown이면 active가 확인된 뒤 한 번만 복구",async()=>{
  for(const initial of["inactive",null]){const h=harness();await h.seed();h.app(initial);const detach=h.service.attach();await settle();assert.equal(h.state.inits,0);assert.equal(h.state.calls.length,0);
    h.app("active");h.app("active");await until(()=>h.service.getSnapshot().phase==="settled");assert.equal(h.state.inits,1);assert.equal(h.state.calls.length,1);detach();await settle();}
});

test("복구 질문의 서버 questionId와 conversationId는 작업 5의 snapshot에 보존",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(done("need_more_info"));const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="settled");
  const response=h.service.getSnapshot().results[0].latestResult.response;assert.equal(response.data.result.questionId,id(300));assert.equal(response.data.conversationId,id(100));assert.equal(h.state.cleanup,0);
  assert.deepEqual(h.state.calls.map(c=>c.init.method),["GET"]);detach();await settle();
});

test("연결 중 구독자에서 Abort가 발생해도 초기 GET 없이 해제",async()=>{
  const h=harness(),controller=new AbortController();await h.seed();h.service.subscribe(()=>controller.abort());h.service.attach({signal:controller.signal});await settle();assert.equal(h.state.calls.length,0);assert.equal(h.listeners.size,0);
});

test("foreground 조회 실패는 직전 관측값을 성공으로 덮지 않고 오류와 함께 보관",async()=>{
  const h=harness();await h.seed();h.state.handle=async()=>json(done("uncertain"));const detach=h.service.attach();await until(()=>h.service.getSnapshot().phase==="settled");
  h.app("background");await settle();h.state.handle=async()=>problem(503,"ASSISTANT_UNAVAILABLE");h.app("active");await until(()=>h.service.getSnapshot().phase==="needs-attention");
  const entry=h.service.getSnapshot().results[0];assert.equal(entry.lastResponse.data.result.kind,"uncertain");assert.equal(entry.latestResult.kind,"needs-attention");
  assert.equal(entry.latestResult.recoveryResult.getResult.error.problem.code,"ASSISTANT_UNAVAILABLE");assert.equal((await h.storage.read(ref())).lastResultKind,"uncertain");assert.equal(h.state.cleanup,0);detach();await settle();
});
