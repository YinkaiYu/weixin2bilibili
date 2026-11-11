import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseArticle, cleanArticle, inspectArticle, rewriteImageSources } from '../extension/lib/article.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const sourceUrl = 'https://mp.weixin.qq.com/s/example';
const doc = html => new DOMParser().parseFromString(html, 'text/html');

test('extracts cover/collection while preserving lazy GIF, formula, colors, superscripts and subscripts', () => {
  const result = parseArticle(`<html><head><title>页面标题</title><script>var msg_cdn_url = "https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg&amp;a=1"; var album_title = "正经玩";</script></head><body>
    <h1 id="activity-name">  科学文章  </h1><div id="js_content"><p style="color:#a00;font-weight:700">红色<strong>加粗</strong> H<sub>2</sub>O 与 x<sup>2</sup></p>
    <p><img src="placeholder.png" data-src="https://mmbiz.qpic.cn/example/0?wx_fmt=gif" data-type="gif" alt="演示"></p>
    <p>行内<img class="latex" data-src="//mmbiz.qpic.cn/math.png" alt="E=mc²" style="vertical-align:middle;width:60px">公式</p></div></body></html>`, {sourceUrl});
  assert.equal(result.title, '科学文章');
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg&a=1');
  assert.deepEqual(result.collectionNames, ['正经玩']);
  assert.deepEqual(result.blockingIssues, []);
  const content = doc(result.html);
  assert.equal(content.querySelectorAll('img').length, 2);
  assert.match(content.querySelector('img').src, /wx_fmt=gif/);
  assert.ok(content.querySelector('sup'));
  assert.ok(content.querySelector('sub'));
  assert.equal(content.querySelector('p').style.color, 'rgb(170, 0, 0)');
  assert.equal(content.querySelectorAll('p')[2].textContent, '行内公式');
  assert.equal(result.stats.gifs, 1);
  assert.equal(result.stats.formulas, 1);
});

for (const marker of ['上期回顾', '往期回顾', '近期热门文章 Top10']) {
  test(`trims nested tail at ${marker}, but keeps prior text and images`, () => {
    const result = cleanArticle(`<section><p>正文提到往期回顾，并不应该截断。</p><img src="https://mmbiz.qpic.cn/keep.png"><section><p><strong>${marker}</strong></p><p>旧文章</p></section></section><p>尾部广告</p>`, {sourceUrl});
    assert.match(result.html, /正文提到往期回顾/);
    assert.match(result.html, /keep\.png/);
    assert.doesNotMatch(result.html, /旧文章|尾部广告/);
    assert.equal(result.stats.trimmedTail, 1);
  });
}

test('handles split footer heading and does not remove image before it', () => {
  const result = cleanArticle('<section><img src="https://mmbiz.qpic.cn/keep.png"><p><span>近期热门文章</span><b>Top10</b></p><p>删除</p></section>');
  assert.match(result.html, /keep.png/);
  assert.doesNotMatch(result.html, /Top10|删除/);
});

test('strips external link destination and raw URLs, blank spacer blocks and unsafe content', () => {
  const result = cleanArticle(`<div><p>&nbsp;<br></p><section><p> </p></section><p><a href="https://external.test" onclick="x()">保留标签</a> https://external.test/a。</p>
    <p style="background-image:url(https://evil.test);color:blue" onclick="alert(1)">安全文字<script>alert(1)</script><img data-src="https://mmbiz.qpic.cn/ok.png" srcset="https://evil.test 2x" onerror="alert(1)"></p></div>`);
  const content = doc(result.html);
  assert.equal(content.querySelectorAll('a, script').length, 0);
  assert.match(content.body.textContent, /保留标签/);
  assert.doesNotMatch(result.html, /external\.test|onclick|onerror|srcset/);
  assert.ok(result.blockingIssues.some(issue => issue.includes('CSS 背景图')));
  assert.ok(result.stats.removedEmptyBlocks >= 3);
  assert.equal(content.querySelectorAll('p').length, 2);
  assert.equal(content.querySelectorAll('p')[1].style.color, 'blue');
});

test('does not silently discard unsupported SVG, MathML or embedded media', () => {
  const result = cleanArticle('<p>公式</p><svg viewBox="0 0 20 20"><script>bad()</script><path d="M0 0L10 10" stroke="red" onload="bad()"/></svg><math><msup><mi>x</mi><mn>2</mn></msup></math><iframe src="https://example.test"></iframe>');
  const content = doc(result.html);
  assert.ok(content.querySelector('svg path'));
  assert.ok(content.querySelector('math msup'));
  assert.ok(content.querySelector('[data-sync-unsupported="iframe"]'));
  assert.doesNotMatch(result.html, /<script|onload|<iframe/);
  assert.equal(result.blockingIssues.length, 3);
  assert.deepEqual(inspectArticle(result.html).blockingIssues, result.blockingIssues);
});

test('blocks missing image URLs and SVG data images instead of replacing them with blanks', () => {
  const result = cleanArticle('<p><img src="javascript:alert(1)"><img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></p>');
  assert.equal(doc(result.html).querySelectorAll('img').length, 2);
  assert.equal(result.blockingIssues.length, 2);
});

test('mapping rewrites all repeated images while preserving inline layout', () => {
  const result = rewriteImageSources('<p>左<img src="https://mmbiz.qpic.cn/a.gif">右</p><p><img src="https://mmbiz.qpic.cn/a.gif"></p>', new Map([['https://mmbiz.qpic.cn/a.gif', 'https://i0.hdslb.com/bfs/article/a.gif']]));
  assert.equal(doc(result).querySelectorAll('img[src="https://i0.hdslb.com/bfs/article/a.gif"]').length, 2);
  assert.equal(doc(result).querySelector('p').textContent, '左右');
});

test('script metadata parsing never executes scripts and supports escaped covers and collection names', () => {
  globalThis.articleScriptRan = false;
  const result = parseArticle(`<script>articleScriptRan = true; var msg_cdn_url='https:\\/\\/mmbiz.qpic.cn\\/cover.jpg?x=1\\x26y=2'; var album_name='正经玩';</script><div id="js_content"><p>正文</p></div>`);
  assert.equal(globalThis.articleScriptRan, false);
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover.jpg?x=1&y=2');
  assert.deepEqual(result.collectionNames, ['正经玩']);
});

test('does not mistake unrelated CDN variables for the article cover', () => {
  const result = parseArticle('<head><meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg"><script>var avatar_cdn_url="https://mmbiz.qpic.cn/avatar.jpg";</script></head><body><div id="js_content"><p>正文</p></div></body>');
  assert.equal(result.coverUrl, 'https://mmbiz.qpic.cn/cover.jpg');
});

test('reports background images rather than silently losing them during style cleanup', () => {
  const result = cleanArticle('<section style="background-image:url(https://mmbiz.qpic.cn/bg.png)"><p>正文</p></section>');
  assert.match(result.html, /正文/);
  assert.match(result.html, /background-image/);
  assert.match(result.html, /data-sync-background-url/);
  assert.match(result.blockingIssues.join(' '), /CSS 背景图/);
});

test('saved article collection DOM and local image mapping are retained', () => {
  const result = parseArticle('<!-- saved from url=(0049)https://mp.weixin.qq.com/s/example --><div class="album_name_title">#正经玩</div><span class="js_album_directory__name">正经玩 · 目录</span><div id="js_content"><p><img data-src="https://mmbiz.qpic.cn/a.gif" src="./文章_files/640"></p><p><img src="./文章_files/640(1)"></p></div>');
  assert.equal(result.sourceUrl, 'https://mp.weixin.qq.com/s/example');
  assert.deepEqual(result.collectionNames, ['正经玩']);
  assert.deepEqual(result.localAssets, [{sourceUrl:'https://mmbiz.qpic.cn/a.gif',localPath:'文章_files/640'},{sourceUrl:`localasset:///${encodeURIComponent('文章_files/640(1)')}`,localPath:'文章_files/640(1)'}]);
  assert.ok(result.blockingIssues.some(issue=>issue.includes('本地资源目录')));
  assert.equal(cleanArticle(result.html).localAssets.length,2);
});

test('removes known empty editor shells but retains real formula source and SVG', () => {
  const result = cleanArticle('<p><img class="rich_pages wxw-img"><svg viewBox="0 0 1 1"></svg></p><p><span data-formula="x^2"><span data-formula="x^2"><svg viewBox="0 0 20 20"><path d="M0 0L10 10"/></svg></span></span></p>');
  assert.equal(result.stats.removedImagePlaceholders,1);
  assert.equal(result.stats.removedEmptySvg,1);
  assert.equal(result.stats.formulas,1);
  assert.equal(doc(result.html).querySelectorAll('[data-formula]').length,2);
  assert.deepEqual(result.blockingIssues,[]);
});

test('never invents LaTeX source from an image class or alternative text', () => {
  const result = cleanArticle('<p><img class="latex math" src="https://mmbiz.qpic.cn/formula.png" alt="公式图片说明"><img class="equation" src="https://mmbiz.qpic.cn/another.png"></p>');
  const document = doc(result.html);
  assert.equal(document.querySelectorAll('[data-formula],[data-latex]').length,0);
  assert.equal(document.querySelectorAll('img[data-sync-formula-image]').length,2);
  assert.equal(result.stats.formulas,2);
  assert.equal(cleanArticle(result.html).stats.formulas,2);
  assert.equal(document.querySelector('img').getAttribute('alt'),'公式图片说明');
});

test('removing a link retains its own color, bold and nested image without an active destination',()=>{
  const result=cleanArticle('<p><a href="https://example.test" onclick="bad()" style="color:#e03040;font-weight:700;text-decoration:underline;position:fixed">链接内<strong>文字</strong><img src="https://mmbiz.qpic.cn/p.png"></a> <a href="https://example.test/plain">普通链接</a></p>');
  const document=doc(result.html);
  const span=document.querySelector('p > span');
  assert.equal(span.style.color,'rgb(224, 48, 64)');
  assert.equal(span.style.fontWeight,'700');
  assert.equal(span.style.textDecoration,'underline');
  assert.equal(span.style.position,'');
  assert.equal(span.querySelector('img').getAttribute('src'),'https://mmbiz.qpic.cn/p.png');
  assert.equal(document.querySelectorAll('a,[href],[onclick]').length,0);
  assert.match(document.body.textContent,/普通链接/);
  assert.equal(result.stats.removedLinks,2);
});
