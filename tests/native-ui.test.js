import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const script = await fs.readFile(new URL('../extension/native-ui.js', import.meta.url), 'utf8');
const importExpression = "import(chrome.runtime.getURL('lib/native-controller.js'))";
assert.equal(script.split(importExpression).length, 2, 'Only the module load is replaced by the test harness.');
const testScript = script.replace(importExpression, '__loadController()');
const WX = 'https://mp.weixin.qq.com/s/example';
const DRAFT = 'https://member.bilibili.com/york/read-editor?aid=123';
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ url = 'https://member.bilibili.com/york/read-editor', runImport, sendMessage, loadController, resetPendingImport } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><input id="nativeTitle" value="用户正在编辑的原生草稿"><div id="nativeBody" contenteditable="true">原生正文</div></body></html>', { url, runScripts: 'outside-only' });
  const { window } = dom;
  let shadow;
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    shadow = attachShadow.call(this, options);
    return shadow;
  };
  const listeners = [], calls = [], messages = [], resets = [];
  let loads = 0;
  window.chrome = { runtime: {
    id: 'test-extension',
    getURL: file => `chrome-extension://test-extension/${file}`,
    onMessage: { addListener: fn => listeners.push(fn) },
    sendMessage: async message => { messages.push(message); return sendMessage ? sendMessage(message) : { ok: true }; },
  } };
  window.__loadController = async () => {
    loads++;
    if (loadController) return loadController();
    return {
      runImport: async (payload, progress) => {
        calls.push(payload);
        if (runImport) return runImport(payload, progress);
        progress('正在保存草稿…');
        return { draftId: '123', draftUrl: DRAFT, warnings: [] };
      },
      resetPendingImport: async payload => {
        resets.push(payload);
        if (resetPendingImport) return resetPendingImport(payload);
      },
    };
  };
  vm.runInContext(testScript, dom.getInternalVMContext());
  const $ = selector => shadow?.querySelector(selector);
  const enterUrl = (value = WX) => { $('.url').value = value; $('.url').dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = () => $('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const setFiles = (selector, files) => {
    Object.defineProperty($(selector), 'files', { value: files, configurable: true });
    $(selector).dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { dom, window, $, shadow, calls, messages, resets, listeners, enterUrl, submit, setFiles, loads: () => loads, reload: () => vm.runInContext(testScript, dom.getInternalVMContext()), close: () => dom.window.close() };
}

test('adds only one entry button and a closed-shadow dialog without touching the native editor', () => {
  const ui = setup();
  try {
    assert.equal(ui.$('.launch').textContent, '导入公众号');
    assert.equal(ui.$('.overlay').hidden, true);
    assert.equal(ui.$('.more').open, false);
    assert.equal(ui.$('.new-draft').hidden, true);
    assert.equal(ui.dom.window.document.getElementById('wechat-bilibili-native-import').shadowRoot, null);
    assert.equal(ui.dom.window.document.querySelectorAll('#wechat-bilibili-native-import').length, 1);
    ui.reload();
    assert.equal(ui.dom.window.document.querySelectorAll('#wechat-bilibili-native-import').length, 1);
    assert.equal(ui.listeners.length, 1);
    assert.equal(ui.loads(), 0);
    assert.equal(ui.dom.window.document.getElementById('nativeTitle').value, '用户正在编辑的原生草稿');
    ui.$('.launch').click();
    assert.equal(ui.$('.overlay').hidden, false);
    assert.equal(ui.$('.primary').textContent, '导入为新草稿');
    assert.equal(ui.$('.url').placeholder, '粘贴公众号文章链接');
  } finally { ui.close(); }
});

test('does not install UI on unrelated pages', () => {
  const ui = setup({ url: 'https://member.bilibili.com/platform/home' });
  try {
    assert.equal(ui.dom.window.document.getElementById('wechat-bilibili-native-import'), null);
    assert.equal(ui.listeners.length, 0);
  } finally { ui.close(); }
});

test('mounts in top-level wrapper editor without touching its native content', () => {
  for(const path of ['/platform/upload/text/new-edit','/platform/upload/text/edit?aid=456']){
    const ui=setup({url:'https://member.bilibili.com'+path});
    try{
      assert.equal(ui.$('.launch').textContent,'导入公众号');
      ui.$('.launch').click();
      assert.equal(ui.$('.overlay').hidden,false);
      assert.equal(ui.window.location.pathname,path.split('?')[0]);
      assert.equal(ui.window.document.getElementById('nativeTitle').value,'用户正在编辑的原生草稿');
    }finally{ui.close();}
  }
});

test('SPA editor entry mounts once and leaving hides controls without losing state', async () => {
  const ui=setup({url:'https://member.bilibili.com/platform/home'});
  try{
    assert.equal(ui.$('.launch'),undefined);
    ui.window.history.pushState({},'', '/platform/upload/text/new-edit');
    ui.window.document.body.append(ui.window.document.createElement('section'));
    await tick();
    assert.equal(ui.$('.launch').textContent,'导入公众号');
    ui.$('.launch').click();ui.enterUrl();
    const host=ui.window.document.getElementById('wechat-bilibili-native-import');
    assert.equal(host.style.display,'block');
    ui.window.history.pushState({},'', '/platform/home');
    ui.window.dispatchEvent(new ui.window.PopStateEvent('popstate'));
    assert.equal(host.style.display,'none');
    assert.equal(ui.$('.overlay').hidden,true);
    ui.submit();await tick();assert.equal(ui.calls.length,0);
    ui.window.history.pushState({},'', '/platform/upload/text/edit?aid=12');
    ui.window.document.body.append(ui.window.document.createElement('section'));
    await tick();
    assert.equal(host.style.display,'block');
    assert.equal(ui.$('.url').value,WX);
    assert.equal(ui.window.document.querySelectorAll('#wechat-bilibili-native-import').length,1);
    ui.reload();assert.equal(ui.listeners.length,1);
  }finally{ui.close();}
});

test('requires an explicit submit and validates source URLs before loading privileged code', async () => {
  const ui = setup();
  try {
    ui.$('.launch').click();
    for (const url of ['', 'javascript:alert(1)', 'https://mp.weixin.qq.com.evil.test/s/x', 'https://mp.weixin.qq.com/cgi-bin/login']) {
      ui.enterUrl(url); ui.submit(); await tick();
      assert.equal(ui.loads(), 0);
      assert.ok(ui.$('.status').classList.contains('error'));
    }
    ui.enterUrl();
    assert.equal(ui.calls.length, 0);
    ui.submit(); await tick();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].sourceUrl, WX);
    assert.equal(ui.calls[0].html, undefined);
    assert.equal(ui.calls[0].localFiles.length, 0);
    assert.equal(ui.messages[0].type, 'OPEN_SAVED_DRAFT');
    assert.equal(ui.messages[0].draftUrl, DRAFT);
    assert.equal(ui.$('.open').hidden, false);
    assert.equal(ui.$('.primary').disabled, true);
    ui.submit(); await tick();
    assert.equal(ui.calls.length, 1, 'success cannot be resubmitted accidentally');
    assert.equal(ui.dom.window.document.getElementById('nativeTitle').value, '用户正在编辑的原生草稿');
  } finally { ui.close(); }
});

test('closing and reopening during import preserves the single running job and status', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = setup({ runImport: async (_payload, progress) => {
    progress('正在上传第 2 张图片…');
    await pending;
    return { draftId: '123', draftUrl: DRAFT, warnings: [] };
  } });
  try {
    ui.$('.launch').click(); ui.enterUrl(); ui.submit(); await tick();
    assert.equal(ui.$('.primary').disabled, true);
    assert.equal(ui.$('.url').disabled, true);
    assert.equal(ui.$('.status').textContent, '正在上传第 2 张图片…');
    ui.$('.close').click();
    assert.equal(ui.$('.overlay').hidden, true);
    ui.$('.launch').click();
    ui.submit(); await tick();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.$('.status').textContent, '正在上传第 2 张图片…');
    finish(); await tick();
    assert.equal(ui.messages.length, 1);
    assert.equal(ui.$('.status').textContent, '草稿已保存');
    assert.equal(ui.$('.url').disabled, false);
    ui.$('.open').click(); await tick();
    assert.equal(ui.messages.length, 2);
  } finally { finish(); ui.close(); }
});

test('passes saved HTML and original File objects directly to the controller without runtime serialization', async () => {
  const ui = setup();
  try {
    const html = new ui.window.File(['<article>本地正文</article>'], 'saved.html', { type: 'text/html' });
    html.text = async () => '<article>本地正文</article>';
    const resource = new ui.window.File(['image bytes'], 'a.png', { type: 'image/png' });
    Object.defineProperty(resource, 'webkitRelativePath', { value: 'saved_files/a.png' });
    ui.$('.launch').click();
    ui.setFiles('.html-file', [html]);
    ui.setFiles('.resource-files', [resource]);
    ui.submit(); await tick();
    assert.equal(ui.calls[0].html, '<article>本地正文</article>');
    assert.equal(ui.calls[0].localFiles[0], resource);
    assert.equal(ui.$('.html-name').textContent, 'saved.html');
    assert.equal(ui.$('.resource-name').textContent, 'saved_files');
    assert.equal(ui.messages.length, 1);
    assert.deepEqual(Object.keys(ui.messages[0]).sort(), ['draftUrl', 'type']);
  } finally { ui.close(); }
});

test('opens only for extension runtime messages or explicit import hash and never accepts page messages', async () => {
  const ui = setup();
  try {
    ui.window.dispatchEvent(new ui.window.MessageEvent('message', { data: { type: 'SHOW_IMPORT', sourceUrl: WX } }));
    assert.equal(ui.$('.overlay').hidden, true);
    ui.listeners[0]({ type: 'SHOW_IMPORT', sourceUrl: WX }, { id: 'other-extension' });
    assert.equal(ui.$('.overlay').hidden, true);
    let acknowledged = false;
    ui.listeners[0]({ type: 'SHOW_IMPORT', sourceUrl: WX }, { id: 'test-extension' }, () => { acknowledged = true; });
    assert.equal(acknowledged, true);
    assert.equal(ui.$('.overlay').hidden, false);
    assert.equal(ui.$('.url').value, WX);
    assert.equal(ui.calls.length, 0);
    ui.$('.close').click();
    ui.window.location.hash = `wechat-import?source=${encodeURIComponent(WX)}`;
    ui.window.dispatchEvent(new ui.window.HashChangeEvent('hashchange'));
    assert.equal(ui.$('.overlay').hidden, false);
    assert.equal(ui.$('.url').value, WX);
    assert.equal(ui.calls.length, 0);
  } finally { ui.close(); }
});

test('initial hash prefills import without starting a job', () => {
  const ui = setup({ url: `https://member.bilibili.com/york/read-editor#wechat-import?source=${encodeURIComponent(WX)}` });
  try {
    assert.equal(ui.$('.overlay').hidden, false);
    assert.equal(ui.$('.url').value, WX);
    assert.equal(ui.loads(), 0);
  } finally { ui.close(); }
});

test('errors leave the native editor untouched and allow retry; confirmed saved draft prevents duplicates', async () => {
  const ui = setup({ runImport: async () => { throw new Error('图片上传失败'); } });
  try {
    ui.enterUrl(); ui.submit(); await tick();
    assert.equal(ui.$('.status').textContent, '图片上传失败');
    assert.equal(ui.$('.primary').disabled, false);
    assert.equal(ui.$('.recover').hidden, true);
    assert.equal(ui.messages.length, 0);
    ui.submit(); await tick();
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.dom.window.document.getElementById('nativeBody').textContent, '原生正文');
  } finally { ui.close(); }
  const saved = setup({ runImport: async () => { const error = new Error('草稿已保存，读回检查失败'); error.draftUrl = DRAFT; throw error; } });
  try {
    saved.enterUrl(); saved.submit(); await tick();
    assert.equal(saved.$('.primary').disabled, true);
    assert.equal(saved.$('.open').hidden, false);
    saved.submit(); await tick();
    assert.equal(saved.calls.length, 1);
  } finally { saved.close(); }
});

test('renders server warnings as text and keeps them collapsed', async () => {
  const ui = setup({ runImport: async () => ({ draftId: '123', draftUrl: DRAFT, warnings: ['<img src=x onerror=bad()>', '局部转成图片', '局部转成图片'] }) });
  try {
    ui.enterUrl(); ui.submit(); await tick();
    assert.equal(ui.$('.warnings').hidden, false);
    assert.equal(ui.$('.warnings').open, false);
    assert.equal(ui.$('.warnings').querySelectorAll('li').length, 2);
    assert.equal(ui.$('.warnings').querySelector('img'), null);
    assert.match(ui.$('.warnings').textContent, /<img src=x onerror=bad\(\)>/);
  } finally { ui.close(); }
});

test('refuses unsafe draft destinations and reports background opening failures without losing the saved link', async () => {
  const unsafe = setup({ runImport: async () => ({ draftUrl: 'https://evil.test/collect', warnings: [] }) });
  try {
    unsafe.enterUrl(); unsafe.submit(); await tick();
    assert.equal(unsafe.messages.length, 0);
    assert.equal(unsafe.$('.open').hidden, true);
    assert.ok(unsafe.$('.status').classList.contains('error'));
  } finally { unsafe.close(); }
  const failedOpen = setup({ sendMessage: async () => ({ error: { message: '无法创建标签页' } }) });
  try {
    failedOpen.enterUrl(); failedOpen.submit(); await tick();
    assert.equal(failedOpen.$('.open').hidden, false);
    assert.equal(failedOpen.$('.primary').disabled, true);
    assert.match(failedOpen.$('.status').textContent, /草稿已保存.*无法创建标签页/);
  } finally { failedOpen.close(); }
});

test('unverified saved drafts remain available for inspection without automatic navigation', async () => {
  const ui = setup({ runImport: async () => ({ draftId: '123', draftUrl: DRAFT, verified: false, warnings: ['读回检查失败'] }) });
  try {
    ui.enterUrl(); ui.submit(); await tick();
    assert.equal(ui.$('.status').textContent, '草稿已保存，需要检查');
    assert.equal(ui.$('.new-draft').hidden, true);
    assert.equal(ui.messages.length, 0);
    assert.equal(ui.$('.open').hidden, false);
    assert.equal(ui.$('.primary').disabled, true);
    ui.$('.open').click(); await tick();
    assert.equal(ui.messages.length, 1);
    assert.equal(ui.messages[0].draftUrl, DRAFT);
  } finally { ui.close(); }
});

test('switching between URL and local HTML clears previous source and resource selections', () => {
  const ui = setup();
  try {
    const html = new ui.window.File(['a'], 'a.html', { type: 'text/html' });
    const resource = new ui.window.File(['b'], 'b.png', { type: 'image/png' });
    Object.defineProperty(resource, 'webkitRelativePath', { value: 'old_files/b.png' });
    ui.enterUrl();
    ui.setFiles('.resource-files', [resource]);
    assert.equal(ui.$('.resource-name').textContent, 'old_files');
    ui.setFiles('.html-file', [html]);
    assert.equal(ui.$('.url').value, '');
    assert.equal(ui.$('.resource-name').textContent, '');
    ui.setFiles('.resource-files', [resource]);
    ui.enterUrl();
    assert.equal(ui.$('.html-name').textContent, '');
    assert.equal(ui.$('.resource-name').textContent, '');
  } finally { ui.close(); }
});

test('unverified recovery preserves the draft and requires an explicit click to create a new job', async () => {
  let attempt=0,releaseReset;
  const resetGate=new Promise(resolve=>{releaseReset=resolve;});
  const freshDraft='https://member.bilibili.com/york/read-editor?aid=456';
  const ui=setup({
    runImport:async()=>++attempt===1
      ?{draftId:'123',draftUrl:DRAFT,recovered:true,verified:false,warnings:['已有草稿已保留，未覆盖其中的修改。']}
      :{draftId:'456',draftUrl:freshDraft,verified:true,warnings:[]},
    resetPendingImport:async()=>resetGate,
  });
  try{
    ui.$('.launch').click();ui.enterUrl();ui.submit();await tick();
    assert.equal(ui.$('.status').textContent,'已有草稿已保留，需要检查');
    assert.equal(ui.$('.new-draft').hidden,false);assert.equal(ui.$('.new-draft').textContent,'另建新草稿');
    assert.equal(ui.$('.recover').hidden,true);assert.equal(ui.$('.primary').disabled,true);
    assert.equal(ui.messages.length,0);assert.equal(ui.resets.length,0);
    ui.submit();ui.$('.close').click();ui.$('.launch').click();await tick();
    assert.equal(ui.calls.length,1);assert.equal(ui.resets.length,0);
    ui.$('.open').click();await tick();assert.equal(ui.messages[0].draftUrl,DRAFT);
    ui.$('.new-draft').click();await tick();
    assert.equal(ui.$('.new-draft').disabled,true);
    ui.$('.new-draft').dispatchEvent(new ui.window.Event('click'));
    assert.equal(ui.resets.length,1);assert.equal(ui.calls.length,1);
    assert.equal(ui.resets[0].sourceUrl,WX);
    releaseReset();await tick();
    assert.equal(ui.calls.length,2);assert.equal(ui.calls[1].draftId,undefined);
    assert.equal(ui.$('.new-draft').hidden,true);
    assert.equal(ui.messages[1].draftUrl,freshDraft);
  }finally{releaseReset();ui.close();}
});

test('failed new-job reset leaves the recovered draft available without submitting another import', async () => {
  const ui=setup({
    runImport:async()=>({draftId:'123',draftUrl:DRAFT,recovered:true,verified:false,warnings:[]}),
    resetPendingImport:async()=>{throw new Error('无法准备新草稿');},
  });
  try{
    ui.enterUrl();ui.submit();await tick();ui.$('.new-draft').click();await tick();
    assert.equal(ui.calls.length,1);assert.equal(ui.resets.length,1);
    assert.equal(ui.$('.status').textContent,'无法准备新草稿');
    assert.equal(ui.$('.primary').disabled,true);assert.equal(ui.$('.new-draft').disabled,false);
    ui.$('.open').click();await tick();assert.equal(ui.messages[0].draftUrl,DRAFT);
    ui.enterUrl();assert.equal(ui.$('.new-draft').hidden,true);
    ui.$('.new-draft').dispatchEvent(new ui.window.Event('click'));await tick();
    assert.equal(ui.resets.length,1,'clearing the result also clears recovery authorization');
  }finally{ui.close();}
});

test('uncertain save only resets after the explicit recovery click and does not adopt the current native draft', async () => {
  let attempt = 0, releaseReset;
  const resetGate = new Promise(resolve => { releaseReset = resolve; });
  const ui = setup({
    url: 'https://member.bilibili.com/york/read-editor?aid=999999',
    runImport: async () => {
      if (++attempt === 1) { const error = new Error('保存结果不确定，请先检查草稿箱。'); error.saveUncertain = true; throw error; }
      return { draftId: '123', draftUrl: DRAFT, verified: true, warnings: [] };
    },
    resetPendingImport: async () => resetGate,
  });
  try {
    ui.$('.launch').click(); ui.enterUrl(); ui.submit(); await tick();
    assert.equal(ui.$('.recover').hidden, false);
    assert.equal(ui.$('.recover').textContent, '已确认没有草稿，重新导入');
    assert.equal(ui.$('.primary').disabled, true);
    assert.equal(ui.resets.length, 0);
    ui.submit(); ui.$('.close').click(); ui.$('.launch').click(); await tick();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.resets.length, 0);
    ui.$('.recover').click(); await tick();
    assert.equal(ui.$('.recover').disabled, true);
    ui.$('.recover').dispatchEvent(new ui.window.Event('click'));
    assert.equal(ui.resets.length, 1);
    assert.equal(ui.resets[0].sourceUrl, WX);
    assert.equal(ui.resets[0].html, undefined);
    assert.deepEqual(Object.keys(ui.resets[0]).sort(), ['html', 'sourceUrl']);
    assert.equal(ui.calls.length, 1, 'reset must finish before importing again');
    releaseReset(); await tick();
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.calls[1].draftId, undefined);
    assert.equal(ui.messages.length, 1);
    assert.equal(ui.messages[0].draftUrl, DRAFT);
    assert.equal(ui.$('.recover').hidden, true);
    assert.equal(ui.dom.window.document.getElementById('nativeTitle').value, '用户正在编辑的原生草稿');
  } finally { releaseReset(); ui.close(); }
});

test('uncertain local import recovery reuses saved HTML and does not retry when resetting fails', async () => {
  const ui = setup({
    runImport: async () => { const error = new Error('保存结果不确定，请先检查草稿箱。'); error.saveUncertain = true; throw error; },
    resetPendingImport: async () => { throw new Error('无法清理待确认任务'); },
  });
  try {
    const html = new ui.window.File(['<article>本地原文</article>'], 'saved.html', { type: 'text/html' });
    html.text = async () => '<article>本地原文</article>';
    ui.setFiles('.html-file', [html]); ui.submit(); await tick();
    ui.$('.recover').click(); await tick();
    assert.equal(ui.resets.length, 1);
    assert.equal(ui.resets[0].html, '<article>本地原文</article>');
    assert.equal(ui.resets[0].sourceUrl, '');
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.$('.status').textContent, '无法清理待确认任务');
    assert.equal(ui.$('.primary').disabled, true);
    assert.equal(ui.$('.recover').disabled, false);
    assert.equal(ui.$('.recover').hidden, false);
    ui.enterUrl();
    assert.equal(ui.$('.recover').hidden, true);
  } finally { ui.close(); }
});
