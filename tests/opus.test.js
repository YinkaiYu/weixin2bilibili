import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toOpus, explicitLatex, nativeImageUrl } from '../extension/lib/opus.js';

const document = new JSDOM('').window.document;
const image = 'https://i0.hdslb.com/bfs/new_dyn/picture.gif';
const images = new Map([[image, { width: 400, height: 250, size: 112.5, mime: 'image/gif' }]]);
const convert = html => toOpus(html, { document, images });
const words = result => result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 1).map(n => n.word);
const formulas = result => result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 5).map(n => n.formula.latex_content);

test('preserves nested decorations and exact color, using a native heading for uniform 20px text', () => {
  const r = convert('<section style="color:rgb(208, 18, 46);font-size:20px"><p><strong>粗体<em>斜体</em></strong><u>下划线</u><span style="color:#123456;font-weight:normal">正常</span></p></section>');
  assert.deepEqual(r.blockingIssues, []);
  const w = words(r);
  assert.equal(w.map(x => x.words).join(''), '粗体斜体下划线正常');
  assert.equal(w[0].color, '#d0122e');
  assert.equal(w[0].font_size, 20);
  assert.equal(w[0].font_level, 'large');
  assert.equal(r.content.paragraphs[0].format.heading_type, 3);
  assert.equal(w[0].style.bold, true);
  assert.equal(w[1].style.italic, true);
  assert.equal(w[1].style.bold, true);
  assert.equal(w[2].style.underline, true);
  assert.equal(w[3].color, '#123456');
  assert.equal(w[3].style.bold, undefined);
  assert.ok(r.warnings.some(x => x.includes('标题样式')));
});

test('maps unsupported paragraph font sizes to native 13/17 with one explicit warning', () => {
  const r = convert('<p><span style="font-size:14px">甲</span><span style="font-size:16px">乙</span><span style="font-size:20px">丙</span><span style="font-size:24px">丁</span><span style="font-size:13px">戊</span><span style="font-size:17px">己</span></p>');
  assert.deepEqual(words(r).map(w => [w.font_size, w.font_level]), [[13, 'small'], [17, 'regular'], [17, 'regular'], [17, 'regular'], [13, 'small'], [17, 'regular']]);
  assert.equal(r.content.paragraphs[0].para_type, 1);
  assert.equal(r.warnings.length, 1);
  for (const conversion of ['14→13', '16→17', '20→17', '24→17']) assert.ok(r.warnings[0].includes(conversion));
});

test('uses native heading levels only for separate paragraphs with uniform large text', () => {
  const r = convert('<section style="font-size:24px"><p>甲</p><p>乙</p></section><p style="font-size:22px">丙</p><p><span style="font-size:20px">丁</span></p>');
  assert.equal(r.content.paragraphs.length, 4);
  assert.deepEqual(r.content.paragraphs.map(p => [p.para_type, p.format.heading_type]), [[9, 1], [9, 1], [9, 2], [9, 3]]);
  assert.deepEqual(words(r).map(w => [w.font_size, w.font_level]), [[24, 'xxLarge'], [24, 'xxLarge'], [22, 'xLarge'], [20, 'large']]);
  assert.equal(r.warnings.length, 1);
});

test('does not assign heading levels inside quotes or lists and adapts h4-h6 explicitly', () => {
  const r = convert('<blockquote><p style="font-size:24px">甲</p></blockquote><ul><li style="font-size:20px">乙</li></ul><h4>丙</h4><h5>丁</h5><h6>戊</h6><h1 style="font-size:16px">己</h1>');
  assert.deepEqual(r.content.paragraphs.map(p => p.para_type), [4, 6, 1, 1, 1, 1]);
  assert.deepEqual(words(r).map(w => [w.font_size, w.font_level]), [[17, 'regular'], [17, 'regular'], [17, 'regular'], [17, 'regular'], [13, 'small'], [17, 'regular']]);
  assert.equal(r.warnings.length, 1);
});

test('retains exact supported paragraph sizes including inherited relative units without warnings', () => {
  const r = convert('<section style="font-size:13px"><p><span style="font-size:100%">甲</span></p></section><p style="font-size:12.75pt">乙</p>');
  assert.deepEqual(words(r).map(w => [w.font_size, w.font_level]), [[13, 'small'], [17, 'regular']]);
  assert.deepEqual(r.warnings, []);
});

test('sets the official white theme explicitly so native editing cannot reinterpret white as black', () => {
  const r = convert('<p><span style="color:#fff;background-color:#fff">甲</span><span style="color:white">乙</span><span style="color:rgb(255,255,255)">丙</span><span style="color:#fefefe">丁</span></p>');
  const w = words(r);
  for (const word of w.slice(0, 2)) {
    assert.equal(word.color, '#ffffff');
    assert.equal(word.dark_color, '#17181A');
    assert.equal(word.bili_theme, 'Wh0');
  }
  assert.deepEqual(w[0].bg_style.color, { color: '#ffffff', dark_color: '#17181A', bili_theme: 'Wh0' });
  assert.equal(w.at(-1).color, '#fefefe');
  assert.equal(w.at(-1).bili_theme, undefined);
});

test('preserves images in original order without changing GIF metadata or size units', () => {
  const r = convert(`<p>前文</p><p><img src="${image}"></p><p>后文</p>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(x => x.para_type), [1, 2, 1]);
  assert.deepEqual(r.content.paragraphs[1].pic.pics[0], { url: image, width: 400, height: 250, size: 112.5 });
  assert.equal(r.stats.images, 1);
});

test('uses outer formula metadata and does not duplicate SVG or nested formulas', () => {
  const r = convert('<p>其中<span data-formula="E=mc^2"><span data-formula="E=mc^2"><svg><path d="M1 1"></path></svg></span></span>成立。</p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(formulas(r), ['E=mc^2']);
  assert.equal(r.stats.formulas, 1);
  assert.equal(words(r).map(x => x.words).join(''), '其中成立。');
  assert.deepEqual(r.content.paragraphs[0].text.nodes.map(n => n.node_type), [1, 5, 1]);
});

test('converts typed LaTeX images to native inline formula without moving the formula', () => {
  const r = convert(`<p>能量为<img src="${image}" type="latex" alt="E%3Dmc%5E2">。</p>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(r.content.paragraphs.length, 1);
  assert.deepEqual(formulas(r), ['E=mc^2']);
  assert.equal(r.stats.formulaImages, 1);
  assert.equal(r.stats.images, 0);
});

test('retains superscript and subscript on the same chemical or mathematical base', () => {
  const r = convert('<p>水是 H<sub>2</sub>O，指标 x<sub>i</sub><sup>2</sup>，参考文献<sup>[1]</sup>。</p>');
  assert.deepEqual(r.blockingIssues, []);
  const f = formulas(r);
  assert.equal(f.length, 3);
  assert.equal(f[0], '\\text{H}_{\\text{2}}');
  assert.equal(f[1], '\\text{x}_{\\text{i}}^{\\text{2}}');
  assert.equal(f[2], '{}^{\\text{[1]}}');
  assert.equal(r.stats.superscripts, 2);
  assert.equal(r.stats.subscripts, 2);
  assert.ok(r.warnings.some(x => x.includes('原生行内公式')));
  assert.equal(JSON.stringify(r).includes('__scriptFormula'), false);
  assert.ok(r.summary.includes('H2O'));
});

test('escapes text in superscripts as data rather than executable LaTeX commands', () => {
  const r = convert('<p>x<sup>\\input{abc}% &amp; #</sup></p>');
  assert.ok(formulas(r)[0].includes('\\textbackslash{}input\\{abc\\}\\%'));
  assert.ok(!formulas(r)[0].includes('\\input{abc}'));
});

test('preserves native text alignment, headings and block quote paragraphs', () => {
  const r = convert('<h2 style="text-align:center">标题</h2><blockquote><p>引用</p></blockquote>');
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(r.content.paragraphs[0].para_type, 9);
  assert.equal(r.content.paragraphs[0].format.heading_type, 2);
  assert.equal(r.content.paragraphs[0].format.align, 1);
  assert.equal(r.content.paragraphs[0].text.nodes[0].word.font_size, 22);
  assert.equal(r.content.paragraphs[1].para_type, 4);
});

test('preserves list hierarchy and continuous list grouping', () => {
  const r = convert('<ol start="3"><li>一<ul><li>子项</li></ul></li><li>二</li></ol>');
  assert.deepEqual(r.blockingIssues, []);
  const p = r.content.paragraphs;
  assert.deepEqual(p.map(x => x.para_type), [5, 6, 5]);
  assert.deepEqual(p.map(x => x.format.list_format.level), [1, 2, 1]);
  assert.equal(p[0].format.list_format.order, 3);
  assert.equal(p[2].format.list_format.order, 4);
  assert.equal(p[0].format.combine_hash, p[2].format.combine_hash);
  assert.notEqual(p[0].format.combine_hash, p[1].format.combine_hash);
});

test('preserves code block whitespace and native line breaks', () => {
  const r = convert('<p>第一行<br>第二行</p><pre><code class="language-js">a\n  b</code></pre><hr>');
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(words(r).map(x => x.words).join(''), '第一行\n第二行');
  assert.deepEqual(r.content.paragraphs[1], { para_type: 8, code: { lang: 'js', content: 'a\n  b' } });
  assert.equal(r.content.paragraphs[2].para_type, 3);
});

test('blocks inline bitmap formulas with no LaTeX rather than silently changing placement', () => {
  const r = convert(`<p>公式为<img src="${image}">，见上式。</p>`);
  assert.ok(r.blockingIssues.some(x => x.includes('行内图片')));
  const block = convert(`<p>前文<img src="${image}" style="display:block">后文</p>`);
  assert.deepEqual(block.blockingIssues, []);
});

test('blocks foreign image hosts, deceptive suffixes and missing metadata', () => {
  assert.equal(nativeImageUrl('https://i0.hdslb.com.evil.test/pic.png'), false);
  assert.equal(nativeImageUrl('https://evil-hdslb.com/pic.png'), false);
  assert.equal(nativeImageUrl('javascript:alert(1)'), false);
  assert.equal(nativeImageUrl('https://i0.hdslb.com/bfs/a.png'), true);
  const r = convert('<p><img src="https://mmbiz.qpic.cn/pic.gif"></p>');
  assert.ok(r.blockingIssues.some(x => x.includes('未上传到 B 站')));
  assert.ok(r.blockingIssues.some(x => x.includes('尺寸')));
});

test('blocks unsupported rich content and empty article', () => {
  const r = convert('<p>前文</p><table><tr><td>表格</td></tr></table><svg></svg><video></video>');
  assert.ok(r.blockingIssues.some(x => x.includes('table')));
  assert.ok(r.blockingIssues.some(x => x.includes('svg')));
  assert.ok(r.blockingIssues.some(x => x.includes('video')));
  assert.ok(convert('<p><br></p>').blockingIssues.some(x => x.includes('没有可同步')));
});

test('renders marked background as native background while preserving exact native color', () => {
  const r = convert('<p><mark>重点</mark><span style="color:#09f;background-color:rgb(240,240,240)">文字</span></p>');
  assert.deepEqual(r.blockingIssues, []);
  const w = words(r);
  assert.equal(w[0].bg_style.color.color, '#ffff00');
  assert.equal(w[1].color, '#0099ff');
  assert.equal(w[1].bg_style.color.color, '#f0f0f0');
});

test('passes formula color and bold into native LaTeX instead of discarding them', () => {
  const r = convert('<p><b style="color:#d0122e"><span data-formula="x^2"><svg></svg></span></b></p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(formulas(r)[0], '\\color{#d0122e}{\\boldsymbol{x^2}}');
});

test('preserves translucent text color as the CSS string accepted by the current native converter', () => {
  const r = convert('<p style="color:rgba(0,0,0,0.9)">午后，困意袭来。</p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(words(r)[0].color, 'rgba(0, 0, 0, 0.9)');
});

test('blocks translucent colors on native formulas instead of generating invalid TeX color syntax', () => {
  for (const h of ['<p style="color:rgba(0,0,0,.9)">x<sub>2</sub></p>', '<section style="color:rgba(0,0,0,.9)" data-formula="x^2"><svg></svg></section>']) {
    const r = convert(h);
    assert.ok(r.blockingIssues.some(x => x.includes('有效 LaTeX 颜色')));
    assert.ok(formulas(r).every(f => !f.includes('rgba(')));
  }
});

test('converts a formula on the block itself rather than traversing rendered SVG children', () => {
  const r = convert('<section data-formula="\\frac{a}{b}"><svg><text>ab</text></svg></section><p>正文</p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(formulas(r), ['\\frac{a}{b}']);
  assert.equal(words(r).map(w => w.words).join(''), '正文');
});

test('conserves every text run and repeated image occurrence across nested wrappers and block boundaries', () => {
  const r = convert(`<section>甲<p>乙<strong>丙</strong>丁</p><div><p><img src="${image}"></p><p>戊<br>己</p><p><img src="${image}"></p></div>庚</section>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(words(r).map(w => w.words).join(''), '甲乙丙丁戊\n己庚');
  assert.equal(r.stats.images, 2);
  assert.deepEqual(r.content.paragraphs.filter(p => p.pic).flatMap(p => p.pic.pics.map(x => x.url)), [image, image]);
});

test('recognizes the sanitizer unsupported marker and does not silently publish its placeholder as content', () => {
  const r = convert('<p>正文</p><span data-sync-unsupported="video">[视频]</span>');
  assert.ok(r.blockingIssues.some(x => x.includes('span')));
});

test('preserves every supported decoration when absorbing the preceding base into a script formula', () => {
  const r = convert('<p><u><b><i style="color:#d0122e">x</i></b></u><sup>2</sup>继续</p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(formulas(r)[0], '\\color{#d0122e}{\\underline{\\mathit{\\boldsymbol{\\text{x}}}}}^{\\text{2}}');
  assert.equal(words(r).map(w=>w.words).join(''), '继续');
});

test('blocks strike or background on an absorbed base instead of dropping it or replacing it with diagonal cancellation', () => {
  for (const [html, reason] of [
    ['<p><s>x</s><sup>2</sup></p>', '删除线'],
    ['<p><mark>x</mark><sub>i</sub></p>', '背景色'],
    ['<p><span style="color:rgba(0,0,0,.5)">x</span><sup style="color:red">2</sup></p>', '有效 LaTeX 颜色'],
    ['<p>x<sup><s>2</s></sup></p>', '删除线'],
    ['<p>x<sub><mark>i</mark></sub></p>', '背景色'],
  ]) {
    const r = convert(html);
    assert.ok(r.blockingIssues.some(x=>x.includes(reason)), reason);
    assert.ok(formulas(r).every(x=>!x.includes('\\cancel')));
  }
});
