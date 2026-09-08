import type { Page } from "@playwright/test";

// Browser-only fixture. It verifies rendering and interaction, not native IPC,
// credential storage, network policy, or a live model service.
export async function mockAiForBrowser(page: Page, compact = false) {
  await page.addInitScript(() => {
    localStorage.setItem("core-robin.onboarding.v1", "completed");
    localStorage.setItem("core-robin.language.v1", "en");
    localStorage.setItem(
      "core-robin.update-check.checked-at.v1",
      String(Date.now()),
    );
    localStorage.setItem(
      "core-robin.settings.v1",
      JSON.stringify({
        version: 1,
        language: "en",
        experienceMode: "professional",
        reduceMotion: true,
      }),
    );
  });
  await page.route("**/src/ai/api.ts*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: aiFixtureModule }),
  );
  await page.route("**/src/aiNavigation.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    export const AI_NAVIGATION_EVENT = "core-robin:ai-navigation";
    export const AI_CHAT_VISIBILITY_EVENT = "core-robin:ai-chat-visibility";
    export const readAiNavigation = async () => null;
    export const acknowledgeAiNavigation = async () => {};
    export const continueAiInMain = async (sessionId, settings=false) => { window.__aiNavigation = {sessionId,settings}; return {token:1,sessionId,settings}; };
    export const hideAiChat = async () => {window.__aiHidden = true;};
  `,
    }),
  );
  await page.route("**/src/capabilities/api.ts*", (route) => route.fulfill({
    contentType: "text/javascript", body: `
      export const readApplicationCapabilities = async () => ({ diskRevision: 1, diskRequiresRescan: false, networkRevision: 0, network: null });
      export const subscribeApplicationCapabilities = async () => () => {};
    `,
  }));
  if (compact) {
    await page.route(
      "**/node_modules/.vite/deps/@tauri-apps_api_window.js*",
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "export const getCurrentWindow = () => ({isVisible:async()=>true,isFocused:async()=>true});",
        }),
    );
    await page.route(
      "**/node_modules/.vite/deps/@tauri-apps_api_event.js*",
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "export const listen = async () => () => {};",
        }),
    );
  }
}

const aiFixtureModule = String.raw`
const clone = value => JSON.parse(JSON.stringify(value));
const listeners = new Set();
const emit = () => listeners.forEach(callback => callback());
const now = Date.now();
const base = {revision:1,authHeaderName:null,networkPolicy:"loopback",proxyUrl:null,proxyNetworkPolicy:null,proxyCredentialStatus:"not_required",anthropicWorkspaceId:null,chatTokenLimitParameter:"auto",timeoutSeconds:180,maxOutputTokens:1024,stream:true,credentialStatus:"not_required"};
const state = {settings:{enabled:true,defaultModel:{connectionId:"local",modelId:"my-local-model"},localConnectionsOnly:false,storageBudgetBytes:268435456},connections:[{...base,id:"local",name:"Local Ollama",protocol:"ollama_native",apiBaseUrl:"http://127.0.0.1:11434",authKind:"none"},{...base,id:"cloud",name:"My Claude",protocol:"anthropic_messages",apiBaseUrl:"https://api.anthropic.com/v1",authKind:"api_key",networkPolicy:"public",credentialStatus:"saved"}],activeRun:null,storageBytes:174080,storageWarning:false,requestEpoch:1};
let sessions = [{id:"chat-1",title:"Understanding my device",revision:1,createdAt:now,updatedAt:now,temporary:false,selectedModel:{connectionId:"local",modelId:"my-local-model"},draftText:"",draftRevision:1,storageStatus:"saved",sourceCategories:["resources"],scenario:"current_status",incidentId:null,fromMs:null,toMs:null,messages:[]}];
let prepared;
window.__aiFixture={state,calls:{prepare:0,start:0,listModels:0,testModel:0},failNext:false,toolTask:false,toolCards:false,formIds:null,decisions:[],cardActions:[]};
const find = id => {const session=sessions.find(item=>item.id===id);if(!session)throw {code:"not_found",message:"Conversation deleted"};return session;};
export const aiApi = {
getState:async()=>clone(state),onChange:async(callback)=>{listeners.add(callback);return()=>listeners.delete(callback);},onVisibility:async()=>()=>{},
updateSettings:async(input)=>{state.settings=clone(input);emit();return clone(state);},
saveConnection:async(input)=>{const item={...base,...input,id:input.id||"connection-"+Date.now(),revision:(input.expectedRevision||0)+1};state.connections=state.connections.filter(old=>old.id!==item.id).concat(item);emit();return clone(item);},
deleteConnection:async(id)=>{state.connections=state.connections.filter(item=>item.id!==id);emit();},setCredential:async()=>{},deleteCredential:async()=>{},setProxyCredential:async()=>{},deleteProxyCredential:async()=>{},
listModels:async()=>{window.__aiFixture.calls.listModels++;return[{id:"my-local-model",name:"My local model"}];},testModel:async()=>{window.__aiFixture.calls.testModel++;return{text:"The test message reached your model.",usage:null,reportedModel:null};},
createSession:async(input={})=>{const item={id:"chat-"+Date.now(),title:"New conversation",revision:1,createdAt:Date.now(),updatedAt:Date.now(),temporary:!!input.temporary,selectedModel:input.selectedModel||state.settings.defaultModel,draftText:"",draftRevision:1,storageStatus:input.temporary?"temporary":"saved",sourceCategories:[],messages:[],scenario:input.scenario||"current_status",incidentId:input.incidentId||null,fromMs:input.fromMs??null,toMs:input.toMs??null};sessions.unshift(item);emit();return clone(item);},
listSessions:async()=>({sessions:clone(sessions),hasMore:false}),getSession:async(id)=>clone(find(id)),
saveDraft:async(id,revision,text)=>{const item=find(id);if(item.draftRevision!==revision)throw {code:"draft_conflict",message:"The draft changed in another window."};item.draftText=text;item.draftRevision++;return clone(item);},
selectModel:async(id,revision,selection)=>{const item=find(id);item.selectedModel=selection;item.revision++;emit();return clone(item);},
setSessionContext:async(id,revision,context)=>{const item=find(id);Object.assign(item,context);item.revision++;emit();return clone(item);},
renameSession:async(id,title)=>{const item=find(id);item.title=title;item.revision++;emit();return clone(item);},
deleteSession:async(id)=>{sessions=sessions.filter(item=>item.id!==id);emit();},clearConversations:async()=>{sessions=[];emit();},
prepare:async(input)=>{window.__aiFixture.calls.prepare++;const item=find(input.sessionId);const profile=state.connections.find(p=>p.id===item.selectedModel.connectionId);prepared={id:"preview-"+Date.now(),sessionId:item.id,sessionRevision:item.revision,expiresAt:Date.now()+60000,selection:item.selectedModel,connectionName:profile.name,endpoint:profile.apiBaseUrl,protocol:profile.protocol,preview:input.text+(input.includeContext?"\n\nDevice evidence (aggregate values only):\nCPU utilization: 24%\nMemory utilization: 52%\nRecorded period: current snapshot":""),userText:input.text,scenario:input.scenario,sourceCategories:input.includeContext?["resources"]:[],coverage:input.scenario==="history"?["No historical samples are available for this period. Only the current snapshot can be discussed."]:["Current device metrics only. No application names, paths or IP addresses are included."],requestEpoch:1,history:item.messages.filter(m=>m.reusableInContext).map(m=>({role:m.role,content:m.content})),proxyUrl:profile.proxyUrl};return clone(prepared);},
start:async(id,submissionId,revision,remember)=>{window.__aiFixture.calls.start++;if(window.__aiFixture.failNext){window.__aiFixture.failNext=false;throw{code:"timeout",message:"The model service did not respond before the timeout. No automatic retry was made."};}const item=find(prepared.sessionId);const run={requestId:"run-"+Date.now(),sessionId:item.id,submissionId,state:"streaming",startedAt:Date.now(),finishedAt:null,error:null};state.activeRun=run;item.messages.push({id:"user-"+Date.now(),role:"user",content:prepared.userText,contextText:prepared.preview,createdAt:Date.now(),status:"complete",requestId:run.requestId,modelLabel:null,sourceCategories:prepared.sourceCategories,reusableInContext:true,usage:null});const answer={id:"answer-"+Date.now(),role:"assistant",content:"",createdAt:Date.now(),status:"streaming",requestId:run.requestId,modelLabel:item.selectedModel.modelId,sourceCategories:prepared.sourceCategories,reusableInContext:true,usage:null};item.messages.push(answer);item.draftText="";item.draftRevision++;item.revision++;emit();if(window.__aiFixture.formIds){answer.content="These forms use the existing local application controls. No operation has run.";answer.status="complete";answer.toolSteps=window.__aiFixture.formIds.map((capabilityId,index)=>({id:"form-"+index,name:"open_application_capability",state:"complete",startedAt:now,finishedAt:now,result:JSON.stringify({kind:"application_capability",capabilityId,surface:"main_window",requiresUserInput:true,operationExecuted:false}),error:null,confirmation:null}));run.state="complete";run.finishedAt=Date.now();item.revision++;emit();return clone(run);}if(window.__aiFixture.toolCards){answer.content="The native inspections finished. You can work with the results below.";answer.status="complete";answer.toolSteps=[
{name:"get_device_status",value:{sampledAt:now,cpu:{usagePercent:24},memory:{usedBytes:8000000000,totalBytes:32000000000,availableBytes:24000000000},temperatureCelsius:45,disk:{volumes:[{name:"Macintosh HD",totalBytes:1000000000000,availableBytes:300000000000}]}}},
{name:"get_process_usage",value:{sampledAt:now,processes:[{name:"Synthetic editor",pid:12345,cpuPercent:24,memoryBytes:512000000,targetRef:"process-1",protected:false}]}},
{name:"run_network_check",value:{sampledAt:now,diagnostics:[{kind:"dns",status:"passed",latencyMs:12},{kind:"internet",status:"degraded",latencyMs:200}],averageLatencyMs:106,tcpProbeFailurePercent:20}},
{name:"scan_disk_usage",value:{sampledAt:now,sourceRevision:1,scanId:"fixture-scan",scannedEntries:12500,unreadableEntries:3,items:[{targetRef:"disk-1",name:"Downloads",allocatedBytes:2400000000,logicalBytes:2500000000,itemCount:28,safety:"review"},{targetRef:"disk-2",name:"Application caches",allocatedBytes:1800000000,logicalBytes:1900000000,itemCount:1620,safety:"reclaimable"}]}},
{name:"get_recorded_history",value:{sampledAt:now,observations:[{label:"Historical CPU mean",value:"24",unit:"%"},{label:"Historical memory peak",value:"62",unit:"%"}],coverage:["Historical values summarize recorded samples only; gaps between samples are not reconstructed."]}}
].map((step,index)=>({id:"card-"+index,name:step.name,state:"complete",startedAt:now,finishedAt:now,result:JSON.stringify(step.value),actionsExpiresAt:now+600000,error:null,confirmation:null}));run.state="complete";run.finishedAt=Date.now();emit();return clone(run);}if(window.__aiFixture.toolTask){answer.content="The process check finished. Review the exact target before closing it.";answer.toolSteps=[{id:"check",name:"get_process_usage",state:"complete",startedAt:Date.now(),finishedAt:Date.now(),result:JSON.stringify({processes:[{name:"Synthetic editor",cpuPercent:24,targetRef:"native-target"}]}),error:null,confirmation:null},{id:"action",name:"request_process_action",state:"awaiting_confirmation",startedAt:Date.now(),finishedAt:null,result:null,error:null,confirmation:{action:"request_close",targets:["Synthetic editor · PID 12345"],detail:"Unsaved work may be lost.",expiresAt:Date.now()+60000}}];item.revision++;emit();return clone(run);}setTimeout(()=>{answer.content="Your current CPU and memory usage leave comfortable headroom. This snapshot does not show a resource bottleneck.\n\nIf the device still feels slow, compare several samples and check the affected application. A single snapshot cannot establish the cause.";answer.status="complete";item.revision++;run.state="complete";run.finishedAt=Date.now();emit();},250);return clone(run);},
runCapabilityAction:async(input)=>{window.__aiFixture.cardActions.push(clone(input));const item=find(input.sessionId);const run={requestId:"card-run-"+Date.now(),sessionId:item.id,state:"complete",startedAt:Date.now(),finishedAt:Date.now(),error:null};const writing=input.action!=="refresh";if(writing)run.state="streaming";state.activeRun=run;item.messages.push({id:"local-"+Date.now(),role:"assistant",content:"",createdAt:Date.now(),status:writing?"streaming":"complete",requestId:run.requestId,modelLabel:null,sourceCategories:["applications"],reusableInContext:false,usage:null,toolSteps:[{id:"manual-step",name:writing?"request_cleanup":"get_device_status",state:writing?"awaiting_confirmation":"complete",startedAt:Date.now(),finishedAt:null,result:null,error:null,confirmation:writing?{action:"trash",targets:["/synthetic/Application caches"],detail:"Review the exact local target.",expiresAt:Date.now()+60000}:null}]});item.revision++;emit();return clone(run);},
resolveToolConfirmation:async(requestId,stepId,approved)=>{const run=state.activeRun;const item=find(run.sessionId);const answer=item.messages.at(-1);const step=answer.toolSteps.find(step=>step.id===stepId);if(run.requestId!==requestId||step.state!=="awaiting_confirmation")throw{code:"stale_state",message:"Decision changed"};window.__aiFixture.decisions.push({requestId,stepId,approved});step.state=approved?"complete":"failed";step.finishedAt=Date.now();if(approved)step.result=JSON.stringify({signalSent:true});else step.error={code:"action_rejected",message:"The user declined this action."};answer.content=approved?"The native controller sent the close request. Exit is not guaranteed.":"The close request was declined. No process was stopped.";answer.status="complete";item.revision++;run.state="complete";run.finishedAt=Date.now();emit();},
cancel:async()=>{if(state.activeRun)state.activeRun.state="cancelled";emit();}
};
`;
