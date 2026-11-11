import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseArticle } from '../extension/lib/article.js';
import { findRasterTargets } from '../extension/lib/raster.js';
import { toOpus } from '../extension/lib/opus.js';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '测试文章');
const document = new JSDOM('').window.document;
const cases = [
  { name: '不抽血不拍片，闻一闻就能接收身体警报？？？.html', raster: 0, images: 3, formulas: 0, captions: 1 },
  { name: '为什么只睡20分钟，下午就能精神满满？_ No. 537.html', raster: 0, images: 7, formulas: 26, captions: 3 },
  { name: '你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', raster: 1, images: 16, formulas: 11, captions: 4 },
  { name: '摸了半天找不到头，胶带却记得你撕到哪儿？.html', raster: 0, images: 12, formulas: 4, captions: 9 },
  { name: '要宣布翻篇了？那我磁化损失呢，厉娜.html', raster: 0, images: 21, formulas: 0, captions: 19 },
];

// Structural integration only: local HTML -> actual raster target selection ->
// mocked completed raster blocks/uploads -> actual native converter. No network,
// page script execution, canvas output, or real Bilibili writes take place here.
for (const sample of cases) {
  const filename = path.join(directory, sample.name);
  test(`native structural integration with mock raster/upload: ${sample.name}`, { skip: !fs.existsSync(filename) && '用户本地样稿未附带。' }, () => {
    const source = parseArticle(fs.readFileSync(filename, 'utf8'), { document });
    const doc = new document.defaultView.DOMParser().parseFromString(source.html, 'text/html');
    const targets = findRasterTargets(doc);
    assert.equal(targets.length, sample.raster);
    if (sample.name.includes('胶带')) {
      const card = [...doc.querySelectorAll('section')].find(el => el.textContent.replace(/\s+/g, '') === 'ΔF=Fpeak−Fbaseline');
      assert.ok(card, '公式文字所在段落必须保留');
      assert.equal(card.style.backgroundColor, '', '已确认的公式卡片容器底色可省');
      assert.equal(card.style.borderTopWidth, '', '已确认的公式卡片装饰边框可省');
      assert.equal(card.style.color, 'rgb(130, 66, 46)', '公式文字颜色不能丢');
      assert.deepEqual([...card.querySelectorAll('sub')].map(el => el.textContent), ['peak','baseline']);
      assert.equal([...doc.querySelectorAll('sub')].filter(el => !card.contains(el)).length, 2, '正文两个下标保留原生');
    }
    if (sample.name.includes('厉娜')) {
      const retained = [...doc.images].map(img => Number(new URL(img.src).hash.match(/imgIndex=(\d+)/)?.[1]));
      assert.deepEqual(retained, [14,16,19,23,26,27,30,31,32,35,37,40,43,44,46,49,50,53,57,60,63], '只移除已核验的模板装饰；内容图及原 46/63 两张无图注配图必须保留');
      for (const title of ['都重新见面了怎么还没和好？','从《后会友期》看物理','外场变了，过去还算数']) assert.ok(doc.body.textContent.includes(title), '海报文字保留');
      assert.ok(doc.body.textContent.includes('τ ≈ τ₀ · exp(ΔE / kBT)'), 'Unicode 正文公式不因装饰清理被删');
    }
    const originalImages = [...doc.images];
    const originalFormulaRoots = [...doc.querySelectorAll('[data-formula],[data-latex]')].filter(el => !el.parentElement.closest('[data-formula],[data-latex]'));
    const nativeFormulaSources = originalFormulaRoots.filter(el => !targets.some(t => t.contains(el))).map(el => el.getAttribute('data-formula') || el.getAttribute('data-latex'));
    let replacedImageCount = 0;
    for (const [index, target] of targets.entries()) {
      // The real renderer checks decoded frames; this assertion also protects the
      // one known animation in the user's sample from being selected for flattening.
      assert.equal(target.querySelectorAll('img[data-type="gif"],img[src*="wx_fmt=gif"]').length, 0);
      replacedImageCount += target.querySelectorAll('img').length + (target.tagName === 'IMG' ? 1 : 0);
      const p = doc.createElement('p');
      const img = doc.createElement('img');
      img.src = `https://i0.hdslb.com/bfs/mock/raster-${index}.png`;
      img.setAttribute('data-sync-rasterized', 'mock-only');
      img.setAttribute('data-mock-original-text', target.textContent);
      p.append(img);
      target.replaceWith(p);
    }
    assert.equal(doc.querySelectorAll('[data-sync-background-url]').length, 0);
    const imageMap = new Map();
    const expectedImageOrder = [];
    for (const [index, img] of [...doc.images].entries()) {
      const animated = img.getAttribute('data-type') === 'gif' || img.src.includes('wx_fmt=gif');
      const url = `https://i0.hdslb.com/bfs/mock/image-${index}.${animated ? 'gif' : 'png'}`;
      img.src = url;
      expectedImageOrder.push(url);
      imageMap.set(url, { width: 680, height: 320, size: 80, animated, frames: animated ? 2 : 1 });
    }
    const result = toOpus(doc.body.innerHTML, { document, images: imageMap });
    assert.deepEqual(result.blockingIssues, []);
    assert.equal(result.stats.images, originalImages.length - replacedImageCount + targets.length);
    assert.equal(result.stats.images, sample.images);
    assert.equal(result.stats.formulas, sample.formulas);
    const pictures = result.content.paragraphs.flatMap(p => p.pic?.pics || []);
    assert.deepEqual(pictures.map(p => p.url), expectedImageOrder);
    assert.equal(pictures.filter(p => p.comment).length, sample.captions);
    const withoutCaptions = new document.defaultView.DOMParser().parseFromString(doc.body.innerHTML, 'text/html');
    for (const [index, picture] of pictures.entries()) {
      if (!picture.comment) continue;
      const caption = withoutCaptions.images[index].closest('figure')?.querySelector('figcaption');
      assert.ok(caption, '每条原生图片注释必须来自同一张源图片的 figcaption');
      assert.equal(picture.comment, caption.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim());
      assert.ok(picture.comment.length <= 100, '图注不能超过原生编辑器限制');
      caption.remove();
    }
    // Native captions have one representation, not a duplicate text paragraph.
    // Removing exactly those source captions must leave identical body nodes,
    // including formulas, colors and emphasis outside the consumed captions.
    const bare = toOpus(withoutCaptions.body.innerHTML, { document, images: imageMap });
    assert.deepEqual(result.content.paragraphs.filter(p => p.text), bare.content.paragraphs.filter(p => p.text));
    const formulaNodes = result.content.paragraphs.flatMap(p => p.text?.nodes || []).filter(n => n.node_type === 5);
    for (const latex of nativeFormulaSources) assert.ok(formulaNodes.some(n => n.formula.latex_content.includes(latex)), `原生公式必须保留：${latex}`);
    assert.ok(formulaNodes.every(n => !n.formula.latex_content.includes('\\color{rgba(')));
    const nativeWords=result.content.paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.node_type===1).map(n=>n.word);
    const nativeText=nativeWords.map(word=>word.words).join('');
    if (sample.name.includes('正经玩')) {
      assert.equal(pictures.filter(p => p.url.endsWith('.gif')).length, 1);
      assert.ok(nativeText.includes('实验器材'),'装饰删除后标题必须保持原生文字');
      assert.deepEqual(pictures.map((p, index) => p.comment ? index : -1).filter(index => index >= 0), [0, 3, 12, 13]);
      assert.deepEqual(pictures.filter(p => p.comment).map(p => p.comment), ['↑试图用肉眼看清手机屏幕像素的小编', '书籍是人类进步的阶梯（物理意义）', '半导体晶圆', '真实的X射线衍射点阵']);
    }
    if (sample.name.includes('No. 537')) {
      for(let q=1;q<=12;q++) assert.match(nativeText,new RegExp(`Q\\s*${q}(?!\\d)`),`Q${q}必须保留为原生文字`);
      const textOf=paragraph=>(paragraph.text?.nodes||[]).map(node=>node.word?.words||'').join('').trim();
      const navigationIndex=result.content.paragraphs.findIndex(p=>textOf(p)==='问答导航');
      assert.ok(navigationIndex>=0);
      const navigation=result.content.paragraphs.slice(navigationIndex,navigationIndex+13);
      assert.equal(navigation.length,13);
      assert.ok(navigation.every(p=>p.para_type===1),'目录应保留13行普通可编辑文字，不能变成代码块');
      for(let q=1;q<=12;q++)assert.match(textOf(navigation[q]),new RegExp(`^Q${q}\\s+\\S`));
      assert.equal(result.content.paragraphs.filter(p=>p.code).length,0);
      assert.ok(!nativeText.includes('火箭发射时'),'投票后的上期文章尾部不能导入');
      assert.ok(!nativeText.includes('上期也精彩'));
    }
    if (sample.name.includes('不抽血')) {
      assert.ok(!nativeText.includes('福利时间'),'福利活动尾部不能导入');
      const originalUrl='https://knowablemagazine.org/content/article/health-disease/2026/disease-sniffing-tests-get-closer-to-reality';
      assert.deepEqual(result.requestedSourceLinks,[originalUrl]);
      const fallback=toOpus(doc.body.innerHTML,{document,images:imageMap,sourceLinkValidation:{rejected:[originalUrl]}});
      assert.deepEqual(fallback.blockingIssues,[]);assert.deepEqual(fallback.sourceLinks,[]);
      const fallbackText=fallback.content.paragraphs.flatMap(p=>p.text?.nodes||[]).map(node=>node.word?.words||node.link?.show_text||'').join('');
      assert.ok(fallbackText.includes('Sniffing out the link between odor and disease'));
      assert.equal(fallbackText.split(originalUrl).length-1,1,'B站拒绝的真实出处仍保留完整可复制URL且不重复');
      assert.deepEqual(fallback.content.paragraphs.flatMap(p=>p.pic?.pics||[]),pictures,'链接回退不能改变任何正文图和图注');
    }
    if (sample.name.includes('厉娜')) {
      for (const title of ['还买鸭舌呢，外场早变了','“画地为牢”，这个牢为什么出不去','弹幕都在劝，怎么又说回去了','油烟扇走了，旧事还在后台','所以，下一次开口能做什么']) {
        const word=nativeWords.find(word=>word.words===title);
        assert.ok(word, '标题内容保留可编辑文字');
        assert.equal(word.color,'#ae430e');assert.equal(word.style.bold,true);assert.equal(word.bg_style,undefined,'不得再用半高底纹承载白字');
      }
      assert.ok(result.notices.some(item=>item.severity==='info'&&item.message.includes('棕色加粗文字')));
    }
  });
}
