import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './helpers.mjs';

async function fixture() {
  const context=setup();
  const actor=await context.create('01');
  await actor.participant({action:'participant_start',session_id:'01-T1'});
  const page={page_id:'page-one',time_origin_ms:1000,started_wall_ms:1100,declared_seq:3,closed:false};
  const draft={draft_id:'draft-one',client_message_id:'client-one',revision:1,text:'Hi',state:'editing',raw_at_send:null,last_page_id:page.page_id,last_seq:3};
  const event=(seq,event_type,payload={},draft_id=null)=>({seq,event_type,payload,draft_id,client_elapsed_ms:seq*10,client_wall_ms:1100+seq*10});
  const events=[event(1,'page_start'),event(2,'draft_start',{},draft.draft_id),event(3,'input',{text_before:'H',text_after:'Hi',selection_before:[1,1],selection_after:[2,2]},draft.draft_id)];
  const ingest=(changes={})=>actor.participant({action:'participant_events',recording_version:1,session_id:'01-T1',page,drafts:[draft],events,...changes});
  return {...context,...actor,page,draft,event,events,ingest};
}
test('recording is participant-owned, immutable on retry, and hidden from participant polling',async()=>{
  const f=await fixture();
  assert.equal((await f.ingest()).response.status,200);
  assert.equal((await f.ingest()).response.status,200);
  assert.equal(f.env.DB.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n,3);
  const changed=structuredClone(f.events);changed[2].payload.text_after='changed';
  assert.equal((await f.ingest({events:changed})).response.status,409);
  const other=await f.create('02');
  assert.equal((await other.participant({action:'participant_events',session_id:'01-T1'})).response.status,403);
  const publicData=(await f.participant({action:'participant_session',session_id:'01-T1'})).data;
  assert.equal('drafts' in publicData,false); assert.equal('events' in publicData,false);
  const monitor=(await f.admin({action:'admin_session',session_id:'01-T1'})).data.recording;
  assert.equal(monitor.event_count,3);assert.equal(monitor.pages[0].missing_events,0);assert.equal(monitor.pages[0].acknowledged_tail_complete,false);
  const exported=(await f.admin({action:'admin_export',participant_code:'01'})).data;
  assert.equal(exported.format_version,3);assert.equal(exported.recording.drafts[0].text,'Hi');
});
test('send transaction links raw draft to trimmed message; late upload cannot unset sent state',async()=>{
  const f=await fixture();await f.ingest();
  const page={...f.page,declared_seq:4};
  const draft={...f.draft,revision:2,text:' Hi ',raw_at_send:' Hi ',state:'pending',last_seq:4};
  const body={action:'participant_send',session_id:'01-T1',client_message_id:draft.client_message_id,text:'Hi',client_elapsed_ms:50,logging:{page,draft}};
  const sent=await f.participant(body);assert.equal(sent.response.status,200);
  assert.equal((await f.participant(body)).data.message.id,sent.data.message.id);
  const linked=f.env.DB.db.prepare('SELECT * FROM drafts').get();
  assert.equal(linked.message_id,sent.data.message.id);assert.equal(linked.raw_at_send,' Hi ');assert.equal(linked.state,'sent');
  await f.participant({action:'participant_end',session_id:'01-T1'});
  const late=await f.ingest({page:{...page,closed:true},events:[f.event(4,'send_attempt',{raw_text:' Hi '},draft.draft_id)],drafts:[draft]});
  assert.equal(late.response.status,200);
  assert.equal(f.env.DB.db.prepare('SELECT state FROM drafts').get().state,'sent');
  assert.equal(f.env.DB.db.prepare('SELECT received_after_end FROM interaction_events WHERE seq=4').get().received_after_end,1);
  assert.equal((await f.participant(body)).data.message.id,sent.data.message.id);
  assert.equal(f.env.DB.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});
test('lost send acknowledgement can be reconciled by client message ID without re-sending',async()=>{
  const f=await fixture();
  const pending={...f.draft,revision:2,state:'pending',raw_at_send:'Hi'};
  const sent=await f.participant({action:'participant_send',session_id:'01-T1',client_message_id:pending.client_message_id,text:'Hi',logging:{page:f.page,draft:pending}});
  assert.equal(sent.response.status,200);
  assert.equal((await f.ingest({drafts:[pending]})).response.status,200);
  assert.equal(f.env.DB.db.prepare('SELECT state FROM drafts').get().state,'sent');
  assert.equal(f.env.DB.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});
test('out-of-order batches report missing sequence numbers and close only when tail matches',async()=>{
  const f=await fixture();
  const page={...f.page,declared_seq:4,closed:true};
  assert.equal((await f.ingest({page,events:[f.event(4,'page_end')]})).response.status,200);
  let data=(await f.admin({action:'admin_session',session_id:'01-T1'})).data.recording;
  assert.equal(data.pages[0].missing_events,3);assert.equal(data.pages[0].acknowledged_tail_complete,false);
  await f.ingest({page});
  data=(await f.admin({action:'admin_session',session_id:'01-T1'})).data.recording;
  assert.equal(data.pages[0].missing_events,0);assert.equal(data.pages[0].acknowledged_tail_complete,true);
});
test('researcher termination retains unsent drafts and accepts queued events, not chat messages',async()=>{
  const f=await fixture();await f.ingest();
  await f.admin({action:'admin_end',session_id:'01-T1'});
  assert.equal((await f.ingest({page:{...f.page,closed:true}})).response.status,200);
  const row=f.env.DB.db.prepare('SELECT * FROM drafts').get();assert.equal(row.state,'unsent');assert.equal(row.text,'Hi');assert.equal(row.message_id,null);
  assert.equal((await f.participant({action:'participant_send',session_id:'01-T1',client_message_id:'new',text:'late'})).response.status,409);
});
test('recording validates complete batches before writing and rejects foreign message references',async()=>{
  const f=await fixture();
  for(const changes of [{recording_version:99},{events:[f.event(4,'input')]},{events:[f.event(1,'not-real')]},{events:[f.event(1,'input',{},'unknown-draft')]},{drafts:[{...f.draft,text:null}]},{events:[f.event(1,'input',{selection_after:[4,2]})]}]){
    assert.equal((await f.ingest(changes)).response.status,400);
  }
  assert.equal(f.env.DB.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n,0);
  const other=await f.create('02');await other.participant({action:'participant_start',session_id:'02-T1'});
  const message=(await other.participant({action:'participant_send',session_id:'02-T1',client_message_id:'m',text:'foreign'})).data.message;
  assert.equal((await f.ingest({events:[f.event(1,'message_display',{message_id:message.id})]})).response.status,403);
  await f.ingest();
  assert.equal((await f.ingest({drafts:[{...f.draft,text:'changed'}]})).response.status,409);
  assert.equal((await f.ingest({page:{...f.page,time_origin_ms:9999}})).response.status,409);
  const mismatched={...f.draft,revision:2,raw_at_send:'Different'};
  assert.equal((await f.participant({action:'participant_send',session_id:'01-T1',client_message_id:mismatched.client_message_id,text:'Hi',logging:{page:f.page,draft:mismatched}})).response.status,400);
});
test('long non-ASCII snapshots fit byte-bounded recording uploads and exports paginate',async()=>{
  const f=await fixture();
  const text='汉'.repeat(10000);
  assert.equal((await f.ingest({drafts:[{...f.draft,text}],events:[f.event(1,'input',{text_before:text,text_after:text},f.draft.draft_id)]})).response.status,200);
  const pages=5;
  for(let batch=0;batch<pages;batch++) {
    const events=Array.from({length:25},(_,i)=>f.event(batch*25+i+2,'selection',{selection_after:[0,0]},f.draft.draft_id));
    assert.equal((await f.ingest({page:{...f.page,declared_seq:126},drafts:[],events})).response.status,200);
  }
  const first=(await f.admin({action:'admin_recording_export',participant_code:'01'})).data;
  assert.equal(first.events.length,100);assert.equal(first.has_more,true);
  const second=(await f.admin({action:'admin_recording_export',participant_code:'01',after_event_row:first.next_cursor})).data;
  assert.equal(second.events.length,26);assert.equal(second.has_more,false);
});
test('migration 003 is repeatable, preserves chat, and v0.3 Worker keeps schema-2 chat available',async()=>{
  const f=await fixture();
  f.env.DB.db.exec("UPDATE schema_meta SET value='2' WHERE name='schema_version'");
  assert.equal((await f.participant({action:'participant_join'})).data.recording_enabled,false);
  assert.equal((await f.ingest()).response.status,503);
  const sent=await f.participant({action:'participant_send',session_id:'01-T1',client_message_id:'legacy',text:'existing'});assert.equal(sent.response.status,200);
  const migration=readFileSync(new URL('../worker/migrations/003-recording.sql',import.meta.url),'utf8');
  f.env.DB.db.exec(migration);f.env.DB.db.exec(migration);
  assert.equal(f.env.DB.db.prepare('SELECT text FROM messages').get().text,'existing');
  assert.equal((await f.ingest()).response.status,200);
  const summary=(await f.admin({action:'admin_session',session_id:'01-T1'})).data.recording;
  assert.equal(summary.messages_without_draft,1);
});
