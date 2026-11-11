import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {findRasterTargets,assertStaticAsset,prepareForNative} from '../extension/lib/raster.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const parse = html => new DOMParser().parseFromString(html,'text/html');

test('selects only inline image paragraphs, not independent images or explicit formulas', () => {
  const doc=parse('<section><p id="inline">一句话<span><img src="a"></span>结束</p><p id="standalone"><img src="b"></p><p id="formula">式子<span data-formula="x^2"><svg><path/></svg></span></p><p id="block">说明<img src="c" style="display:block"></p></section>');
  assert.deepEqual(findRasterTargets(doc).map(n=>n.id),['inline']);
});

test('merges overlapping targets and includes tables and genuine unknown graphics', () => {
  const doc=parse('<section id="background" data-sync-background-url="x"><p>文字<img src="a"></p><table><tr><td>内容</td></tr></table></section><p id="graphic">文字<svg><path/></svg></p><table id="table"><tr><td>表格</td></tr></table>');
  assert.deepEqual(findRasterTargets(doc).map(n=>n.id),['background','graphic','table']);
});

test('inline backgrounds select their complete text paragraph to avoid invalid nested paragraphs',()=>{
  const doc=parse('<p id="whole">前<span data-sync-background-url="x">纹理文字</span>后</p><p>下一段保持原生</p>');
  assert.deepEqual(findRasterTargets(doc).map(node=>node.id),['whole']);
});

test('root-level inline text and images are also detected',()=>{
  const doc=parse('文字<img src="a">继续');
  assert.deepEqual(findRasterTargets(doc),[doc.body]);
});

test('standalone SVG retains its paragraph alignment during local rendering',()=>{
  const doc=parse('<p id="shape" style="text-align:center"><svg viewBox="0 0 20 20"><path></path></svg></p>');
  assert.deepEqual(findRasterTargets(doc).map(node=>node.id),['shape']);
});

test('captures a flex heading and its negative-margin accent as one centered local block',()=>{
  const doc=parse('<section style="text-align:center"><section id="heading-box" style="display:inline-block;padding:0 6px"><section style="display:flex"><section style="height:35px"><p><strong>实验器材</strong></p></section><section id="accent" data-sync-background-url="x" style="width:20px;height:25px;margin-top:-14px"><br></section></section></section><p id="body">正文仍为原生</p></section>');
  const targets=findRasterTargets(doc);
  assert.deepEqual(targets.map(node=>node.id),['heading-box']);
  assert.equal(targets[0].textContent,'实验器材');
  assert.equal(targets[0].contains(doc.getElementById('body')),false);
});

test('does not promote an accent into a broad flex article or a heading with images or formulas',()=>{
  for(const content of ['<p>第一段</p><p>第二段</p>', '<p>标题<img src="animation.gif"></p>', '<p>标题<span data-formula="x^2"></span></p>', `<p>${'长文'.repeat(100)}</p>`]) {
    const doc=parse(`<section style="display:flex"><section>${content}</section><section id="accent" data-sync-background-url="x" style="margin-top:-14px;height:25px"></section></section>`);
    const targets=findRasterTargets(doc);
    assert.ok(targets.every(node=>node.id==='accent' || node.tagName==='P'));
    assert.equal(targets.some(node=>node.tagName==='SECTION'&&node.id!=='accent'),false);
  }
});

for(const mime of ['image/gif','image/png','image/webp']) {
  test(`refuses animated ${mime} instead of converting it into a still image`, async()=>{
    const source='<p>保留动画<img src="https://mmbiz.qpic.cn/animation"></p>';
    let renders=0;
    const result=await prepareForNative(source,{downloadImageImpl:async()=>({mime,animated:true,frames:4,width:100,height:100}),renderImpl:async()=>{renders++;}});
    assert.equal(result.rasterized,0);
    assert.equal(renders,0);
    assert.match(result.blockingIssues.join(' '),/动图/);
    assert.equal(result.html,source);
  });
}

test('checks animation frames even when the MIME type and animation flag are wrong',()=>{
  assert.throws(()=>assertStaticAsset({mime:'image/png',animated:false,frames:2,width:10,height:10}),/动图/);
  assert.doesNotThrow(()=>assertStaticAsset({mime:'image/gif',animated:false,frames:1,width:10,height:10}));
});

test('preserves the complete original local block if image download fails',async()=>{
  const html='<section data-sync-background-url="https://mmbiz.qpic.cn/bg.png"><p>内容<strong>重点</strong></p></section>';
  const result=await prepareForNative(html,{downloadImageImpl:async()=>{throw new Error('资源缺失');}});
  assert.equal(result.html,html);
  assert.equal(result.rasterized,0);
  assert.match(result.blockingIssues.join(' '),/资源缺失/);
});

test('native-only content requires no renderer and triggers no image downloads',async()=>{
  let calls=0;
  const html='<p>正文<sup>2</sup><span data-formula="a^2"><svg><path></path></svg></span></p><p><img src="https://mmbiz.qpic.cn/a.gif"></p>';
  const result=await prepareForNative(html,{downloadImageImpl:async()=>{calls++;}});
  assert.equal(result.html,html);
  assert.equal(result.rasterized,0);
  assert.equal(calls,0);
  assert.deepEqual(result.blockingIssues,[]);
});

test('untrusted executable properties fail before any resource is read or inserted',async()=>{
  let calls=0;
  const result=await prepareForNative('<p>危险<img src="https://mmbiz.qpic.cn/a.png" onload="bad()"></p>',{downloadImageImpl:async()=>{calls++;}});
  assert.equal(calls,0);
  assert.equal(result.rasterized,0);
  assert.match(result.blockingIssues.join(' '),/可执行属性/);
});
