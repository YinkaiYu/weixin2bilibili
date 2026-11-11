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
  { name: '不抽血不拍片，闻一闻就能接收身体警报？？？.html', raster: 0, images: 4, formulas: 0, captions: 1 },
  { name: '为什么只睡20分钟，下午就能精神满满？_ No. 537.html', raster: 0, images: 9, formulas: 26, captions: 3 },
  { name: '你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html', raster: 1, images: 16, formulas: 11, captions: 4 },
  { name: '摸了半天找不到头，胶带却记得你撕到哪儿？.html', raster: 0, images: 12, formulas: 4, captions: 9 },
  { name: '要宣布翻篇了？那我磁化损失呢，厉娜.html', raster: 0, images: 64, formulas: 0, captions: 19 },
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
      assert.ok(nativeWords.some(word => word.words.includes('火箭发射时') && word.color === '#2e3191'), '原有蓝色图注须作为正文完整保留颜色');
    }
    if (sample.name.includes('厉娜')) assert.ok(nativeWords.some(word=>word.color==='#ffffff' && word.bg_style?.color?.color==='#ae430e'),'白字标题必须保留祖先棕色底，防止白底白字');
  });
}
