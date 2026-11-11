import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {isTrustedNativeSender} from '../extension/lib/background-handlers.js';

const script=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/,'');
function setup({missingContentScript=false}={}){
  let onAction,onMessage;const calls=[];let messages=0;
  const context=vm.createContext({URL,AbortSignal,createBackgroundHandler:()=>async()=>({ok:true,data:{}}),isTrustedNativeSender,chrome:{
    runtime:{id:'ext',onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener:fn=>{onMessage=fn;}}},
    action:{onClicked:{addListener:fn=>{onAction=fn;}}},
    declarativeNetRequest:{updateDynamicRules:async()=>{}},
    tabs:{
      sendMessage:async(id,message)=>{calls.push({type:'message',id,message});if(missingContentScript&&messages++===0)throw new Error('not loaded');return {ok:true};},
      update:async(id,options)=>{calls.push({type:'update',id,options});},
      create:async options=>{calls.push({type:'create',options});return {id:7};},
    },
    scripting:{executeScript:async options=>{calls.push({type:'inject',options});}},
    storage:{session:{set:async()=>{},get:async()=>({}),remove:async()=>{}}},
  }});
  vm.runInContext(script,context);return {calls,action:tab=>onAction(tab),message:(message,sender)=>new Promise(resolve=>onMessage(message,sender,resolve))};
}

test('clicking the extension in the wrapper opens import without navigation or new tabs',async()=>{
  for(const url of ['https://member.bilibili.com/platform/upload/text/new-edit','https://member.bilibili.com/platform/upload/text/edit?aid=99','https://member.bilibili.com/york/read-editor?aid=99']){
    const app=setup();await app.action({id:42,url});
    assert.equal(app.calls.length,1);assert.equal(app.calls[0].type,'message');
    assert.equal(app.calls[0].id,42);assert.equal(app.calls[0].message.type,'SHOW_IMPORT');
  }
});

test('missing wrapper script is injected in its existing top frame without discarding edits',async()=>{
  const app=setup({missingContentScript:true});await app.action({id:42,url:'https://member.bilibili.com/platform/upload/text/new-edit'});
  assert.deepEqual(app.calls.map(c=>c.type),['message','inject','message']);
  assert.equal(app.calls[1].options.target.tabId,42);
  assert.equal(app.calls[1].options.target.allFrames,undefined);
});

test('an unrelated member route opens a new editor and leaves its page unchanged',async()=>{
  const app=setup();await app.action({id:42,url:'https://member.bilibili.com/platform/home'});
  assert.deepEqual(app.calls.map(c=>c.type),['create']);
  assert.match(app.calls[0].options.url,/^https:\/\/member\.bilibili\.com\/york\/read-editor#wechat-import$/);
});

test('opening a saved draft never replaces an editor that might contain unsaved changes',async()=>{
  const app=setup();const url='https://member.bilibili.com/york/read-editor';
  const result=await app.message({type:'OPEN_SAVED_DRAFT',draftUrl:url+'?aid=123'},{id:'ext',frameId:0,url,tab:{id:42,url}});
  assert.equal(result.ok,true);assert.deepEqual(app.calls.map(c=>c.type),['create']);
});
