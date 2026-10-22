'use strict';
(() => {
  const quote=value=>'"'+String(value ?? '').replace(/"/g,'""')+'"';
  const byPage=(data,a,b)=>{
    const pages=new Map((data.recording?.pages || []).map(page=>[page.page_id,page]));
    return (pages.get(a.page_id)?.started_wall_ms || 0)-(pages.get(b.page_id)?.started_wall_ms || 0) || a.page_id.localeCompare(b.page_id) || a.seq-b.seq;
  };
  function integrity(data) {
    const issues=[];
    if(data.recording?.exported_while_active) issues.push({type:'live_export',note:'Data collection was still active. Draft/page summaries and event pages are not a single frozen experiment snapshot.'});
    for(const summary of data.recording?.summaries || []) {
      if(summary.messages_without_draft) issues.push({session_id:summary.session_id,type:'messages_without_draft',count:summary.messages_without_draft});
      for(const page of summary.pages) {
        if(page.missing_events) issues.push({session_id:summary.session_id,page_id:page.page_id,type:'missing_events',count:page.missing_events});
        if(!page.closed) issues.push({session_id:summary.session_id,page_id:page.page_id,type:'page_not_closed',note:'The final event count is unknown; this does not prove that no events were lost.'});
      }
    }
    const messages=new Map(data.messages.map(message=>[message.id,message]));
    for(const draft of data.recording?.drafts || []) if(draft.message_id!=null) {
      const message=messages.get(draft.message_id);
      if(!message || draft.raw_at_send?.trim()!==message.text) issues.push({session_id:draft.session_id,draft_id:draft.draft_id,type:'sent_text_mismatch'});
    }
    const lastText=new Map();
    for(const event of [...(data.recording?.events || [])].sort((a,b)=>byPage(data,a,b))) {
      if(!event.draft_id) continue;
      const key=event.session_id+'|'+event.page_id+'|'+event.draft_id,p=event.payload;
      if(['draft_start','draft_resume'].includes(event.event_type)) lastText.set(key,p.text);
      if(event.event_type==='input') {
        if(lastText.has(key) && lastText.get(key)!==p.text_before) issues.push({session_id:event.session_id,page_id:event.page_id,draft_id:event.draft_id,seq:event.seq,type:'text_chain_gap'});
        lastText.set(key,p.text_after);
      }
      if(event.event_type==='send_attempt' && lastText.has(key) && lastText.get(key)!==p.raw_text) issues.push({session_id:event.session_id,page_id:event.page_id,draft_id:event.draft_id,seq:event.seq,type:'send_snapshot_differs_from_last_input'});
    }
    return {issues,scope:'Uploaded records only. A closed page with a complete declared sequence does not prove that a browser crash lost no final events.',cursor_units:'UTF-16 code units; zero-based; selection end is exclusive.',timing:'Compare client_elapsed_ms only within the same page_id. DOM/viewport observations do not prove that a participant read a message.'};
  }
  function eventsCSV(data) {
    const drafts=new Map((data.recording?.drafts || []).map(draft=>[draft.session_id+'|'+draft.draft_id,draft]));
    const headers=['participant_id','session_id','page_id','seq','draft_id','linked_message_id','event','client_elapsed_ms','client_wall_ms','server_received_ms','received_after_end','input_type','key','data','text_before','text_after','selection_before','selection_after','is_composing','composition_id','payload_json'];
    const rows=[headers];
    for(const event of [...(data.recording?.events || [])].sort((a,b)=>byPage(data,a,b))) {
      const p=event.payload,draft=drafts.get(event.session_id+'|'+event.draft_id);
      rows.push([data.participant_code,event.session_id,event.page_id,event.seq,event.draft_id,draft?.message_id,event.event_type,event.client_elapsed_ms,event.client_wall_ms,event.received_ms,event.received_after_end,p.input_type,p.key,p.data,p.text_before,p.text_after,p.selection_before?JSON.stringify(p.selection_before):'',p.selection_after?JSON.stringify(p.selection_after):'',p.is_composing,p.composition_id,JSON.stringify(p)]);
    }
    return '\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
  }
  function timeline(data) {
    const recording=data.recording || {},result=integrity(data);
    const lines=['SLP participant '+data.participant_code,'Draft production timeline; plain-text event report, not a CA transcription.',result.cursor_units,result.timing,'Integrity issues: '+result.issues.length,...result.issues.map(issue=>JSON.stringify(issue))];
    for(const session of data.sessions) {
      lines.push('','=== '+session.id+' | '+session.condition+' | '+session.status+' ===');
      for(const draft of (recording.drafts || []).filter(d=>d.session_id===session.id)) {
        lines.push('','Draft '+draft.draft_id+' | '+draft.state+' | message '+(draft.message_id ?? 'unsent'),'Latest text: '+JSON.stringify(draft.text));
        if(draft.raw_at_send!=null) lines.push('Raw text at send: '+JSON.stringify(draft.raw_at_send));
        const events=(recording.events || []).filter(event=>event.session_id===session.id && event.draft_id===draft.draft_id).sort((a,b)=>byPage(data,a,b));
        for(const event of events) {
          const p=event.payload;
          let detail=JSON.stringify(p);
          if(event.event_type==='input') detail=JSON.stringify(p.text_before)+' -> '+JSON.stringify(p.text_after)+(p.is_composing?' [composition]':'');
          lines.push('['+event.page_id+' +'+event.client_elapsed_ms.toFixed(2)+' ms #'+event.seq+'] '+event.event_type+' '+detail+(event.received_after_end?' [received after server end]':''));
        }
      }
    }
    return lines.join('\n');
  }

  function taskData(data, sessionId) {
    const session=data.sessions.find(row=>row.id===sessionId);
    if(!session) throw new Error('Task not found in export.');
    const task={...data,sessions:[session],session_id:sessionId};
    for(const key of ['messages','ai_jobs','ai_configs']) task[key]=(data[key] || []).filter(row=>row.session_id===sessionId);
    if(data.recording) {
      task.recording={...data.recording,exported_while_active:session.status==='active'};
      for(const key of ['pages','drafts','summaries','events']) task.recording[key]=(data.recording[key] || []).filter(row=>row.session_id===sessionId);
      task.recording.integrity=integrity(task);
    }
    return task;
  }
  function taskFiles(data) {
    const headers=['session_id','id','sender','text','server_received_ms','client_message_id'];
    const csv='\uFEFF'+[headers,...data.messages.map(row=>headers.map(key=>row[key]))].map(row=>row.map(quote).join(',')).join('\r\n');
    const lines=['SLP '+data.participant_code,'Sent chat messages only.'];
    for(const session of data.sessions) {
      lines.push('','=== '+session.id+' | '+session.condition+' | '+session.status+' ===');
      for(const message of data.messages.filter(row=>row.session_id===session.id)) lines.push(new Date(message.server_received_ms).toISOString()+' '+message.sender+': '+message.text);
    }
    return {'data.json':JSON.stringify(data,null,2),'chat.csv':csv,'chat.txt':lines.join('\n'),'events.csv':eventsCSV(data),'timeline.txt':timeline(data)};
  }
  // Standard ZIP, UTF-8 names, CRC-32 and raw DEFLATE. No CDN dependency or uploads.
  // Older browsers without CompressionStream still get a valid uncompressed ZIP.
  async function zip(files) {
    const encoder=new TextEncoder(), local=[],central=[];let offset=0;
    const header=size=>new Uint8Array(size);
    const crc32=bytes=>{
      let crc=0xffffffff;
      for(const byte of bytes) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
      return (crc^0xffffffff)>>>0;
    };
    const entries=Object.entries(files);
    for(const [name,text] of entries) {
      const nameBytes=encoder.encode(name),raw=encoder.encode(text);let bytes=raw,method=0;
      if(typeof CompressionStream!=='undefined') {
        let stream;try {stream=new CompressionStream('deflate-raw');}catch(_) { /* STORE fallback */ }
        if(stream) {bytes=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(stream)).arrayBuffer());method=8;}
      }
      const crc=crc32(raw),h=header(30),v=new DataView(h.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(8,method,true);v.setUint16(12,33,true);
      v.setUint32(14,crc,true);v.setUint32(18,bytes.length,true);v.setUint32(22,raw.length,true);v.setUint16(26,nameBytes.length,true);
      local.push(h,nameBytes,bytes);
      const c=header(46),w=new DataView(c.buffer);
      w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint16(10,method,true);w.setUint16(14,33,true);
      w.setUint32(16,crc,true);w.setUint32(20,bytes.length,true);w.setUint32(24,raw.length,true);w.setUint16(28,nameBytes.length,true);w.setUint32(42,offset,true);
      central.push(c,nameBytes);offset+=h.length+nameBytes.length+bytes.length;
    }
    const size=central.reduce((sum,part)=>sum+part.length,0),end=header(22),v=new DataView(end.buffer);
    if(entries.length>65535 || offset+size>0xffffffff) throw new Error('ZIP exceeds supported size.');
    v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
    return new Blob([...local,...central,end],{type:'application/zip'});
  }
  window.SLPExport={integrity,eventsCSV,timeline,taskData,taskFiles,zip};
})();
