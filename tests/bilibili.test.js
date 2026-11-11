import test from 'node:test';
import assert from 'node:assert/strict';
import {createBilibiliClient, buildDraftPayload, normalizeBiliImageUrl, inspectGif, verifyDraft, matchCollection} from '../extension/lib/bilibili.js';

const imageUrl = 'https://i0.hdslb.com/bfs/new_dyn/example.png';
const content = {paragraphs: [
  {para_type: 1, format: {}, text: {nodes: [
    {node_type: 1, word: {words: '彩色正文', font_size: 17, font_level: 'regular', color: '#ff0000', style: {bold: true}}},
    {node_type: 5, formula: {latex_content: 'x^{2}'}},
  ]}},
  {para_type: 2, pic: {pics: [{url: imageUrl, width: 100, height: 50, size: 2.1}]}},
]};
const options = {title: '文章标题', content, coverUrl: imageUrl, collectionId: 42, original: true};
const clone = value => JSON.parse(JSON.stringify(value));
const response = data => new Response(JSON.stringify({code: 0, data}), {status: 200, headers: {'Content-Type': 'application/json'}});
const makeDraft = payload => ({...clone(payload.arg), article_id: 123, list: {id: payload.arg.list_id}});
const gif1 = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
function twoFrameGif() {
  // One global color table, then two complete image descriptor/data blocks.
  return new Uint8Array([...gif1.slice(0, 19), ...gif1.slice(19, -1), ...gif1.slice(19, -1), 0x3b]);
}

test('uses current Opus schema with native cover, original declaration and collection', () => {
  const result = buildDraftPayload(options);
  assert.equal(result.arg.type, 4);
  assert.equal(result.arg.original, 1);
  assert.equal(result.arg.list_id, 42);
  assert.deepEqual(result.arg.image_urls, [imageUrl]);
  assert.equal(result.arg.opus.pub_info.editor_version, 'eva3-4.0.0');
  assert.deepEqual(result.arg.opus.content, content);
  assert.equal(result.arg.article_id, undefined);
  assert.equal(result.arg.content, undefined, 'does not accidentally send legacy HTML');
});

test('accepts CDN URLs but rejects suffix spoofs, userinfo, external and data URLs', () => {
  assert.equal(normalizeBiliImageUrl('//i0.hdslb.com/bfs/new_dyn/a.gif'), 'https://i0.hdslb.com/bfs/new_dyn/a.gif');
  assert.equal(normalizeBiliImageUrl('http://i0.hdslb.com/bfs/new_dyn/a.gif'), 'https://i0.hdslb.com/bfs/new_dyn/a.gif');
  for (const value of ['https://hdslb.com.evil.test/bfs/x.png', 'https://evil.test/?hdslb.com', 'https://u:p@i0.hdslb.com/bfs/x.png', 'https://mp.weixin.qq.com/image.png', 'data:image/png;base64,AAAA', 'https://i0.hdslb.com/not-bfs/a.png']) assert.throws(() => normalizeBiliImageUrl(value));
});

test('refuses missing image metadata and unresolved external images', () => {
  const bad = clone(options);
  bad.content.paragraphs[1].pic.pics[0].url = 'https://mmbiz.qpic.cn/picture.png';
  assert.throws(() => buildDraftPayload(bad), /转存/);
  bad.content.paragraphs[1].pic.pics[0].url = imageUrl;
  bad.content.paragraphs[1].pic.pics[0].width = 0;
  assert.throws(() => buildDraftPayload(bad), /尺寸/);
});

test('matches only one exact collection name, leaving ambiguity to the user', () => {
  const collections = [{id: 1, name: '正经玩'}, {id: 2, name: '正经玩具'}];
  assert.equal(matchCollection([' 正经玩 '], collections)?.id, 1);
  assert.equal(matchCollection(['玩'], collections), null);
  assert.equal(matchCollection(['正经玩', '正经玩具'], collections), null);
  assert.equal(matchCollection(['正经玩'], [...collections, {id: 3, name: '正经玩'}]), null);
});

test('readback catches image loss, style loss, formula changes, and lost settings', () => {
  const payload = buildDraftPayload(options);
  const good = makeDraft(payload);
  assert.equal(verifyDraft(payload, good).ok, true);
  const mutations = [
    draft => draft.opus.content.paragraphs.pop(),
    draft => draft.opus.content.paragraphs[0].text.nodes[0].word.style.bold = false,
    draft => draft.opus.content.paragraphs[0].text.nodes[0].word.color = '#000000',
    draft => draft.opus.content.paragraphs[0].text.nodes[1].formula.latex_content = 'x^3',
    draft => draft.original = 0,
    draft => draft.list.id = 99,
    draft => draft.image_urls = [],
  ];
  for (const mutate of mutations) { const draft = clone(good); mutate(draft); assert.equal(verifyDraft(payload, draft).ok, false); }
});

test('native picture captions survive payload and readback and detect missing, changed or swapped captions', () => {
  const input = clone(options);
  const first = input.content.paragraphs[1].pic.pics[0];
  first.comment = '第一幅图的说明';
  input.content.paragraphs.push({para_type: 2, pic: {pics: [{...first, url: imageUrl.replace('example', 'second'), comment: '第二幅图的说明'}]}});
  const payload = buildDraftPayload(input), good = makeDraft(payload);
  assert.equal(payload.arg.opus.content.paragraphs[1].pic.pics[0].comment, first.comment);
  assert.equal(verifyDraft(payload, good).ok, true);
  const mutations = [
    draft => delete draft.opus.content.paragraphs[1].pic.pics[0].comment,
    draft => draft.opus.content.paragraphs[1].pic.pics[0].comment = '第一幅图',
    draft => { const pics = draft.opus.content.paragraphs.filter(p => p.pic).map(p => p.pic.pics[0]); [pics[0].comment, pics[1].comment] = [pics[1].comment, pics[0].comment]; },
  ];
  for (const mutate of mutations) {
    const draft = clone(good); mutate(draft);
    const result = verifyDraft(payload, draft);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.includes('图片注释发生变化')));
  }
});

test('refuses a caption the native editor would truncate or cannot represent as plain text', () => {
  for (const comment of ['字'.repeat(101), '😀'.repeat(51), {text: '说明'}]) {
    const input = clone(options);
    input.content.paragraphs[1].pic.pics[0].comment = comment;
    assert.throws(() => buildDraftPayload(input), /图片注释/);
  }
});

test('GIF parser counts structural frames and refuses corrupt/truncated data', () => {
  assert.equal(inspectGif(gif1).frames, 1);
  assert.equal(inspectGif(twoFrameGif()).frames, 2);
  assert.throws(() => inspectGif(gif1.slice(0, -2)), /完整/);
  assert.throws(() => inspectGif(new TextEncoder().encode('<html>error</html>')), /有效 GIF/);
});

test('uploads GIF bytes with .gif filename and checks returned animation', async () => {
  const originalBytes = twoFrameGif();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    if (url.includes('/upload_bfs')) return response({image_url: imageUrl.replace('.png', '.gif'), image_width: 1, image_height: 1, image_size: .1});
    return new Response(originalBytes, {headers: {'Content-Type': 'image/gif'}});
  };
  const client = createBilibiliClient({fetchImpl, getCookie: async () => 'test-token'});
  const uploaded = await client.uploadImage(new Blob([originalBytes], {type: 'image/jpeg'}), {filename: 'misnamed.jpg'});
  const file = calls[0].init.body.get('file_up');
  assert.equal(file.name, 'misnamed.gif');
  assert.equal(file.type, 'image/gif');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), originalBytes);
  assert.equal(calls[0].init.body.get('csrf'), 'test-token');
  assert.equal(calls[0].init.body.get('biz'), 'new_dyn');
  assert.equal(uploaded.animationVerified, true);
  assert.equal(uploaded.animation.frames, 2);
  assert.equal(calls[1].init.credentials, 'omit', 'CDN requests never send account credentials');
});

test('rejects an upload whose returned GIF lost frames', async () => {
  const client = createBilibiliClient({getCookie: async () => 'token', fetchImpl: async url => url.includes('/upload_bfs')
    ? response({image_url: imageUrl.replace('.png', '.gif'), image_width: 1, image_height: 1, image_size: .1})
    : new Response(gif1)});
  await assert.rejects(client.uploadImage(new Blob([twoFrameGif()])), /帧数/);
});

test('rejects an HTML error response masquerading as an image before upload', async () => {
  let requested = false;
  const client = createBilibiliClient({fetchImpl: async () => { requested = true; }, getCookie: async () => 'token'});
  await assert.rejects(client.uploadImage(new Blob(['<html>Access denied</html>'], {type: 'image/png'})), /网页错误页/);
  assert.equal(requested, false);
});

test('saves draft then re-reads it, using native API only', async () => {
  const calls = [];
  let saved;
  const client = createBilibiliClient({getCookie: async () => 'test-token', fetchImpl: async (url, init) => {
    calls.push({url, init});
    if (url.includes('/draft/add')) { saved = JSON.parse(init.body); return response({article_id: 123}); }
    return response({draft: makeDraft(saved)});
  }});
  const result = await client.saveDraft(options);
  assert.equal(result.verified, true);
  assert.equal(result.draftId, '123');
  assert.equal(result.draftUrl, 'https://member.bilibili.com/york/read-editor?aid=123');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.bilibili.com/x/dynamic/feed/article/draft/add?csrf=test-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].url, 'https://api.bilibili.com/x/dynamic/feed/article/draft/view?article_id=123');
  assert.ok(calls.every(call => !call.url.includes('/create/opus')));
});

test('failed readback reports saved draft ID so retry does not duplicate it', async () => {
  const client = createBilibiliClient({getCookie: async () => 'token', fetchImpl: async url => {
    if (url.includes('/draft/add')) return response({article_id: 123});
    return new Response('unavailable', {status: 503});
  }});
  const result = await client.saveDraft(options);
  assert.equal(result.draftId, '123');
  assert.equal(result.verified, false);
  assert.match(result.verification.issues[0], /草稿已保存/);
});

test('API errors and expired login do not leak CSRF or silently succeed', async () => {
  const client = createBilibiliClient({getCookie: async () => '', fetchImpl: async () => response({isLogin: true, mid: 1})});
  await assert.rejects(client.saveDraft(options), /登录/);
  await assert.rejects(client.getLoginInfo(), /登录/);
  const denied = createBilibiliClient({getCookie: async () => 'SECRET', fetchImpl: async () => new Response(JSON.stringify({code: -111, message: 'csrf error'}))});
  await assert.rejects(denied.saveDraft(options), error => error.code === -111 && !error.message.includes('SECRET'));
});

test('turning off a cover sends an explicit clear and detects a server retaining the old cover', () => {
  const payload=buildDraftPayload({...options,coverUrl:'',draftId:123});
  assert.deepEqual(payload.arg.image_urls,[]);
  const draft=makeDraft(payload);
  assert.equal(verifyDraft(payload,draft).ok,true);
  draft.image_urls=[imageUrl];
  assert.equal(verifyDraft(payload,draft).ok,false);
  assert.match(verifyDraft(payload,draft).issues.join(' '),/旧封面/);
  draft.image_urls=[];draft.opus.article={cover:[{url:imageUrl}]};
  assert.equal(verifyDraft(payload,draft).ok,true,'automatic article cover does not mean custom cover is enabled');
});

test('confirmed draft ID is checkpointed before readback and callback failure does not hide it', async () => {
  const events=[];
  const client=createBilibiliClient({getCookie:async()=> 'token',fetchImpl:async url=>{
    if(url.includes('/draft/add')) {events.push('saved');return response({article_id:123});}
    events.push('readback');return response({draft:makeDraft(buildDraftPayload(options))});
  }});
  const result=await client.saveDraft({...options,onSaved:async saved=>{events.push('checkpoint');assert.equal(saved.draftId,'123');throw new Error('disk full');}});
  assert.deepEqual(events,['saved','checkpoint','readback']);
  assert.equal(result.draftId,'123');assert.equal(result.verified,false);
  assert.match(result.verification.issues.join(' '),/备份失败/);
});

test('an interrupted save preserves known draft ID and marks unknown save outcomes', async () => {
  const client=createBilibiliClient({getCookie:async()=> 'token',fetchImpl:async()=>{throw new Error('connection interrupted');}});
  await assert.rejects(client.saveDraft({...options,draftId:123}),error=>error.draftId==='123'&&error.saveUncertain===true&&/避免重复/.test(error.message));
  const denied=createBilibiliClient({getCookie:async()=> 'token',fetchImpl:async()=>new Response(JSON.stringify({code:-101}))});
  await assert.rejects(denied.saveDraft(options),error=>error.code===-101&&!error.saveUncertain);
});

test('readback accepts the observed CDN alias and omitted zero/empty protobuf defaults only', () => {
  const expected = clone(options);
  expected.content.paragraphs[0].format = {align:0};
  expected.content.paragraphs[0].text.nodes[0].word.bg_style = {style:1,color:{color:'#ffcc00',dark_color:''}};
  expected.content.paragraphs[1].pic.style = 0;
  const payload = buildDraftPayload(expected), actual = makeDraft(payload);
  actual.image_urls[0] = actual.image_urls[0].replace('i0.hdslb.com','article.biliimg.com');
  actual.opus.content.paragraphs[0].format = {indent:{}};
  delete actual.opus.content.paragraphs[0].text.nodes[0].word.bg_style.color.dark_color;
  actual.opus.content.paragraphs[1].pic.pics[0].url = imageUrl.replace('i0.hdslb.com','article.biliimg.com');
  delete actual.opus.content.paragraphs[1].pic.style;
  assert.deepEqual(verifyDraft(payload,actual),{ok:true,issues:[]});
  assert.equal(payload.arg.opus.content.paragraphs[0].format.align,0,'verification must not mutate input');
});

test('CDN normalization retains different object paths, image transforms, queries and unrelated hosts', () => {
  const payload = buildDraftPayload(options);
  for(const changed of [
    imageUrl.replace('example.png','other.png'),
    imageUrl+'@200w_200h.png',
    imageUrl+'?width=200',
    imageUrl.replace('i0.hdslb.com','unobserved.biliimg.com'),
    imageUrl.replace('i0.hdslb.com','article.biliimg.com.evil.test'),
  ]) {
    const actual = makeDraft(payload); actual.image_urls=[changed];
    assert.equal(verifyDraft(payload,actual).ok,false,changed);
  }
});

test('default normalization still catches text, styles, formulas, order, dimensions and real paragraph formatting changes', () => {
  const expected = clone(options);
  expected.content.paragraphs[1].pic.style=0;
  expected.content.paragraphs.push({para_type:2,pic:{style:0,pics:[{url:imageUrl.replace('example','second'),width:100,height:50,size:2}]}});
  const payload=buildDraftPayload(expected);
  const mutations = [
    d=>{d.opus.content.paragraphs[0].text.nodes[0].word.words+='改字';},
    d=>{d.opus.content.paragraphs[0].text.nodes[0].word.color='#00ff00';},
    d=>{d.opus.content.paragraphs[0].text.nodes[0].word.style.bold=false;},
    d=>{d.opus.content.paragraphs[0].text.nodes[1].formula.latex_content='x^3';},
    d=>{[d.opus.content.paragraphs[1],d.opus.content.paragraphs[2]]=[d.opus.content.paragraphs[2],d.opus.content.paragraphs[1]];},
    d=>{d.opus.content.paragraphs[1].pic.pics[0].url=imageUrl.replace('example','changed');},
    d=>{d.opus.content.paragraphs[1].pic.pics[0].width=200;},
    d=>{d.opus.content.paragraphs[0].format={align:1,indent:{}};},
    d=>{d.opus.content.paragraphs[0].format={indent:{first_line_indent:1}};},
    d=>{d.opus.content.paragraphs[1].pic.style=1;},
  ];
  for(const mutate of mutations){const actual=makeDraft(payload);mutate(actual);assert.equal(verifyDraft(payload,actual).ok,false);}
});

test('readback names real font-size changes instead of treating platform reformatting as equivalent', () => {
  const expected=clone(options);expected.content.paragraphs[0].text.nodes[0].word.font_size=14;
  const payload=buildDraftPayload(expected),actual=makeDraft(payload);
  actual.opus.content.paragraphs[0].text.nodes[0].word.font_size=17;
  const result=verifyDraft(payload,actual);
  assert.equal(result.ok,false);
  assert.match(result.issues.join(' '),/1 处文字字号.*14→17/);
});

test('white plus Ba0 is a real theme color change, while the proven black Ba0 palette is equivalent to explicit black', () => {
  const expected=clone(options);expected.content.paragraphs[0].text.nodes[0].word.color='#ffffff';
  const payload=buildDraftPayload(expected),actual=makeDraft(payload);
  actual.opus.content.paragraphs[0].text.nodes[0].word.bili_theme='Ba0';
  actual.opus.content.paragraphs[0].text.nodes[0].word.dark_color='#000000';
  assert.equal(verifyDraft(payload,actual).ok,false);
  assert.match(verifyDraft(payload,actual).issues.join(' '),/主题色/);
  expected.content.paragraphs[0].text.nodes[0].word.color='#000000';
  expected.content.paragraphs[0].text.nodes[0].word.dark_color='#000000';
  const blackPayload=buildDraftPayload(expected),black=makeDraft(blackPayload);
  black.opus.content.paragraphs[0].text.nodes[0].word.bili_theme='Ba0';
  assert.equal(verifyDraft(blackPayload,black).ok,true);
  black.opus.content.paragraphs[0].text.nodes[0].word.bili_theme='unknown';
  assert.equal(verifyDraft(blackPayload,black).ok,false);
});
