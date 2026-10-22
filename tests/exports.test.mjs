import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const window={};vm.runInNewContext(readFileSync(new URL('../assets/exports.js',import.meta.url),'utf8'),{window});
const {eventsCSV,timeline,integrity}=window.SLPExport;
function fixture(){return {
  participant_code:'01',sessions:[{id:'01-T1',condition:'human',status:'ended'}],messages:[{id:7,text:'Would you swap?'}],
  recording:{enabled:true,exported_while_active:false,pages:[{page_id:'p1',started_wall_ms:1000}],drafts:[{session_id:'01-T1',draft_id:'d1',message_id:7,state:'sent',text:'Would you swap?',raw_at_send:' Would you swap? '}],
    summaries:[{session_id:'01-T1',messages_without_draft:0,pages:[{page_id:'p1',closed:1,missing_events:0}]}],
    events:[{session_id:'01-T1',page_id:'p1',seq:1,draft_id:'d1',event_type:'draft_start',client_elapsed_ms:0,payload:{text:''}},
      {session_id:'01-T1',page_id:'p1',seq:2,draft_id:'d1',event_type:'input',client_elapsed_ms:10,payload:{text_before:'',text_after:'Could you swap?',input_type:'insertText'}},
      {session_id:'01-T1',page_id:'p1',seq:3,draft_id:'d1',event_type:'input',client_elapsed_ms:20,payload:{text_before:'Could you swap?',text_after:'Would you swap?',selection_before:[0,5],selection_after:[5,5],input_type:'insertText'}}]}
};}

test('event CSV and draft timeline retain deleted text, selections and the message link',()=>{
 const data=fixture();const csv=eventsCSV(data),txt=timeline(data);
 assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.includes('"linked_message_id"'));assert.ok(csv.includes('"7"'));
 assert.ok(csv.includes('Could you swap?'));assert.ok(csv.includes('[0,5]'));
 assert.ok(txt.includes('Could you swap?'));assert.ok(txt.includes('message 7'));assert.ok(txt.includes('Raw text at send: " Would you swap? "'));
 assert.equal(integrity(data).issues.length,0);
 data.recording.events[1].payload.text_after='a "quote"\nand a new line';assert.ok(eventsCSV(data).includes('a ""quote""\nand a new line'));
});
test('integrity distinguishes missing events, abrupt closure, changed text and live export',()=>{
 const data=fixture();data.recording.summaries[0].pages[0].closed=0;data.recording.summaries[0].pages[0].missing_events=2;
 data.recording.summaries[0].messages_without_draft=1;data.recording.exported_while_active=true;
 data.recording.drafts[0].raw_at_send='a different message';data.recording.events[2].payload.text_before='unobserved change';
 const types=new Set(integrity(data).issues.map(issue=>issue.type));
 for(const type of ['live_export','page_not_closed','missing_events','messages_without_draft','sent_text_mismatch','text_chain_gap'])assert.equal(types.has(type),true);
});
