import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {runImport} from '../extension/lib/native-controller.js';

const script=await readFile(new URL('./browser/runtime.js',import.meta.url),'utf8');
function setup(url){
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url,runScripts:'outside-only'});
  dom.window.structuredClone=structuredClone;
  vm.runInContext(script,dom.getInternalVMContext());
  return dom;
}
test('browser preview remains inert by default and outside loopback',async()=>{
  for(const url of ['http://127.0.0.1:43127/','https://example.org/?scenario=success','http://localhost/?scenario=unknown']){
    const dom=setup(url);
    try{
      assert.equal(dom.window.__localPreview,undefined);
      assert.equal((await dom.window.chrome.runtime.sendMessage({type:'LOAD_ARTICLE'})).ok,false);
      assert.equal(dom.window.chrome.storage,undefined);
    }finally{dom.window.close();}
  }
});
for(const scenario of ['success','warning','error'])test(`browser ${scenario} preview runs the real controller with in-memory media and save`,async()=>{
  const dom=setup(`http://127.0.0.1:43127/?scenario=${scenario}`);
  const previous={chrome:globalThis.chrome,document:globalThis.document,DOMParser:globalThis.DOMParser,fetch:globalThis.fetch};
  globalThis.chrome=dom.window.chrome;globalThis.document=dom.window.document;globalThis.DOMParser=dom.window.DOMParser;globalThis.fetch=dom.window.fetch;
  try{
    const result=await runImport({sourceUrl:'https://mp.weixin.qq.com/s/local-preview'});
    assert.equal(result.verified,scenario!=='error');
    assert.ok(result.info.some(message=>message.includes('上下标已转换')));
    assert.ok(result.warnings.some(message=>message.includes('图注')));
    assert.equal(result.errors.length,scenario==='error'?1:0);
    if(scenario==='warning')assert.ok(result.warnings.some(message=>message.includes('文集')));
    assert.match(result.cover.url,/^https:\/\/i0\.hdslb\.com\//);
    assert.match(result.cover.filename,/-封面\.png$/);
    const downloaded=await chrome.runtime.sendMessage({type:'DOWNLOAD_COVER',...result.cover});
    assert.equal(downloaded.ok,true);
    assert.equal(downloaded.downloadId,1);
    assert.ok(dom.window.__localPreview.messages.some(message=>message.method==='saveDraft'));
    await assert.rejects(dom.window.fetch('https://example.org/'),/禁止外部请求/);
  }finally{
    dom.window.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
