import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {parseArticle} from '../extension/lib/article.js';
import {findRasterTargets} from '../extension/lib/raster.js';
import {toOpus} from '../extension/lib/opus.js';
import {buildDraftPayload,verifyDraft} from '../extension/lib/bilibili.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=path.join(root,'测试文章','你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html');
const draftPath=path.join(root,'test-artifacts','live-draft-content.json');
const available=fs.existsSync(sourcePath)&&fs.existsSync(draftPath);
const skip=!available&&'本地用户样稿或真实读回记录未附带。';

function reconstruct(){
  const document=new JSDOM('').window.document;
  // This saved response predates lazy-background support. Reconstruct that
  // historical input explicitly, not today's corrected decorated-heading image.
  // Current complete backgrounds/layout are checked in real-opus and browser
  // regressions; none of the production verification rules are relaxed here.
  const historicalSource=new JSDOM(fs.readFileSync(sourcePath,'utf8'));
  const lazyBackgrounds=[...historicalSource.window.document.querySelectorAll('#js_content [data-lazy-bgimg]')];
  assert.equal(lazyBackgrounds.length,1);
  assert.equal(lazyBackgrounds[0].parentElement.textContent.trim(),'实验器材');
  lazyBackgrounds[0].removeAttribute('data-lazy-bgimg');
  // The historical JSDOM cleanup omitted background shorthands. Freeze that
  // old input explicitly; current production cleanup retains their solid color.
  for(const element of historicalSource.window.document.querySelectorAll('#js_content [style]')) {
    if(Array.from(element.style).includes('background'))element.style.removeProperty('background');
  }
  const article=parseArticle(historicalSource.serialize(),{document});
  const draft=JSON.parse(fs.readFileSync(draftPath,'utf8'));
  const doc=new document.defaultView.DOMParser().parseFromString(article.html,'text/html');
  // This historical response also predates caption association. Restore the
  // original paragraph wrappers inside the newly generated figures/captions so
  // this fixture continues checking its original transport, not new behavior.
  assert.equal(doc.querySelectorAll('figcaption').length,4);
  for(const caption of [...doc.querySelectorAll('figcaption')])caption.replaceWith(...caption.childNodes);
  for(const figure of [...doc.querySelectorAll('figure')])figure.replaceWith(...figure.childNodes);
  // That converter also encoded a block's ordinary white page background as
  // per-word white highlights. Re-express that historical source treatment as
  // explicit inline highlights, without copying anything from the saved draft.
  const walker=doc.createTreeWalker(doc.body,4),whiteText=[];
  while(walker.nextNode()) {
    const text=walker.currentNode;if(!text.textContent.trim())continue;
    for(let parent=text.parentElement;parent;parent=parent.parentElement){
      const background=parent.style?.backgroundColor;
      if(!background||['transparent','initial','unset','inherit'].includes(background))continue;
      if(background==='rgb(255, 255, 255)'||background==='white')whiteText.push(text);
      break;
    }
  }
  assert.ok(whiteText.length>0,'历史源输入含有白底文字');
  for(const text of whiteText){const span=doc.createElement('span');span.style.backgroundColor='#ffffff';text.replaceWith(span);span.append(text);}
  const targets=findRasterTargets(doc);
  assert.equal(targets.length,1);
  assert.ok(targets[0].querySelector('img[src*="Yellowdog.png"]'));
  const fallback=doc.createElement('p');fallback.innerHTML='<img src="https://i0.hdslb.com/bfs/mock/raster.png">';
  targets[0].replaceWith(fallback);
  // No saved request/upload-cache export exists. Only upload identities and
  // metadata are bound in source occurrence order to the observed response.
  // Thus this fixture independently checks all text, formulas and formatting,
  // not the visual identity of those uploaded files. Separate mutation tests
  // enforce URL/path/size/order checks. The known emoji paragraph raster is the
  // sole content replacement; no text or style is copied from the draft.
  const uploaded=draft.opus.content.paragraphs.flatMap(p=>p.pic?.pics||[]);
  assert.equal(doc.images.length,16);assert.equal(uploaded.length,16);
  const images=new Map();
  [...doc.images].forEach((img,i)=>{img.src=uploaded[i].url;images.set(uploaded[i].url,uploaded[i]);});
  const converted=toOpus(doc.body.innerHTML,{document,images});
  assert.deepEqual(converted.blockingIssues,[]);
  assert.equal(converted.stats.paragraphs,74);
  assert.equal(converted.stats.formulas,11);
  const cover=draft.image_urls[0].replace('article.biliimg.com','i0.hdslb.com');
  const payload=buildDraftPayload({title:article.title,content:converted.content,coverUrl:cover,collectionId:draft.list_id,original:true});
  return {payload,draft};
}

test('historical saved draft matches its source text and formulas; true formatting changes remain visible',{skip},()=>{
  const {payload,draft}=reconstruct();
  const before=payload.arg.opus.content.paragraphs,after=draft.opus.content.paragraphs;
  assert.equal(before.length,after.length);
  let formulaCount=0,fontChanges=0,themedBlack=0;
  for(let p=0;p<before.length;p++){
    // The converter was corrected after this historical save: standalone
    // 20/22/24px source headings are now native headings rather than paragraphs.
    assert.ok(before[p].para_type===after[p].para_type || (before[p].para_type===9&&after[p].para_type===1));
    const wanted=before[p].text?.nodes||[],actual=after[p].text?.nodes||[];
    assert.equal(wanted.length,actual.length,`text node count in paragraph ${p}`);
    for(let n=0;n<wanted.length;n++){
      assert.equal(wanted[n].node_type,actual[n].node_type);
      if(wanted[n].node_type===5){assert.equal(wanted[n].formula.latex_content,actual[n].formula.latex_content);formulaCount++;}
      if(wanted[n].node_type===1){
        const a=wanted[n].word,b=actual[n].word;
        assert.equal(a.words,b.words);
        assert.equal(a.color||'',b.color||'');
        assert.equal(a.bg_style?.color?.color||'',b.bg_style?.color?.color||'');
        for(const key of ['bold','italic','underline','strikethrough'])assert.equal(!!a.style?.[key],!!b.style?.[key]);
        if(a.font_size!==b.font_size||a.font_level!==b.font_level)fontChanges++;
        if((a.color||'').toLowerCase()==='#000000'&&b.bili_theme==='Ba0'&&b.dark_color==='#000000')themedBlack++;
      }
    }
  }
  assert.equal(formulaCount,11);
  assert.ok(fontChanges>0,'saved record contains real font-size/level changes');
  assert.equal(themedBlack,3);
  const result=verifyDraft(payload,draft);
  assert.equal(result.ok,false,'real font/theme changes must not be silenced');
  assert.ok(!result.issues.some(message=>message.includes('封面')),'CDN alias alone is not a lost cover');
  assert.ok(result.issues.some(message=>message.includes('字号')));
  assert.ok(!result.issues.some(message=>message.includes('主题色')),'actual black-to-Ba0-black enrichment is equivalent');
});

test('historical live response default fields and CDN alias are wire-format equivalents, separate from its real typography differences',{skip},()=>{
  const draft=JSON.parse(fs.readFileSync(draftPath,'utf8'));
  // This second test isolates serialization defaults. Unlike the independent
  // source reconstruction above, it deliberately uses the recorded typography
  // on both sides. It makes no claim that the historical typography was correct.
  const wireContent=structuredClone(draft.opus.content);
  for(const p of wireContent.paragraphs){
    if(p.format){if(Object.keys(p.format.indent||{}).length===0)delete p.format.indent;if(p.format.align===undefined)p.format.align=0;}
    if(p.pic)p.pic.style=0;
    for(const n of p.text?.nodes||[])if(n.node_type===1){
      n.word.color??='';n.word.dark_color??='';
      if(n.word.bg_style?.color)n.word.bg_style.color.dark_color??='';
    }
  }
  const payload=buildDraftPayload({title:draft.title,content:wireContent,coverUrl:draft.image_urls[0].replace('article.biliimg.com','i0.hdslb.com'),collectionId:draft.list_id,original:true});
  assert.deepEqual(verifyDraft(payload,draft),{ok:true,issues:[]});
  const changed=structuredClone(draft);changed.opus.content.paragraphs[0].format.align=2;
  assert.equal(verifyDraft(payload,changed).ok,false);
});

const qaExpectedPath=path.join(root,'test-artifacts','expected-native-v0.1.6','EpDtKCqGK6qVekxIabvQ1Q.expected-native.json');
const qaDraftPath=path.join(root,'test-artifacts','qa-draft-390326-readback.json');
const qaSkip=!(fs.existsSync(qaExpectedPath)&&fs.existsSync(qaDraftPath))&&'本地问答预期快照或真实 API 读回记录未附带。';

test('Q&A API matches source content after explicitly isolating three observed caption fallbacks and proven wire defaults',{skip:qaSkip},()=>{
  // Freeze the offline v0.1.6 source conversion. The current cleaner now removes
  // the voting footer and the converter fixes navigation: neither new behavior
  // should be falsely required of this already-saved historical draft.
  const snapshot=JSON.parse(fs.readFileSync(qaExpectedPath,'utf8'));
  const draft=JSON.parse(fs.readFileSync(qaDraftPath,'utf8')).data.draft;
  const content=structuredClone(snapshot.content), paragraphs=[];
  const uploaded=draft.opus.content.paragraphs.flatMap(p=>p.pic?.pics||[]);
  assert.equal(uploaded.length,9);
  let imageIndex=0,captionIndex=0;
  for(const paragraph of content.paragraphs) {
    paragraphs.push(paragraph);
    for(const pic of paragraph.pic?.pics||[]) {
      // As in the earlier fixture, the save request/upload cache is unavailable.
      // Bind uploaded identities/dimensions by occurrence; do not claim this
      // fixture independently proves the visual identity of the uploaded files.
      const actual=uploaded[imageIndex++];
      Object.assign(pic,{url:actual.url,width:actual.width,height:actual.height,size:actual.size});
      if(!pic.comment)continue;
      // The live response has three body captions with this exact gray/pale
      // panel styling, unlike the offline snapshot's plain native comments.
      // Isolate that OBSERVED browser-path difference explicitly. Caption text
      // comes from the source snapshot; this fixture does not independently
      // prove why the live cleaner retained that background. The parser's
      // separate longhand-CSS tests cover the fix. Everything else (all body
      // words, formulas and formatting) stays independently source-derived.
      const words=pic.comment; delete pic.comment;
      paragraphs.push({para_type:1,format:captionIndex<2?{align:1}:{},text:{nodes:[{node_type:1,word:{
        words,font_size:13,font_level:'small',color:'#888888',dark_color:'',style:{},
        bg_style:{style:1,color:{color:'#efeff6',dark_color:''}},
      }}]}});
      captionIndex++;
    }
  }
  assert.equal(captionIndex,3);
  assert.equal(paragraphs.length,179);
  assert.equal(paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.node_type===5).length,26);
  assert.equal(paragraphs.find(p=>p.code).code.lang,'');
  assert.equal(draft.opus.content.paragraphs.find(p=>p.code).code.lang,undefined);
  const payload=buildDraftPayload({title:snapshot.title,content:{paragraphs},coverUrl:draft.image_urls[0].replace('article.biliimg.com','i0.hdslb.com'),original:true});
  assert.deepEqual(verifyDraft(payload,draft),{ok:true,issues:[]});
  for(const mutate of [
    d=>{d.opus.content.paragraphs[0].text.nodes[0].word.words+='改字';},
    d=>{d.opus.content.paragraphs.find(p=>p.pic).pic.pics[0].width++;},
    d=>{d.opus.content.paragraphs.find(p=>p.code).code.content+='\n';},
    d=>{d.opus.content.paragraphs.find(p=>p.text?.nodes.some(n=>n.node_type===5)).text.nodes.find(n=>n.node_type===5).formula.latex_content+='x';},
    d=>{d.opus.content.paragraphs.find(p=>p.para_type===5||p.para_type===6).format.combine_hash='new-split-group';},
  ]) {const changed=structuredClone(draft);mutate(changed);assert.equal(verifyDraft(payload,changed).ok,false);}
});
