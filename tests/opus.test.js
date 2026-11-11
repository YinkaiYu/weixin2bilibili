import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toOpus, explicitLatex, nativeImageUrl, analyzeNativeTextBackgrounds, getCompositePageBackground } from '../extension/lib/opus.js';

const document = new JSDOM('').window.document;
const image = 'https://i0.hdslb.com/bfs/new_dyn/picture.gif';
const images = new Map([[image, { width: 400, height: 250, size: 112.5, mime: 'image/gif' }]]);
const convert = html => toOpus(html, { document, images });
const words = result => result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 1).map(n => n.word);
const formulas = result => result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 5).map(n => n.formula.latex_content);

test('composites ancestor alpha backgrounds onto white without including the local block paint', () => {
  const doc=new document.defaultView.DOMParser().parseFromString('<section style="background:rgba(0,0,255,.5)"><div style="background:rgba(255,0,0,.5)"><p id="target" style="background:#00ff00">内容</p></div></section>','text/html');
  assert.equal(getCompositePageBackground(doc.getElementById('target')),'#bf4080');
  assert.equal(getCompositePageBackground(doc.body),'#ffffff');
});

test('does not guess ancestor backgrounds containing unknown colors, images or opacity', () => {
  for(const style of ['background:var(--unknown)','background-image:url(https://example.org/background.png)','background-image:linear-gradient(#000,#fff)','background:#123456;opacity:.5']) {
    const doc=new document.defaultView.DOMParser().parseFromString(`<section style="${style}"><p id="target">内容</p></section>`,'text/html');
    assert.equal(getCompositePageBackground(doc.getElementById('target')),null,style);
  }
});

test('adapts independent light-on-dark headings by structure and contrast across wording, palettes and dimensions', () => {
  const cases=[
    {html:'<h2 style="background:#123456;color:white;padding:1em">A new research direction</h2>',text:'A new research direction',color:'#123456'},
    {html:'<div style="text-align:center"><span style="display:inline-flex;background:rgb(24,80,64);padding:7px 29px"><strong style="font-size:19px;color:#edf8ed">关于未来的开放问题？</strong></span></div>',text:'关于未来的开放问题？',color:'#185040'},
    {html:'<section style="background:#fdf4df"><div><section style="display:inline-block;background:#652b70;width:87%;padding:19px 4px;border-radius:22px"><p style="font-size:26px;color:#fff5fc"><b>Measuring the invisible</b></p></section></div></section>',text:'Measuring the invisible',color:'#652b70'},
    {html:'<div style="width:fit-content;background:hsl(210,60%,25%);color:#fff"><h3><em>第二章：新的结果</em></h3></div>',text:'第二章：新的结果',color:'#1a4066'},
  ];
  for(const example of cases) {
    const result=convert(example.html),converted=words(result);
    assert.deepEqual(result.blockingIssues,[],example.text);
    assert.equal(converted.map(word=>word.words).join(''),example.text);
    for(const word of converted){assert.equal(word.color,example.color);assert.equal(word.style.bold,true);assert.equal(word.bg_style,undefined);}
    assert.deepEqual(result.notices,[{severity:'info',message:'已将浅色字配深色底的独立标题改为背景色加粗文字，保持原生可编辑。'}]);
  }
});

test('does not recolor ordinary paragraphs, inline highlights, multiblock cards or rich media as headings', () => {
  const cases=[
    '<p style="background:#123456;color:white;font-weight:bold">这是一段正文，不是独立标题标签。</p>',
    '<p>正文中的<span style="display:inline-block;background:#123456;color:white;font-weight:bold">强调词</span>仍属于原句。</p>',
    '正文中的<span style="display:inline-block;background:#123456;color:white;font-weight:bold">强调词</span>仍属于原句。',
    `<img src="${image}"><span style="display:inline-block;background:#123456;color:white;font-weight:bold">配图标签</span>`,
    `<span style="display:inline-block;background:#123456;color:white;font-weight:bold">配图标签</span><img src="${image}">`,
    '<section style="display:inline-block;background:#123456;color:white"><p><b>开头</b></p><p><b>说明文字</b></p></section>',
    `<h2 style="background:#123456;color:white">实验图<img style="display:block" src="${image}"></h2>`,
    '<h2 style="background:#123456;color:white">关系式 <span data-formula="x^2"></span></h2>',
    '<section style="display:inline-block;background:#123456;color:white;font-weight:bold">'+ '这段内容需要完整保留，'.repeat(30)+'</section>',
  ];
  for(const html of cases){const result=convert(html);assert.ok(result.blockingIssues.length);assert.equal(result.notices.length,0);assert.ok(words(result).some(word=>word.color==='#ffffff'));}
  const readable=convert('<p style="background:#eee;color:#222">普通正文</p><p><mark>黄色高亮</mark></p>');
  assert.deepEqual(readable.blockingIssues,[]);assert.equal(readable.notices.length,0);
  assert.equal(words(readable)[0].color,'#222222');assert.equal(words(readable)[0].bg_style.color.color,'#eeeeee');
  assert.equal(words(readable)[1].bg_style.color.color,'#ffff00');
});

test('requires solid uniform colors and readable original and destination contrast before adapting a heading', () => {
  for(const html of [
    '<h2 style="background:#ddd;color:white">原始对比不足</h2>',
    '<section style="background:#111"><h2 style="background:#123456;color:white">转成深色后无法衬底</h2></section>',
    '<h2 style="background:rgba(18,52,86,.7);color:white">半透明底</h2>',
    '<h2 style="background:linear-gradient(#123456,#325678);color:white">渐变底</h2>',
    '<h2 style="background:#123456;color:white">不同颜色<span style="color:#fff0ab">各有含义</span></h2>',
    '<h2 style="background:#123456;color:white">局部高亮<span style="background:#631a50">不能清除</span></h2>',
    '<h2 style="background:#123456;color:white;opacity:.6">透明标题</h2>',
  ]){const result=convert(html);assert.equal(result.notices.length,0);assert.ok(result.blockingIssues.some(message=>message.includes('完整背景')));}
});

test('background analysis is read-only and exposes exact background owners for the renderer', () => {
  const doc=new document.defaultView.DOMParser().parseFromString('<h2 style="background:#124065;color:white">可编辑标题</h2><section id="card" style="background:#124065"><p><span id="ink" style="color:white">正文保持原样</span></p></section>','text/html');
  const before=doc.body.innerHTML,plan=analyzeNativeTextBackgrounds(doc);
  assert.equal(doc.body.innerHTML,before);
  assert.equal(plan.headings.length,1);assert.equal(plan.headings[0].element,doc.querySelector('h2'));assert.equal(plan.headings[0].color,'#124065');
  assert.equal(plan.unsupported.length,1);assert.equal(plan.unsupported[0].element,doc.getElementById('ink'));assert.equal(plan.unsupported[0].backgroundElement,doc.getElementById('card'));
  assert.equal(plan.unsupported[0].reason,'full-background-required');
  const subtree=analyzeNativeTextBackgrounds(doc.getElementById('ink'));
  assert.equal(subtree.unsupported.length,1);assert.equal(subtree.unsupported[0].backgroundElement,doc.getElementById('card'));
  const gray=new document.defaultView.DOMParser().parseFromString('<p id="dark" style="background:#111;color:#aaa">中灰文字依赖深底</p><p style="background:#f8f8f0;color:#888">浅底灰字不因移除底色变淡</p>','text/html');
  assert.deepEqual(analyzeNativeTextBackgrounds(gray).unsupported.map(item=>item.element.id),['dark']);
});

test('background analysis exposes formulas and script bases that need local rendering without flattening readable prose', () => {
  const doc=new document.defaultView.DOMParser().parseFromString('<section id="card" style="background:#e8f0fe"><p>可编辑正文</p><p><span id="formula" data-formula="x^2"><svg></svg></span></p><p>x<sub id="script">1</sub></p></section><p><span id="base" style="background:#ffcc00">F</span><sub id="local-script">peak</sub></p><p>x<sup id="nested-script"><b style="background:#ccddff">2</b></sup></p><section style="background:#fff"><p><span data-formula="y^2"></span>x<sup>2</sup></p></section>','text/html');
  const before=doc.body.innerHTML,plan=analyzeNativeTextBackgrounds(doc);
  assert.equal(doc.body.innerHTML,before);
  assert.deepEqual(plan.unsupported.map(item=>[item.element.id,item.reason]),[['formula','formula-background'],['script','formula-background'],['local-script','formula-background'],['nested-script','formula-background']]);
  assert.equal(plan.unsupported[0].backgroundElement,doc.getElementById('card'));
  assert.equal(plan.unsupported[1].backgroundElement,doc.getElementById('card'));
  assert.equal(plan.unsupported[2].backgroundElement,doc.getElementById('base'));
  assert.equal(plan.unsupported[3].backgroundElement,doc.querySelector('#nested-script b'));
  const separate=convert('<p><span style="background:#ffcc00">F</span></p><p><sub>peak</sub></p>');
  assert.deepEqual(separate.blockingIssues,[],'a preceding paragraph is not a script base');
});

test('retains only marked source links using native link nodes and preserves nested supported styles', () => {
  const url='https://example.org/original?lang=en#source';
  const r=convert(`<p style="color:#3e3e3e;font-size:15px">原文链接：<a data-sync-source-link="true" href="${url}">Original <strong>bold <em>italic</em></strong><span style="font-size:13px;text-decoration:underline line-through">small</span></a>。<a href="https://example.org/unrelated">普通外链</a></p>`);
  assert.deepEqual(r.blockingIssues,[]);
  const links=r.content.paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.node_type===4).map(n=>n.link);
  assert.deepEqual(links.map(link=>link.show_text),['Original ','bold ','italic','small']);
  assert.ok(links.every(link=>link.link===url&&link.link_type===16&&link.style.font_size===0));
  assert.equal(links[1].style.bold,true);assert.equal(links[2].style.italic,true);assert.equal(links[2].style.bold,true);
  assert.equal(links[3].style.font_level,'small');assert.equal(links[3].style.underline,true);assert.equal(links[3].style.strikethrough,true);
  assert.deepEqual(r.sourceLinks,[url]);
  assert.ok(r.notices.some(item=>item.severity==='info'&&item.message.includes('原生链接颜色')));
  assert.ok(words(r).some(word=>word.words.includes('普通外链')));
});

test('source links reject unsafe URLs and preserve unsupported semantic/color content with copyable URLs', () => {
  for(const href of ['javascript:alert(1)','https://user:password@example.org/a']) {
    const r=convert(`<p><a data-sync-source-link="true" href="${href}">出处</a></p>`);
    assert.ok(r.blockingIssues.some(issue=>issue.includes('地址无效')));assert.deepEqual(r.sourceLinks,[]);
  }
  const scripted=convert('<p><a data-sync-source-link="true" href="https://example.org">E=mc<sup>2</sup></a></p>');
  assert.deepEqual(scripted.blockingIssues,[]);
  assert.ok(scripted.warnings.some(issue=>issue.includes('上下标')));
  assert.equal(formulas(scripted).length,1,'unsupported link must not silently flatten the exponent');
  assert.deepEqual(scripted.sourceLinks,[]);
  assert.deepEqual(scripted.requestedSourceLinks,['https://example.org/']);
  assert.ok(words(scripted).some(word=>word.words.includes('https://example.org/')));
  const colored=convert('<p><a data-sync-source-link="true" href="https://example.org" style="color:#ff0000">红色原文</a></p>');
  assert.deepEqual(colored.blockingIssues,[]);
  assert.ok(colored.warnings.some(issue=>issue.includes('自定义文字颜色')));
  assert.equal(words(colored)[0].color,'#ff0000');assert.deepEqual(colored.sourceLinks,[]);
});

test('only validated source URLs become links; rejected, failed and missing results retain copyable complete URLs', () => {
  const url='https://example.org/original?lang=en#source';
  const html=`<p>原文：<a data-sync-source-link="true" href="${url}"><strong>来源标题</strong></a></p>`;
  const accepted=toOpus(html,{document,sourceLinkValidation:{accepted:[url]}});
  assert.deepEqual(accepted.sourceLinks,[url]);
  assert.ok(accepted.content.paragraphs[0].text.nodes.some(node=>node.node_type===4));
  for (const validation of [{rejected:[url]},{failed:[url]},{accepted:[]}]) {
    const result=toOpus(html,{document,sourceLinkValidation:validation});
    assert.deepEqual(result.blockingIssues,[]);assert.deepEqual(result.sourceLinks,[]);assert.deepEqual(result.requestedSourceLinks,[url]);
    assert.ok(result.content.paragraphs.every(p=>p.text?.nodes.every(node=>node.node_type!==4)));
    const text=words(result).map(word=>word.words).join('');
    assert.ok(text.includes('来源标题'));assert.equal(text.split(url).length-1,1);assert.ok(result.warnings.some(warning=>warning.includes('完整网址')));
  }
  const raw=toOpus(`<p><a data-sync-source-link="true" href="${url}">${url}</a></p>`,{document,sourceLinkValidation:{rejected:[url]}});
  assert.equal(words(raw).map(word=>word.words).join(''),url,'an already visible source URL is not duplicated');
});

test('a similar visible URL does not hide the actual source destination during fallback', () => {
  const url='https://example.org/paper',label=url+'-v2';
  for(const validation of [{rejected:[url]},{failed:[url]}]){
    const result=toOpus(`<p>原文链接：<a data-sync-source-link="true" href="${url}">${label}</a></p>`,{document,sourceLinkValidation:validation});
    assert.equal(words(result).map(word=>word.words).join(''),`原文链接：${label}（${url}）`);
    assert.deepEqual(result.sourceLinks,[]);
  }
});

test('a marked source link inside a figure caption is not consumed as a plain native image comment', () => {
  const r=convert(`<figure><img src="${image}"><figcaption style="color:#888;font-size:13px">原文：<a href="https://example.org/" data-sync-source-link="true">出处</a></figcaption></figure>`);
  assert.deepEqual(r.blockingIssues,[]);
  assert.equal(r.content.paragraphs[0].pic.pics[0].comment,undefined);
  assert.deepEqual(r.requestedSourceLinks,['https://example.org/']);
  assert.ok(r.content.paragraphs.flatMap(p=>p.text?.nodes||[]).some(n=>n.node_type===4&&n.link.show_text==='出处'));
});

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

test('maps wrapped figure captions to each native picture without duplicate body text', () => {
  const r = convert(`<section style="background-color:white"><p>前文</p><figure><section><p><span><img src="${image}"></span></p></section><figcaption style="font-size:14px;color:#888;text-align:center">图一：实验装置</figcaption></figure><figure><img src="${image}"><figcaption>图二：实验结果</figcaption></figure><p>后文</p></section>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(p => p.para_type), [1, 2, 2, 1]);
  assert.deepEqual(r.content.paragraphs.filter(p => p.pic).map(p => p.pic.pics[0].comment), ['图一：实验装置', '图二：实验结果']);
  assert.equal(words(r).map(w => w.words).join(''), '前文后文');
  assert.equal(r.summary, '前文图一：实验装置图二：实验结果后文');
  assert.equal(r.stats.characters, r.summary.length);
  assert.equal(r.stats.images, 2);
});

test('uses visible caption over old image metadata and treats captions as plain text', () => {
  const r = convert(`<figure><img src="${image}" data-caption="旧说明"><figcaption>\u200b 图 A &amp; B <span>说明</span><br>第二行 <span>&lt;标签&gt;</span></figcaption></figure>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(r.content.paragraphs.length, 1);
  assert.equal(r.content.paragraphs[0].pic.pics[0].comment, '图 A & B 说明 第二行 <标签>');
  assert.deepEqual(r.warnings, []);
});

test('keeps emphasized or colored captions as native body text with formatting intact', () => {
  const r = convert(`<figure><img src="${image}"><figcaption style="color:#888"><strong>重点</strong><span style="color:#ff0000">红字</span><u>下划线</u></figcaption></figure><section style="color:#124578"><figure><img src="${image}"><figcaption>继承彩色</figcaption></figure></section>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(p => p.para_type), [2, 1, 2, 1]);
  assert.ok(r.content.paragraphs.filter(p => p.pic).every(p => !p.pic.pics[0].comment));
  const w = words(r);
  assert.equal(w[0].style.bold, true);
  assert.equal(w[1].color, '#ff0000');
  assert.equal(w[2].style.underline, true);
  assert.equal(w[3].color, '#124578');
  assert.ok(r.warnings.some(warning => warning.includes('含强调样式或彩色文字')));
});

test('uses native captions for the ordinary warm and cool gray source templates', () => {
  const r = convert(`<figure><img src="${image}"><figcaption style="color:rgb(134,122,114)">暖灰图注</figcaption></figure><figure><img src="${image}"><figcaption style="color:rgb(107,117,113)">冷灰图注</figcaption></figure>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(p => p.pic.pics[0].comment), ['暖灰图注', '冷灰图注']);
});

test('retains long and semantic captions as complete body text instead of clipping or flattening them', () => {
  const long = '注'.repeat(101);
  const r = convert(`<figure><img src="${image}" data-caption="${long}"><figcaption>${long}</figcaption></figure><figure><img src="${image}"><figcaption>面积 m<sup>2</sup>，能量<span data-formula="E=mc^2"><svg></svg></span></figcaption></figure>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(p => p.para_type), [2, 1, 2, 1]);
  assert.ok(r.content.paragraphs.filter(p => p.pic).every(p => !p.pic.pics[0].comment));
  assert.equal(words(r)[0].words, long);
  assert.deepEqual(formulas(r), ['\\text{m}^{\\text{2}}', 'E=mc^2']);
  assert.ok(r.warnings.some(w => w.includes('100 字符')));
  assert.ok(r.warnings.some(w => w.includes('丢失含义')));
});

test('supports the native 100-code-unit caption boundary without truncating data captions', () => {
  const r = convert(`<img src="${image}" data-caption="${'字'.repeat(100)}"><img src="${image}" data-caption="${'😀'.repeat(51)}">`);
  assert.deepEqual(r.blockingIssues, []);
  assert.equal(r.content.paragraphs[0].pic.pics[0].comment.length, 100);
  assert.equal(r.content.paragraphs[1].pic.pics[0].comment, undefined);
  assert.equal(words(r)[0].words, '😀'.repeat(51));
});

test('does not attach a group caption to the wrong picture or consume an orphan caption', () => {
  const r = convert(`<figure><img src="${image}"><img src="${image}"><figcaption>两图对比</figcaption></figure><figcaption>独立说明</figcaption>`);
  assert.deepEqual(r.blockingIssues, []);
  assert.ok(r.content.paragraphs.filter(p => p.pic).every(p => !p.pic.pics[0].comment));
  assert.equal(words(r).map(w => w.words).join(''), '两图对比独立说明');
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

test('converts the confirmed question directory into separate native paragraphs with inline emphasis intact', () => {
  const r = convert('<pre><code><span><strong>问答导航</strong><span><br></span><span style="color:#123456">Q1 第一个问题？</span><span><br></span><span>Q2 第二个<strong>重点</strong>问题？</span><br></span></code></pre><p>正文</p>');
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(r.content.paragraphs.map(p => p.para_type), [1, 1, 1, 1]);
  assert.deepEqual(r.content.paragraphs.map(p => p.text.nodes.map(n => n.word.words).join('')), ['问答导航', 'Q1 第一个问题？', 'Q2 第二个重点问题？', '正文']);
  assert.equal(r.content.paragraphs[0].text.nodes[0].word.style.bold, true);
  assert.equal(r.content.paragraphs[1].text.nodes[0].word.color, '#123456');
  assert.ok(r.content.paragraphs[2].text.nodes.some(n => n.word.words === '重点' && n.word.style.bold));
});

test('keeps genuine code and nonconsecutive question-like content as code, preserving BR newlines', () => {
  for (const html of ['<pre><code class="language-js">问答导航<br>Q1 示例<br>Q2 示例</code></pre>', '<pre><code>问答导航<br>Q1 示例<br>Q3 示例</code></pre>', '<pre><code>const a = 1;<br>const b = 2;</code></pre>']) {
    const r = convert(html);
    assert.equal(r.content.paragraphs.length, 1);
    assert.equal(r.content.paragraphs[0].para_type, 8);
    assert.ok(r.content.paragraphs[0].code.content.includes('\n'));
  }
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

test('keeps native scripts and formulas on ordinary inherited white page backgrounds', () => {
  const r = convert('<section style="background:rgb(255,255,255)"><p>F<sub>peak</sub> 和 F<sub>baseline</sub></p><section style="background-color:white"><span data-formula="x^2"></span></section></section>');
  assert.deepEqual(r.blockingIssues, []);
  assert.deepEqual(formulas(r), ['\\text{F}_{\\text{peak}}', '\\text{F}_{\\text{baseline}}', 'x^2']);
  assert.ok(words(r).every(word => !word.bg_style), '页面白底不能误作每个文字的局部高亮');
});

test('does not mistake local white highlights or a white box over a colored surface for the page background', () => {
  const htmls = [
    '<p><span style="background-color:white">x</span><sup>2</sup></p>',
    '<p>x<sup style="background-color:white">2</sup></p>',
    '<section style="background-color:#ffdd00"><p style="background-color:white">x<sup>2</sup></p></section>',
    '<section style="background-color:#ffdd00"><p style="background-color:transparent">x<sup>2</sup></p></section>',
    '<p><span style="background-color:white" data-formula="x^2"></span></p>',
  ];
  for (const html of htmls) assert.ok(convert(html).blockingIssues.some(issue => issue.includes('背景色')), html);
});

test('preserves a real tinted formula card as an explicit unsupported background instead of erasing it', () => {
  const r = convert('<section style="background-color:#ffffff"><section style="background-color:rgb(252,248,243);color:rgb(130,66,46)">ΔF = F<sub>peak</sub> − F<sub>baseline</sub></section><p>F<sub>peak</sub> 是峰值</p></section>');
  assert.ok(r.blockingIssues.some(issue => issue.includes('背景色')));
  assert.ok(words(r).some(word => word.bg_style?.color?.color === '#fcf8f3'));
  assert.ok(formulas(r).at(-1).includes('peak'), '白色页面上的正文上下标仍可保留原生');
});
