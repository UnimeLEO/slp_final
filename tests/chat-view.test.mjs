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
 const scope={window:{},document:{createElement:()=>new Element()}};
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
