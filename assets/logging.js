'use strict';
(() => {
  const DB_NAME = 'slp_participant_recording_v1';
  const MAX_UPLOAD_BYTES = 250000;
  const clone = value => structuredClone(value);
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const uid = () => crypto.randomUUID();

  // Events and their recovery state commit in the SAME IndexedDB transaction.
  // Access codes and researcher credentials are never stored here.
  class IndexedStore {
    constructor(db) { this.db = db; }
    static open() {
      return new Promise((resolve,reject) => {
        const request = indexedDB.open(DB_NAME,1);
        request.onupgradeneeded = () => {
          const db=request.result;
          db.createObjectStore('states',{keyPath:'scope'});
          db.createObjectStore('events',{keyPath:'id'}).createIndex('scope','scope');
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Local recording storage is blocked by another page.'));
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(new IndexedStore(request.result));
        };
      });
    }
    transaction(names,mode,work) {
      return new Promise((resolve,reject) => {
        let result;
        const tx=this.db.transaction(names,mode);
        tx.oncomplete=()=>resolve(result);
        tx.onabort=()=>reject(tx.error || new Error('Local recording transaction failed.'));
        tx.onerror=()=>{}; // onabort reports the transaction, not just one request.
        try { work(tx,value=>{ result=value; }); }
        catch(error) { tx.abort();reject(error); }
      });
    }
    load(scope) {
      return this.transaction(['states','events'],'readonly',(tx,set)=>{
        const output={state:null,events:[]};set(output);
        tx.objectStore('states').get(scope).onsuccess=e=>{ output.state=e.target.result || null; };
        tx.objectStore('events').index('scope').getAll(scope).onsuccess=e=>{ output.events=e.target.result; };
      });
    }
    list(participantKey) {
      return this.transaction(['states'],'readonly',(tx,set)=>{
        tx.objectStore('states').getAll().onsuccess=e=>set(e.target.result.filter(state=>state.participantKey===participantKey));
      });
    }
    put(state,events) {
      return this.transaction(['states','events'],'readwrite',tx=>{
        tx.objectStore('states').put(state);
        for(const event of events) tx.objectStore('events').put(event);
      });
    }
    acknowledge(ids) {
      return this.transaction(['events'],'readwrite',tx=>{ for(const id of ids) tx.objectStore('events').delete(id); });
    }
  }

  class Recorder {
    constructor(options) {
      Object.assign(this,options);
      this.now=options.now || (()=>performance.now());
      this.wall=options.wall || (()=>Date.now());
      this.doc=options.doc || document;
      this.win=options.win || window;
      this.onStatus=options.onStatus || (()=>{});
      this.onFatal=options.onFatal || (()=>{});
      this.queue=[]; this.listeners=[]; this.writes=Promise.resolve(); this.failure=null;
      this.flushFlight=null; this.closed=false; this.composing=false; this.compositionId=null;
      this.before=null; this.lastText=''; this.lastSelection=null; this.displayed=new Map();
      this.scope=this.base+'|'+this.sessionId;
      this.participantKey=this.base+'|'+this.participantId;
    }
    get current() { return this.state?.drafts[this.state.currentDraftId] || null; }
    get pending() { return this.state?.pending || null; }
    get canEdit() { return !this.closed && !this.failure && !this.pending; }
    async initialize() {
      const saved=await this.store.load(this.scope);
      this.state=saved.state || {scope:this.scope,participantKey:this.participantKey,sessionId:this.sessionId,pages:{},drafts:{},currentDraftId:null,pending:null};
      this.queue=saved.events.map(event=>({...event,persisted:true}));
      this.queue.sort((a,b)=>(this.state.pages[a.page_id].started_wall_ms-this.state.pages[b.page_id].started_wall_ms)||a.page_id.localeCompare(b.page_id)||a.seq-b.seq);
      this.pageId=uid(); this.startMono=this.now();
      this.state.pages[this.pageId]={page_id:this.pageId,time_origin_ms:this.timeOrigin ?? performance.timeOrigin,started_wall_ms:this.wall(),declared_seq:0,closed:false};
      this.state.currentPageId=this.pageId;
      this.emit(saved.state?'page_resume':'page_start',{recorder_version:1,recovered_event_count:this.queue.length},null);
      if (this.current && this.current.state!=='sent') {
        this.textarea.value=this.current.text;
        this.lastText=this.current.text;
        this.emit('draft_resume',{text:this.current.text,pending_send:!!this.pending});
      } else this.newDraft();
      this.bind();
      await this.persist();
      // Keystrokes stay in IndexedDB while the task is active. Uploading every
      // second created a large number of small D1 transactions without adding
      // useful experimental information. stop() and recovery upload the durable
      // outbox in a few byte-bounded batches.
      return this;
    }
    save(event) {
      const state=clone(this.state), record=clone(event);
      delete record.persisted;
      this.writes=this.writes.then(async()=>{
        if (this.failure) return;
        try { await this.store.put(state,[record]); event.persisted=true; }
        catch(error) {
          this.failure=error;
          this.onStatus('Typing data could not be saved on this device. Save a local backup and contact the researcher.',true);
          this.onFatal(error);
        }
      });
    }
    emit(eventType,payload={},draftId=this.current?.draft_id ?? null) {
      const page=this.state.pages[this.pageId];
      const seq=++page.declared_seq;
      if (draftId) {
        const draft=this.state.drafts[draftId];
        draft.revision++;draft.last_page_id=this.pageId;draft.last_seq=seq;
      }
      const event={id:this.scope+'|'+this.pageId+'|'+seq,scope:this.scope,page_id:this.pageId,seq,draft_id:draftId,event_type:eventType,
        client_elapsed_ms:Math.max(0,this.now()-this.startMono),client_wall_ms:this.wall(),payload:clone(payload),persisted:false};
      this.queue.push(event);this.save(event);
      return event;
    }
    newDraft() {
      const draftId=uid();
      this.state.currentDraftId=draftId;
      this.state.drafts[draftId]={draft_id:draftId,client_message_id:uid(),revision:0,text:'',state:'editing',raw_at_send:null,last_page_id:this.pageId,last_seq:0};
      this.lastText='';this.before=null;this.lastSelection=null;
      this.emit('draft_start',{text:''});
    }
    selection() { return [this.textarea.selectionStart || 0,this.textarea.selectionEnd || 0]; }
    listen(target,event,callback) {
      target.addEventListener(event,callback);this.listeners.push(()=>target.removeEventListener(event,callback));
    }
    bind() {
      const allowed=()=>!this.closed && !this.failure;
      const editable=()=>allowed() && !this.pending && !this.textarea.disabled && !this.textarea.readOnly;
      const selection=()=>{
        if (!allowed() || this.doc.activeElement!==this.textarea) return;
        const range=this.selection(), signature=range.join(':')+':'+this.textarea.selectionDirection;
        if (signature===this.lastSelection) return;
        this.lastSelection=signature;
        this.emit('selection',{selection_after:range,direction:this.textarea.selectionDirection || 'none'});
      };
      this.listen(this.textarea,'keydown',event=>{
        if (editable()) this.emit('keydown',{key:event.key,code:event.code,repeat:!!event.repeat,ctrl:!!event.ctrlKey,alt:!!event.altKey,shift:!!event.shiftKey,meta:!!event.metaKey,is_composing:!!event.isComposing || this.composing});
      });
      this.listen(this.textarea,'beforeinput',event=>{
        if (!editable()) return;
        this.before={text:this.textarea.value,selection:this.selection()};
        this.emit('beforeinput',{input_type:event.inputType || '',data:event.data ?? null,text_before:this.before.text,selection_before:this.before.selection,is_composing:!!event.isComposing || this.composing,composition_id:this.compositionId,is_trusted:!!event.isTrusted});
      });
      this.listen(this.textarea,'input',event=>{
        if (!editable()) return;
        const previous=this.before || {text:this.lastText,selection:null};
        this.current.text=this.textarea.value;this.current.state='editing';
        this.emit('input',{input_type:event.inputType || '',data:event.data ?? null,text_before:previous.text,text_after:this.textarea.value,
          ...(previous.selection?{selection_before:previous.selection}:{}),selection_after:this.selection(),
          beforeinput_observed:!!this.before,is_composing:!!event.isComposing || this.composing,composition_id:this.compositionId,is_trusted:!!event.isTrusted});
        this.lastText=this.textarea.value;this.before=null;
      });
      for(const type of ['compositionstart','compositionupdate','compositionend']) this.listen(this.textarea,type,event=>{
        if (!editable()) return;
        if (type==='compositionstart') { this.composing=true;this.compositionId=uid(); }
        const id=this.compositionId;
        // Snapshot the DOM too: browsers can differ in their final input ordering.
        if (this.textarea.value!==this.lastText) {
          this.current.text=this.textarea.value;
          this.emit('input',{input_type:'composition_snapshot',text_before:this.lastText,text_after:this.textarea.value,selection_after:this.selection(),is_composing:true,composition_id:id,source:'composition_fallback'});
          this.lastText=this.textarea.value;this.before=null;
        }
        this.emit(type,{data:event.data ?? null,composition_id:id,text:this.textarea.value});
        if (type==='compositionend') { this.composing=false;this.compositionId=null;this.compositionEndedAt=this.now(); }
      });
      this.listen(this.textarea,'focus',()=>{ if (allowed()) this.emit('focus',{selection_after:this.selection()}); });
      this.listen(this.textarea,'blur',()=>{ if (allowed()) this.emit('blur',{selection_after:this.selection()}); });
      this.listen(this.textarea,'selectionchange',selection);
      this.listen(this.textarea,'select',selection);
      this.listen(this.doc,'selectionchange',selection);
      this.listen(this.doc,'visibilitychange',()=>{
        if (!allowed()) return;
        this.emit('visibility',{state:this.doc.visibilityState});
        if (!this.doc.hidden) this.refreshVisible('page_became_visible');
      });
      for(const type of ['focus','blur']) this.listen(this.win,type,()=>{ if (allowed()) this.emit('page_'+type,{}); });
      if (this.messageContainer) this.listen(this.messageContainer,'scroll',()=>this.refreshVisible('chat_scroll'));
      this.listen(this.win,'resize',()=>this.refreshVisible('viewport_resize'));
      this.listen(this.win,'scroll',()=>this.refreshVisible('page_scroll'));
      this.listen(this.win,'pagehide',event=>{
        if (allowed()) this.emit('pagehide',{persisted:!!event.persisted});
      });
      this.listen(this.win,'pageshow',event=>{
        if (allowed() && event.persisted) this.emit('resume_gap',{reason:'back_forward_cache'});
      });
    }
    isVisible(element) {
      if (this.doc.hidden) return false;
      if (!element || !this.messageContainer) return false;
      const item=element.getBoundingClientRect(),box=this.messageContainer.getBoundingClientRect();
      return item.bottom>Math.max(box.top,0) && item.top<Math.min(box.bottom,this.win.innerHeight) && item.right>Math.max(box.left,0) && item.left<Math.min(box.right,this.win.innerWidth);
    }
    refreshVisible(observation) {
      if (this.closed || this.failure) return;
      for (const [id,item] of this.displayed) if (!item.seen && this.isVisible(item.element)) {
        item.seen=true;this.emit('message_visible',{message_id:id,visible:true,observation});
      }
    }
    observeMessage(row,element,{initialSync=false}={}) {
      if (this.closed || this.failure || this.displayed.has(row.id)) return;
      const visible=this.isVisible(element);
      this.displayed.set(row.id,{element,seen:visible});
      this.emit('message_display',{message_id:row.id,sender:row.sender,visible,initial_sync:initialSync,observation:'dom_append',visibility_state:this.doc.visibilityState});
    }
    async persist() { await this.writes;if(this.failure) throw this.failure; }
    prepareSend() {
      if (this.closed || this.failure) throw new Error('Typing recording is not ready.');
      if (this.composing) throw new Error('Finish the current input-method composition before sending.');
      if (!this.pending) {
        const raw=this.textarea.value;if (!raw.trim()) return null;
        this.current.text=raw;this.current.raw_at_send=raw;this.current.state='pending';
        this.state.pending={text:raw.trim(),client_message_id:this.current.client_message_id,draft_id:this.current.draft_id};
      }
      this.emit('send_attempt',{raw_text:this.current.raw_at_send,text:this.pending.text});
      return {...this.pending,client_elapsed_ms:Math.max(0,this.now()-this.startMono),logging:{page:clone(this.state.pages[this.pageId]),draft:clone(this.current)}};
    }
    async acknowledge(message) {
      const draft=this.current;
      draft.state='sent';this.state.pending=null;
      this.emit('send_ack',{message_id:message.id});
      if (this.closed) { await this.persist();await this.flushAll();return; }
      this.emit('programmatic_clear',{text_before:draft.raw_at_send,text_after:'',reason:'send_ack'});
      this.textarea.value='';this.newDraft();
      await this.persist();
    }
    sendFailed(error) { this.emit('send_failed',{status:error.status || null,message:String(error.message || error).slice(0,300)}); }
    makeBatch() {
      const first=this.queue.find(event=>event.persisted);if(!first) return null;
      const candidates=this.queue.filter(event=>event.persisted && event.page_id===first.page_id).slice(0,500);
      const selected=[];
      let body;
      for (const event of candidates) {
        const proposed=[...selected,event];
        const ids=[...new Set(proposed.map(e=>e.draft_id).filter(Boolean))];
        const proposedBody={action:'participant_events',recording_version:1,session_id:this.sessionId,page:clone(this.state.pages[first.page_id]),
          // The send request/send_attempt event carries the raw send snapshot.
          // Avoid duplicating it in every input batch (important for long pastes).
          drafts:ids.map(id=>({...clone(this.state.drafts[id]),raw_at_send:null})),events:proposed.map(({id,scope,page_id,persisted,...value})=>value)};
        if (bytes(proposedBody)>MAX_UPLOAD_BYTES) { if(!selected.length) throw new Error('A recording entry exceeds the upload size limit. Save a local backup.'); break; }
        selected.push(event);body=proposedBody;
      }
      return {body,selected};
    }
    async flush() {
      if (this.flushFlight) return this.flushFlight;
      this.flushFlight=(async()=>{
        await this.persist();
        const batch=this.makeBatch();if (!batch) return;
        const response=await this.call(batch.body);
        if (response.page_id!==batch.body.page.page_id || JSON.stringify(response.accepted_sequences)!==JSON.stringify(batch.body.events.map(e=>e.seq))) throw new Error('The server did not acknowledge the complete recording batch.');
        const ids=new Set(batch.selected.map(event=>event.id));
        await this.store.acknowledge([...ids]);
        this.queue=this.queue.filter(event=>!ids.has(event.id));
        this.onStatus('',false);
      })();
      try { return await this.flushFlight; }
      catch(error) { this.onStatus('Typing data is waiting to be saved. Keep this page open, or save a local backup.',true);throw error; }
      finally { this.flushFlight=null; }
    }
    async flushAll() {
      await this.persist();
      while(this.queue.length) { await this.flush();await this.persist(); }
    }
    async stop(reason) {
      if (!this.closed) {
        this.detach();this.closed=true;this.composing=false;
        if (this.current?.state!=='sent') {
          this.current.text=this.textarea.value;this.current.state='unsent';
          this.emit('draft_unsent',{text:this.current.text,reason});
        }
        this.state.pending=null;
        this.state.pages[this.pageId].closed=true;
        this.emit('page_end',{reason});
      }
      await this.flushAll();
    }
    backup() {
      return {format:'slp-local-recording-backup',recording_version:1,exported_ms:this.wall(),state:clone(this.state),events:this.queue.map(({persisted,...event})=>clone(event))};
    }
    detach() {
      for(const remove of this.listeners.splice(0)) remove();
    }
    dispose() { this.detach();this.releaseLock?.(); }
  }
  async function acquireLock(scope) {
    if (!navigator.locks) return ()=>{};
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    await new Promise((resolve,reject)=>{
      navigator.locks.request('slp-recording:'+scope,{ifAvailable:true},async lock=>{
        if(!lock) { reject(new Error('This conversation is open in another tab. Close that tab before continuing.'));return; }
        resolve();await held;
      }).catch(reject);
    });
    return release;
  }
  async function create(options) {
    const release=await acquireLock(options.base+'|'+options.sessionId);
    let recorder;
    try {
      recorder=new Recorder({...options,store:options.store || await IndexedStore.open()});
      recorder.releaseLock=release;
      return await recorder.initialize();
    } catch(error) {recorder?.detach();release();throw error;}
  }
  async function recover(options) {
    const store=options.store || await IndexedStore.open();
    const states=await store.list(options.base+'|'+options.participantId);
    for(const state of states) {
      if(state.sessionId===options.excludeSession) continue;
      const release=await acquireLock(state.scope);
      try {
        const saved=await store.load(state.scope);
        if(!saved.events.length) continue;
        const recorder=new Recorder({...options,sessionId:state.sessionId,store});
        recorder.state=saved.state;recorder.pageId=state.currentPageId;
        recorder.queue=saved.events.map(event=>({...event,persisted:true}));
        recorder.queue.sort((a,b)=>a.page_id.localeCompare(b.page_id)||a.seq-b.seq);
        await recorder.flushAll();
      } finally { release(); }
    }
  }
  window.SLPLogging={create,recover,Recorder,IndexedStore};
})();
