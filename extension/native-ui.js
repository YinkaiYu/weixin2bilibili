/* Content script: a small import entry inside the native Bilibili editor. */
(() => {
  'use strict';
  const HOST_ID = 'wechat-bilibili-native-import';
  const CONTROLLER_KEY = '__wechatBilibiliNativeUiController';
  if (window.top !== window) return;
  function isEditorUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'member.bilibili.com' && !url.port && !url.username && !url.password && /^(?:\/york\/read-editor|\/platform\/upload\/text\/(?:new-edit|edit))\/?$/.test(url.pathname);
    } catch { return false; }
  }
  if (globalThis[CONTROLLER_KEY]) { globalThis[CONTROLLER_KEY].refresh(); return; }

  function mountUi() {

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  // Closed shadow prevents the page from obtaining our controls and dispatching
  // synthetic import clicks. Controller access stays in the extension world.
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;color-scheme:light;font-family:Arial,"Microsoft YaHei",sans-serif;color:#18191c;font-size:14px;line-height:1.5}
      *{box-sizing:border-box}button,input,summary,label{font:inherit}button,label,summary{-webkit-tap-highlight-color:transparent}
      button{cursor:pointer;border:0}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible,summary:focus-visible,label:focus-visible{outline:3px solid #80d7f4;outline-offset:3px}
      [hidden]{display:none!important}
      .launch{pointer-events:auto;position:fixed;right:28px;bottom:88px;height:42px;padding:0 20px;border:1px solid #b6e8f8;border-radius:22px;background:#fff;color:#007dab;font-weight:600;box-shadow:0 3px 15px #142b3b15;transition:background .15s}
      .launch:hover{background:#f2fbff}
      .overlay{pointer-events:auto;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#0006}
      .dialog{position:relative;width:440px;max-width:100%;max-height:calc(100vh - 48px);overflow:auto;border:1px solid #e4e7ed;border-radius:16px;background:#fff;padding:28px;box-shadow:0 16px 64px #0003;text-align:left}
      .title{margin:0 32px 24px 0;font-size:20px;line-height:1.4;font-weight:600}
      .close{position:absolute;right:16px;top:14px;width:32px;height:32px;border-radius:8px;background:transparent;color:#9499a0;font-size:25px;line-height:1}
      .close:hover{background:#f1f2f3;color:#18191c}
      .url{display:block;width:100%;height:44px;padding:0 12px;background:#fff;border:1px solid #d7dce2;border-radius:8px;color:#18191c;font-size:14px}
      .url::placeholder{color:#9499a0}.url:focus{border-color:#00a1d6;outline:none;box-shadow:0 0 0 3px #00a1d61a}
      .primary{display:block;width:100%;margin-top:14px;min-height:42px;border-radius:8px;background:#00a1d6;color:white;font-weight:600}
      .primary:hover:not(:disabled){background:#008fbe}
      details{margin-top:18px}summary{width:max-content;cursor:pointer;color:#61666d;font-size:13px;user-select:none}summary:hover{color:#007dab}
      .local{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}
      .file-label{display:inline-block;cursor:pointer;color:#007dab;background:#f1f9fc;border:1px solid #d9eef6;border-radius:6px;padding:5px 10px;font-size:13px}
      .file-label[aria-disabled="true"]{opacity:.5;cursor:default}
      .filename{display:block;flex:1;min-width:110px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#61666d;font-size:12px}
      .status{margin:16px 0 0;overflow-wrap:anywhere;color:#61666d;font-size:13px;white-space:pre-line}.status.error{color:#c43c39}.status.success{color:#16845c}
      .open,.recover,.new-draft{display:block;width:100%;margin-top:12px;min-height:40px;border:1px solid #00a1d6;border-radius:8px;color:#007dab;background:white;font-weight:600}
      .warnings{margin-top:12px}.warnings ul{margin:10px 0 0;padding-left:18px;color:#61666d;font-size:13px;overflow-wrap:anywhere}.warnings li+li{margin-top:6px}
      @media(max-width:520px){.launch{right:16px;bottom:84px}.overlay{padding:16px}.dialog{padding:24px;max-height:calc(100vh - 32px)}}
    </style>
    <button class="launch" type="button">导入公众号</button>
    <div class="overlay" hidden>
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="wechat-import-title">
        <h2 class="title" id="wechat-import-title">导入公众号</h2>
        <button class="close" type="button" aria-label="关闭">×</button>
        <form novalidate>
          <input class="url" type="url" aria-label="公众号文章链接" placeholder="粘贴公众号文章链接" autocomplete="off" spellcheck="false">
          <button class="primary" type="submit">导入为新草稿</button>
          <details class="more">
            <summary>更多</summary>
            <div class="local">
              <label class="file-label" tabindex="0" role="button" for="wechat-html-file">导入本地网页</label>
              <input id="wechat-html-file" class="html-file" type="file" accept=".html,.htm,text/html" tabindex="-1" hidden>
              <span class="filename html-name"></span>
            </div>
            <div class="local">
              <label class="file-label" tabindex="0" role="button" for="wechat-resource-folder">资源文件夹</label>
              <input id="wechat-resource-folder" class="resource-files" type="file" webkitdirectory multiple tabindex="-1" hidden>
              <span class="filename resource-name"></span>
            </div>
          </details>
        </form>
        <p class="status" role="status" aria-live="polite" hidden></p>
        <button class="open" type="button" hidden>打开草稿</button>
        <button class="recover" type="button" hidden>已确认没有草稿，重新导入</button>
        <button class="new-draft" type="button" hidden>另建新草稿</button>
        <details class="warnings" hidden>
          <summary>查看提醒</summary>
          <ul></ul>
        </details>
      </section>
    </div>`;
  document.documentElement.append(host);
  const $ = selector => shadow.querySelector(selector);
  const launch = $('.launch'), overlay = $('.overlay'), form = $('form'), source = $('.url');
  const submit = $('.primary'), fileInput = $('.html-file'), resources = $('.resource-files');
  const status = $('.status'), openButton = $('.open'), recoverButton = $('.recover'), newDraftButton = $('.new-draft'), warnings = $('.warnings');
  let busy = false, completed = false, saveUncertain = false, recoveredUnverified = false, draftUrl = '', priorFocus = null, controllerPromise;

  function showStatus(message, kind = '') {
    status.textContent = String(message || '');
    status.className = `status${kind ? ` ${kind}` : ''}`;
    status.hidden = !message;
  }

  function setBusy(value) {
    busy = value;
    source.disabled = value;
    fileInput.disabled = value;
    resources.disabled = value;
    submit.disabled = value || completed || saveUncertain;
    recoverButton.disabled = value;
    newDraftButton.disabled = value;
    for (const label of shadow.querySelectorAll('.file-label')) {
      label.setAttribute('aria-disabled', String(value));
      label.tabIndex = value ? -1 : 0;
    }
    form.setAttribute('aria-busy', String(value));
  }

  function open(sourceUrl) {
    if (!isEditorUrl(location.href)) return;
    if (!busy && sourceUrl) {
      source.value = String(sourceUrl);
      fileInput.value = '';
      resources.value = '';
      $('.html-name').textContent = '';
      $('.resource-name').textContent = '';
      resetResult();
    }
    if (overlay.hidden) priorFocus = document.activeElement;
    overlay.hidden = false;
    if (!busy) source.focus();
    else $('.close').focus();
  }

  function close() {
    overlay.hidden = true;
    if (priorFocus?.isConnected && typeof priorFocus.focus === 'function') priorFocus.focus();
  }

  function resetResult() {
    if (busy) return;
    completed = false;
    saveUncertain = false;
    recoveredUnverified = false;
    draftUrl = '';
    openButton.hidden = true;
    recoverButton.hidden = true;
    newDraftButton.hidden = true;
    warnings.hidden = true;
    warnings.open = false;
    warnings.querySelector('ul').replaceChildren();
    showStatus('');
    setBusy(false);
  }

  function isWechatUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/|$)/.test(url.pathname);
    } catch { return false; }
  }

  function safeDraftUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'member.bilibili.com' && /^\/(?:york\/read-editor|platform\/upload\/text)(?:\/|$)/.test(url.pathname);
    } catch { return false; }
  }

  function showWarnings(messages) {
    const list = warnings.querySelector('ul');
    list.replaceChildren();
    for (const message of [...new Set((messages || []).map(String).filter(Boolean))]) {
      const li = document.createElement('li');
      li.textContent = message;
      list.append(li);
    }
    warnings.hidden = !list.childElementCount;
    warnings.querySelector('summary').textContent = list.childElementCount ? `查看提醒（${list.childElementCount}）` : '查看提醒';
  }

  async function openDraft() {
    if (!safeDraftUrl(draftUrl)) throw new Error('草稿地址无效，请在 B 站草稿箱查看。');
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_SAVED_DRAFT', draftUrl });
    if (response?.error || response?.ok === false) throw new Error(typeof response.error === 'string' ? response.error : response.error?.message || response.message || '无法打开草稿。');
  }

  async function importArticle(event) {
    event.preventDefault();
    if (!isEditorUrl(location.href) || busy || completed || saveUncertain) return;
    const sourceUrl = source.value.trim();
    const htmlFile = fileInput.files?.[0];
    if (!htmlFile && !isWechatUrl(sourceUrl)) {
      showStatus('请输入有效的微信公众号文章链接。', 'error');
      source.focus();
      return;
    }
    if (sourceUrl && !isWechatUrl(sourceUrl)) {
      showStatus('公众号文章链接不正确。', 'error');
      source.focus();
      return;
    }
    if (htmlFile && !/\.html?$/i.test(htmlFile.name) && htmlFile.type !== 'text/html') {
      showStatus('请选择保存的 HTML 网页。', 'error');
      return;
    }
    resetResult();
    setBusy(true);
    showStatus('正在读取文章…');
    try {
      const html = htmlFile ? await htmlFile.text() : undefined;
      const localFiles = Array.from(resources.files || []);
      if (!controllerPromise) controllerPromise = import(chrome.runtime.getURL('lib/native-controller.js')).catch(error => { controllerPromise = undefined; throw error; });
      const controller = await controllerPromise;
      const result = await controller.runImport({ sourceUrl, html, localFiles }, message => showStatus(message));
      if (!safeDraftUrl(result?.draftUrl)) throw new Error('草稿已处理，但没有返回有效的草稿地址，请检查 B 站草稿箱。');
      completed = true;
      draftUrl = result.draftUrl;
      openButton.hidden = false;
      recoveredUnverified = result.recovered === true && result.verified === false;
      newDraftButton.hidden = !recoveredUnverified;
      showWarnings(result.warnings);
      showStatus(recoveredUnverified ? '已有草稿已保留，需要检查' : result.verified === false ? '草稿已保存，需要检查' : '草稿已保存', result.verified === false ? '' : 'success');
      if (result.verified !== false) {
        try { await openDraft(); }
        catch (error) { showStatus(`草稿已保存。${error.message || '请点击打开草稿。'}`, 'error'); }
      }
    } catch (error) {
      // A controller may report a confirmed save followed by a verification
      // error. Expose that draft and do not create another on an accidental retry.
      if (safeDraftUrl(error?.draftUrl)) {
        draftUrl = error.draftUrl;
        completed = true;
        openButton.hidden = false;
      } else if (error?.saveUncertain === true) {
        saveUncertain = true;
        recoverButton.hidden = false;
      }
      showStatus(error?.message || '导入失败，请重试。', 'error');
    } finally { setBusy(false); }
  }

  launch.addEventListener('click', () => open());
  $('.close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  form.addEventListener('submit', importArticle);
  source.addEventListener('input', () => {
    if (busy) return;
    fileInput.value = '';
    resources.value = '';
    $('.html-name').textContent = '';
    $('.resource-name').textContent = '';
    resetResult();
  });
  fileInput.addEventListener('change', () => {
    if (busy) return;
    source.value = '';
    resources.value = '';
    $('.resource-name').textContent = '';
    $('.html-name').textContent = fileInput.files?.[0]?.name || '';
    resetResult();
  });
  resources.addEventListener('change', () => {
    if (busy) return;
    const files = Array.from(resources.files || []);
    $('.resource-name').textContent = files[0]?.webkitRelativePath?.split('/')[0] || (files.length ? `${files.length} 个文件` : '');
    resetResult();
  });
  for (const label of shadow.querySelectorAll('.file-label')) {
    label.addEventListener('click', event => { if (busy) event.preventDefault(); });
    label.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!busy) shadow.getElementById(label.htmlFor).click();
      }
    });
  }
  openButton.addEventListener('click', () => openDraft().catch(error => showStatus(error.message, 'error')));
  async function restartImport(reason) {
    if (!isEditorUrl(location.href) || busy || (reason === 'uncertain' ? !saveUncertain : !recoveredUnverified)) return;
    setBusy(true);
    showStatus('正在准备重新导入…');
    try {
      const htmlFile = fileInput.files?.[0];
      const html = htmlFile ? await htmlFile.text() : undefined;
      const controller = await controllerPromise;
      if (typeof controller?.resetPendingImport !== 'function') throw new Error('恢复组件未加载，请重新打开插件。');
      // A new job requires an explicit recovery/new-draft click. Neither action
      // changes or deletes a draft already saved on B站.
      await controller.resetPendingImport({ sourceUrl: source.value.trim(), html });
      setBusy(false);
      resetResult();
      await importArticle({ preventDefault() {} });
    } catch (error) {
      showStatus(error?.message || '重新导入失败，请重试。', 'error');
    } finally { setBusy(false); }
  }
  recoverButton.addEventListener('click', () => restartImport('uncertain'));
  newDraftButton.addEventListener('click', () => restartImport('new'));
  shadow.addEventListener('keydown', event => {
    if (overlay.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = Array.from($('.dialog').querySelectorAll('button:not([disabled]),input:not([disabled]),summary,[tabindex="0"]')).filter(el => {
      const details = el.closest('details');
      return !el.closest('[hidden]') && el.getAttribute('aria-disabled') !== 'true' && (!details || details.open || el.tagName === 'SUMMARY');
    });
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || message?.type !== 'SHOW_IMPORT' || !isEditorUrl(location.href)) return;
    open(isWechatUrl(message.sourceUrl) ? message.sourceUrl : undefined);
    sendResponse?.({ ok: true });
  });
  function readHash() {
    const [name, query = ''] = location.hash.split('?');
    if (name !== '#wechat-import') return;
    const value = new URLSearchParams(query).get('source');
    open(isWechatUrl(value) ? value : undefined);
  }
  return {
    readHash,
    setRouteActive(active) {
      host.style.display = active ? 'block' : 'none';
      if (!active) overlay.hidden = true;
    },
  };
  }

  let ui = null, lastUrl = '';
  function refreshRoute() {
    const url = location.href;
    if (!isEditorUrl(url)) { ui?.setRouteActive(false); lastUrl = url; return; }
    if (!ui) ui = mountUi();
    ui.setRouteActive(true);
    if (url !== lastUrl) ui.readHash();
    lastUrl = url;
  }
  globalThis[CONTROLLER_KEY] = { refresh: refreshRoute };
  // B站's outer creator UI changes routes without reloading the document. Observe
  // its DOM render, and handle back/forward navigation, without patching page code.
  const observer = new MutationObserver(() => {
    if (globalThis.location?.href && globalThis.location.href !== lastUrl) refreshRoute();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  window.addEventListener('popstate', refreshRoute);
  window.addEventListener('hashchange', refreshRoute);
  refreshRoute();
})();
