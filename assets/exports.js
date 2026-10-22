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
  window.SLPExport={integrity,eventsCSV,timeline};
})();
