import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

class Target extends EventTarget {}
class Textarea extends Target {
  value='';selectionStart=0;selectionEnd=0;selectionDirection='none';disabled=false;readOnly=false;
}
class MemoryStore {
  states=new Map();events=new Map();fail=false;
  async load(scope) { return structuredClone({state:this.states.get(scope)||null,events:[...this.events.values()].filter(e=>e.scope===scope)}); }
  async list(key) { return structuredClone([...this.states.values()].filter(state=>state.participantKey===key)); }
  async put(state,events) {
    if(this.fail) throw new Error('storage failed');
    // Simulates a transaction commit, rather than a request success callback.
    await Promise.resolve();this.states.set(state.scope,structuredClone(state));
    for(const event of events) this.events.set(event.id,structuredClone(event));
  }
  async acknowledge(ids) { for(const id of ids) this.events.delete(id); }
}
function environment() {
  const win=new Target();win.window=win;win.setInterval=callback=>{win.intervalTick=callback;return 1;};win.clearInterval=()=>{};win.innerHeight=800;win.innerWidth=1200;
  const doc=new Target();doc.hidden=false;doc.visibilityState='visible';
  const source=readFileSync(new URL('../assets/logging.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{window:win,document:doc,navigator:{},structuredClone,TextEncoder,performance,crypto,console});
  const textarea=new Textarea();doc.activeElement=textarea;
  return {win,doc,textarea,Recorder:win.SLPLogging.Recorder};
}
function dispatch(target,type,properties={}) {
  const event=new Event(type);for(const [key,value] of Object.entries(properties)) Object.defineProperty(event,key,{value});
  target.dispatchEvent(event);
}
function edit(f,text,inputType='insertText',extra={}) {
  dispatch(f.textarea,'beforeinput',{inputType,data:extra.data ?? text,isComposing:!!extra.isComposing});
  f.textarea.value=text;f.textarea.selectionStart=f.textarea.selectionEnd=text.length;
  dispatch(f.textarea,'input',{inputType,data:extra.data ?? text,isComposing:!!extra.isComposing});
}
async function fixture({store=new MemoryStore(),call,server=false}={}) {
  const f=environment();let clock=100,wall=10000;
  let actor;
  if(server) { const context=setup();actor=await context.create('01');await actor.participant({action:'participant_start',session_id:'01-T1'});f.context=context;f.actor=actor; }
  const uploaded=[];
  const transport=call || (async body=>{
    uploaded.push(structuredClone(body));
    if(server) { const result=await actor.participant(body);if(result.response.status!==200) throw Object.assign(new Error(result.data.error),{status:result.response.status});return result.data; }
    return {accepted_sequences:body.events.map(e=>e.seq),page_id:body.page.page_id};
  });
  const status=[];
  const recorder=new f.Recorder({base:'https://worker.test',participantId:'01',sessionId:'01-T1',textarea:f.textarea,store,call:transport,doc:f.doc,win:f.win,now:()=>clock++,wall:()=>wall++,timeOrigin:1000,onStatus:(message,error)=>status.push({message,error})});
  await recorder.initialize();await recorder.flushAll();
  return {...f,store,recorder,uploaded,status};
}
test('records replacement, paste, undo and selection without keydown-based text reconstruction',async()=>{
  const f=await fixture();const first=f.recorder.current.draft_id;
  edit(f,'Could you swap?');
  f.textarea.selectionStart=0;f.textarea.selectionEnd=5;dispatch(f.textarea,'select');
  edit(f,'Would you swap?');edit(f,'Would you swap? Please.','insertFromPaste');edit(f,'Would you swap?','historyUndo');
  await f.recorder.persist();
  const events=f.recorder.queue.filter(e=>e.event_type==='input');
  assert.equal(events[1].payload.text_before,'Could you swap?');assert.equal(events[1].payload.text_after,'Would you swap?');
  assert.deepEqual(Array.from(events[1].payload.selection_before),[0,5]);assert.equal(events[2].payload.input_type,'insertFromPaste');assert.equal(events[3].payload.input_type,'historyUndo');
  edit(f,'','deleteContentBackward');edit(f,'A fresh start.');assert.equal(f.recorder.current.draft_id,first);
  const foreign=new Textarea();dispatch(foreign,'keydown',{key:'private'});dispatch(foreign,'input',{data:'private'});
  assert.equal(f.recorder.queue.some(e=>e.payload.key==='private'),false);
  await f.recorder.stop('test');f.recorder.dispose();
});
test('input fallback and composition groups keep actual DOM text and prevent mid-composition sends',async()=>{
  const f=await fixture();
  f.textarea.value='auto-corrected';f.textarea.selectionStart=f.textarea.selectionEnd=14;
  dispatch(f.textarea,'input',{inputType:'insertReplacementText',data:null});
  assert.equal(f.recorder.queue.at(-1).payload.beforeinput_observed,false);
  dispatch(f.textarea,'compositionstart',{data:''});
  assert.throws(()=>f.recorder.prepareSend(),/composition/);
  edit(f,'你好','insertCompositionText',{isComposing:true});
  dispatch(f.textarea,'compositionupdate',{data:'你好'});dispatch(f.textarea,'compositionend',{data:'你好'});
  assert.equal(f.recorder.composing,false);
  const events=f.recorder.queue.filter(e=>e.payload.composition_id);
  assert.equal(new Set(events.map(e=>e.payload.composition_id)).size,1);
  assert.equal(f.recorder.current.text,'你好');await f.recorder.stop('test');f.recorder.dispose();
});
test('pending send survives reload, reuses its identifier, and raw whitespace is retained',async()=>{
  const store=new MemoryStore(),first=await fixture({store});edit(first,' Hi ');
  const payload=first.recorder.prepareSend();await first.recorder.persist();first.recorder.dispose();
  const second=await fixture({store});
  assert.equal(second.textarea.value,' Hi ');assert.equal(second.recorder.canEdit,false);
  const retry=second.recorder.prepareSend();assert.equal(retry.client_message_id,payload.client_message_id);assert.equal(retry.draft_id,payload.draft_id);
  assert.equal(retry.text,'Hi');assert.equal(retry.logging.draft.raw_at_send,' Hi ');
  await second.recorder.acknowledge({id:28});
  assert.equal(second.textarea.value,'');assert.notEqual(second.recorder.current.draft_id,payload.draft_id);
  const old=second.recorder.state.drafts[payload.draft_id];assert.equal(old.text,' Hi ');assert.equal(old.state,'sent');
  assert.equal(second.recorder.queue.some(event=>event.event_type==='programmatic_clear'),true);
  assert.equal(second.recorder.queue.some(event=>event.event_type==='input' && event.payload.text_after===''),false);
  await second.recorder.stop('test');second.recorder.dispose();
});
test('network failures retain durable outbox and require exact server acknowledgement',async()=>{
  let fail=false,badAck=false;
  const f=await fixture({call:async body=>{
    if(fail) throw new Error('offline');
    return {page_id:body.page.page_id,accepted_sequences:badAck?[]:body.events.map(event=>event.seq)};
  }});
  edit(f,'unsent');await f.recorder.persist();fail=true;
  await assert.rejects(f.recorder.flush(),/offline/);
  assert.ok(f.store.events.size);const backup=f.recorder.backup();assert.ok(backup.events.length);assert.equal(JSON.stringify(backup).includes('access_code'),false);
  fail=false;badAck=true;await assert.rejects(f.recorder.flush(),/acknowledge/);assert.ok(f.store.events.size);
  badAck=false;await f.recorder.stop('test');assert.equal(f.store.events.size,0);
  assert.equal(f.recorder.current.state,'unsent');f.recorder.dispose();
});
test('local commit failures block further sends rather than claim successful recording',async()=>{
  const f=await fixture();f.store.fail=true;edit(f,'must keep');
  await assert.rejects(f.recorder.persist(),/storage failed/);
  assert.equal(f.recorder.canEdit,false);assert.throws(()=>f.recorder.prepareSend(),/not ready/);
  assert.equal(f.recorder.backup().events.at(-1).payload.text_after,'must keep');f.recorder.dispose();
});
test('message observations distinguish background, viewport entry and initial history',async()=>{
  const f=await fixture();
  f.recorder.messageContainer={getBoundingClientRect:()=>({top:100,bottom:400,left:0,right:500})};
  let itemTop=500;const element={getBoundingClientRect:()=>({top:itemTop,bottom:itemTop+30,left:10,right:100})};
  f.recorder.observeMessage({id:7,sender:'interlocutor'},element,{initialSync:true});
  const first=f.recorder.queue.at(-1);assert.equal(first.payload.visible,false);assert.equal(first.payload.initial_sync,true);
  itemTop=150;f.doc.hidden=true;f.recorder.refreshVisible('test');assert.equal(f.recorder.queue.at(-1),first);
  f.doc.hidden=false;f.recorder.refreshVisible('test');assert.equal(f.recorder.queue.at(-1).event_type,'message_visible');
  const count=f.recorder.queue.length;f.recorder.refreshVisible('test');assert.equal(f.recorder.queue.length,count);
  await f.recorder.stop('test');f.recorder.dispose();
});
test('recorder events round-trip through the actual Worker, including sending, reconnect and closing',async()=>{
  const f=await fixture({server:true});edit(f,'Could you help?');edit(f,'Would you help?');
  const send=f.recorder.prepareSend();await f.recorder.persist();
  const result=await f.actor.participant({action:'participant_send',session_id:'01-T1',...send});assert.equal(result.response.status,200);
  await f.recorder.acknowledge(result.data.message);edit(f,'not sent');await f.recorder.stop('ended_by_participant');
  await f.actor.participant({action:'participant_end',session_id:'01-T1'});
  const summary=(await f.actor.admin({action:'admin_session',include_recording:true,session_id:'01-T1'})).data.recording;
  assert.equal(summary.messages_without_draft,0);assert.equal(summary.pages[0].missing_events,0);assert.equal(summary.pages[0].acknowledged_tail_complete,true);
  const drafts=f.context.env.DB.db.prepare('SELECT * FROM drafts ORDER BY created_ms').all();
  assert.equal(drafts.find(d=>d.draft_id===send.draft_id).state,'sent');assert.equal(drafts.find(d=>d.draft_id!==send.draft_id).text,'not sent');
  f.recorder.dispose();
});
test('late send acknowledgement after researcher termination never creates an editable new draft',async()=>{
  const f=await fixture();edit(f,'pending');f.recorder.prepareSend();await f.recorder.stop('server_ended');
  const original=f.recorder.current.draft_id;
  await f.recorder.acknowledge({id:12});assert.equal(f.recorder.current.draft_id,original);assert.equal(f.recorder.current.state,'sent');assert.equal(f.recorder.canEdit,false);assert.equal(f.recorder.queue.length,0);f.recorder.dispose();
});
test('refresh with queued old-page events and a lost send ack preserves linkage in the real Worker',async()=>{
  const first=await fixture({server:true});edit(first,'  Recovered  ');const send=first.recorder.prepareSend();await first.recorder.persist();
  const message=(await first.actor.participant({action:'participant_send',session_id:'01-T1',...send})).data.message;
  first.recorder.dispose();
  const second=await fixture({store:first.store,call:async body=>{const result=await first.actor.participant(body);if(result.response.status!==200) throw new Error(result.data.error);return result.data;}});
  const retry=second.recorder.prepareSend();await second.recorder.persist();
  const confirmed=await first.actor.participant({action:'participant_send',session_id:'01-T1',...retry});
  assert.equal(confirmed.data.message.id,message.id);
  await second.recorder.acknowledge(confirmed.data.message);await second.recorder.stop('test');
  const summary=(await first.actor.admin({action:'admin_session',include_recording:true,session_id:'01-T1'})).data.recording;
  assert.equal(summary.pages.length,2);assert.equal(summary.pages.every(page=>page.missing_events===0),true);
  assert.equal(summary.pages.some(page=>!page.closed),true);assert.equal(summary.messages_without_draft,0);
  second.recorder.dispose();
});
test('maximum-length replacement with control characters stays below upload bounds after send preparation',async()=>{
  const f=await fixture({server:true});const text='\u0001'.repeat(10000);
  edit(f,text);edit(f,text,'insertFromPaste');f.recorder.prepareSend();await f.recorder.persist();await f.recorder.flushAll();
  const row=f.context.env.DB.db.prepare('SELECT raw_at_send,text FROM drafts').get();assert.equal(row.raw_at_send,text);assert.equal(row.text,text);
  await f.recorder.stop('test');f.recorder.dispose();
});


test('automatic upload retries back off while queued events remain durable',async()=>{
 const f=await fixture();let calls=0;
 f.recorder.call=async()=>{calls++;throw new Error('quota unavailable');};
 edit(f,'keep this draft');await f.recorder.persist();
 await assert.rejects(f.recorder.flush());
 const queued=f.recorder.queue.length;assert.ok(queued>0);
 for(let n=0;n<10;n++)f.win.intervalTick();
 await Promise.resolve();assert.equal(calls,1);assert.equal(f.recorder.queue.length,queued);
 f.recorder.retryAfter=0;f.win.intervalTick();await f.recorder.flushFlight.catch(()=>{});
 assert.equal(calls,2);assert.ok(f.recorder.retryAfter>0);
 f.recorder.dispose();
});
