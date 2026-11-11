import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {parseArticle, cleanArticle} from '../extension/lib/article.js';

// User-provided saved pages are local regression inputs, never shipped in the extension.
// DOMParser neither runs their scripts nor loads their external resources.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, '测试文章');
globalThis.DOMParser = new JSDOM('').window.DOMParser;
const expectations = [
  {file:'不抽血不拍片，闻一闻就能接收身体警报？？？.html', collection:'翻译专栏', images:4, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:1},
  {file:'为什么只睡20分钟，下午就能精神满满？_ No. 537.html', collection:'问答', images:9, gifs:0, formulas:7, superscripts:19, subscripts:0, backgrounds:12},
  {file:'你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', collection:'正经玩', images:16, gifs:1, formulas:4, superscripts:0, subscripts:7, backgrounds:1},
  {file:'摸了半天找不到头，胶带却记得你撕到哪儿？.html', collection:'线上科学日', images:12, gifs:0, formulas:0, superscripts:0, subscripts:4, backgrounds:0},
  {file:'要宣布翻篇了？那我磁化损失呢，厉娜.html', collection:'线上科学日', images:64, gifs:0, formulas:0, superscripts:0, subscripts:0, backgrounds:0},
];
const entries = [];

for (const expected of expectations) {
  const filename = path.join(fixtureDir, expected.file);
  const exists = fs.existsSync(filename);
  let parsed;
  if (exists) {
    const source = fs.readFileSync(filename, 'utf8');
    const originalDocument = new DOMParser().parseFromString(source, 'text/html');
    const originalBody = originalDocument.querySelector('#js_content');
    parsed = parseArticle(source);
    const cleanedDocument = new DOMParser().parseFromString(parsed.html, 'text/html');
    const originalImages = [...originalBody.querySelectorAll('img')];
    const coloredNodes = [...cleanedDocument.querySelectorAll('[style]')].filter(node=>node.style?.color);
    const boldNodes = [...cleanedDocument.querySelectorAll('b,strong,[style]')].filter(node=>['B','STRONG'].includes(node.tagName) || ['bold','bolder','600','700','800','900'].includes(node.style?.fontWeight));
    const formulas = [...cleanedDocument.querySelectorAll('[data-formula],[data-latex]')].filter(node=>!node.parentElement.closest('[data-formula],[data-latex]')).map(node=>node.getAttribute('data-formula') || node.getAttribute('data-latex'));
    const localAssets = parsed.localAssets.map(asset=>{
      const absolute = path.resolve(fixtureDir, asset.localPath);
      const inside = absolute.startsWith(`${fixtureDir}${path.sep}`);
      return {...asset, available:inside && fs.existsSync(absolute)};
    });
    entries.push({
      file:expected.file, title:parsed.title, sourceUrl:parsed.sourceUrl,
      coverUrl:parsed.coverUrl, collectionNames:parsed.collectionNames,
      source:{imageElements:originalImages.length,imagesWithRemoteDataSrc:originalImages.filter(img=>/^https?:\/\//.test(img.getAttribute('data-src') || '')).length},
      retained:parsed.stats,
      formatting:{boldNodes:boldNodes.length,coloredNodes:coloredNodes.length,colors:[...new Set(coloredNodes.map(node=>node.style.color))],formulas},
      blockingIssues:parsed.blockingIssues, warnings:parsed.warnings,
      localAssets,
      backgrounds:[...cleanedDocument.querySelectorAll('[data-sync-background-url]')].map(node=>({url:node.getAttribute('data-sync-background-url'),textPreview:node.textContent.slice(0,45),requiresLocalLayoutConversion:true})),
    });
  }
  test(`real article: ${expected.file}`, {skip: !exists && '用户样稿未附带；合成回归仍会运行。'}, () => {
    assert.ok(parsed.title);
    assert.match(parsed.coverUrl, /^https:\/\/mmbiz\.qpic\.cn\//);
    assert.deepEqual(parsed.collectionNames, [expected.collection]);
    assert.equal(parsed.stats.trimmedTail,1);
    for (const key of ['images','gifs','formulas','superscripts','subscripts','backgrounds']) assert.equal(parsed.stats[key],expected[key],key);
    const document = new DOMParser().parseFromString(parsed.html,'text/html');
    assert.equal(document.querySelectorAll('script,iframe,a[href],img:not([src])').length,0);
    assert.ok([...document.querySelectorAll('img')].every(img=>/^https:\/\/(?:mmbiz\.qpic\.cn|res\.wx\.qq\.com)\//.test(img.getAttribute('src'))));
    assert.ok([...document.querySelectorAll('svg')].every(svg=>svg.closest('[data-formula],[data-latex]')));
    assert.ok(parsed.blockingIssues.every(issue=>issue.includes('CSS 背景图')));
    assert.doesNotMatch(document.body.textContent,/近期热门文章Top10|往期回顾|上期回顾/);
    const cleanedAgain = cleanArticle(parsed.html,{sourceUrl:parsed.sourceUrl});
    for (const key of ['images','gifs','formulas','superscripts','subscripts','backgrounds']) assert.equal(cleanedAgain.stats[key],parsed.stats[key],`second cleanup ${key}`);
    assert.deepEqual(cleanedAgain.blockingIssues,parsed.blockingIssues);
    if (expected.collection==='问答') assert.deepEqual([...document.querySelectorAll('[data-sync-background-url]')].map(node=>node.textContent.trim()),Array.from({length:12},(_,i)=>`Q${i+1}`));
    if (expected.collection==='正经玩') assert.equal(parsed.coverUrl,'https://mmbiz.qpic.cn/mmbiz_jpg/Q5JJsLWYMJWOFjB3xPPD8kc4xhicGDkmqHVZUuicHQP65XJwUSZcTuZ9CJyAa3j6KjUCw70phMYIIBI1HbxYTotSz3o86TCY3EfZgazCScdg0/0?wx_fmt=jpeg');
  });
}

if (process.env.WRITE_ARTICLE_AUDIT === '1') {
  fs.writeFileSync(path.join(root,'docs','article-audit.json'),JSON.stringify({
    schemaVersion:1,
    verification:'Local HTML parsing only. Page scripts were not executed; no external requests were made. Bilibili save/readback is a separate integration check.',
    localAssetResolution:'Match sourceUrl to selected File using localPath relative to the saved HTML folder. data-src remains the original remote URL; localasset:/// + encodeURIComponent(localPath) is used only when no remote image source exists. Read image bytes and substitute an object/data URL for preview, then upload original bytes. Do not infer resource mapping by filename alone.',
    backgroundExtraction:'WeChat data-lazy-bgimg takes precedence over a transparent CSS placeholder. The 正经玩 实验器材 title contains a 20×25px decoration with margin-top:-14px that was previously omitted when only the placeholder was inspected; it now requires rendering together with its surrounding title layout. 问答 contains backgrounds for every Q1–Q12 label; previously only the already-loaded Q1 was retained while Q2–Q12 were mistaken for transparent placeholders.',
    articles:entries,
  },null,2)+'\n');
}
