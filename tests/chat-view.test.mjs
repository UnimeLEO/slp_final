import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
class Element {
 children=[];dataset={};scrollHeight=0;scrollTop=0;clientHeight=100;
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 insertBefore(item,next){const i=this.children.indexOf(next);if(i<0)this.children.push(item);else this.children.splice(i,0,item);}
}
test('send acknowledgement displays immediately without skipping older replies or duplicating polls',()=>{
 const scope={window:{},document:{createElement:()=>new Element()},URL};
 vm.runInNewContext(readFileSync(new URL('../assets/common.js',import.meta.url),'utf8'),scope);
 const element=new Element(),observed=[],view=scope.window.SLP.chatView(element,'participant',{onAppend:row=>observed.push(row.id)});
 const row=(id,sender='participant')=>({id,sender,text:'message '+id,server_received_ms:1000});
 view.append([row(1)]);view.append([row(3)],{advanceCursor:false});
 assert.equal(element.children.length,2);assert.equal(view.cursor,1);
 view.append([row(2,'interlocutor'),row(3)]);
 assert.equal(view.cursor,3);assert.deepEqual(element.children.map(e=>e.dataset.messageId),[1,2,3]);
 assert.deepEqual(observed,[1,3,2]);
 view.append([row(3)]);assert.equal(element.children.length,3);
});
test('questionnaire URL carries the exact Qualtrics embedded-data field and participant code',()=>{
 const scope={window:{},document:{createElement:()=>new Element()},URL};
 vm.runInNewContext(readFileSync(new URL('../assets/common.js',import.meta.url),'utf8'),scope);
 const result=scope.window.SLP.questionnaireUrl('https://q.surveys.unimelb.edu.au/jfe/form/SV_example','Participant Code','01');
 const url=new URL(result);
 assert.equal(url.searchParams.get('Participant Code'),'01');
 assert.equal([...url.searchParams.keys()][0],'Participant Code');
});
test('PLS and Consent are separate steps with one checkbox on each page',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const pls=html.slice(html.indexOf('<section id="pls-page"'),html.indexOf('<section id="consent-page"'));
 const consent=html.slice(html.indexOf('<section id="consent-page"'),html.indexOf('<section id="conversation-page"'));
 assert.match(pls,/name="pls_read" required/);
 assert.equal((pls.match(/type="checkbox"/g)||[]).length,1);
 assert.equal((consent.match(/type="checkbox"/g)||[]).length,1);
 assert.match(consent,/name="final_confirmation" required/);
 const statements=consent.slice(consent.indexOf('<ul class="consent-statements">'),consent.indexOf('</ul>'));
 assert.equal((statements.match(/<li>/g)||[]).length,8);
});
