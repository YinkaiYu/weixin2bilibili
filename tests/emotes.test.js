import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {wechatEmote} from '../extension/lib/emotes.js';
import {cleanArticle} from '../extension/lib/article.js';
import {findRasterTargets} from '../extension/lib/raster.js';
import {toOpus} from '../extension/lib/opus.js';
import {buildDraftPayload,verifyDraft} from '../extension/lib/bilibili.js';

const document=new JSDOM('').window.document;
const parse=html=>new document.defaultView.DOMParser().parseFromString(html,'text/html');
const prefix='https://res.wx.qq.com/t/wx_fed/we-emoji/res/assets/newemoji/';
const image=(name='Yellowdog',width='1em')=>`<img src="${prefix}${name}.png?cache=42#imgIndex=99" style="display:inline-block;width:${width}">`;

test('official inline emotes map by semantic asset ID across text, sizes and cache suffixes',()=>{
  for(const [source,target,width,copy] of [['Yellowdog','[doge]','1em','中文'],['Lol','[喜极而泣]','28px','A different sentence'],['2_05','[笑哭]','24px','另一种表情'],['Wow','[星星眼]','1.5em','新的标题']]){
    const cleaned=cleanArticle(`<p><strong>${copy}${image(source,width)}后文</strong></p>`,{document}),doc=parse(cleaned.html);
    assert.equal(wechatEmote(doc.images[0]),target);assert.equal(findRasterTargets(doc).length,0);
    const result=toOpus(cleaned.html,{document});
    assert.deepEqual(result.blockingIssues,[]);assert.equal(result.stats.images,0);assert.equal(result.stats.emotes,1);
    const nodes=result.content.paragraphs[0].text.nodes;
    assert.deepEqual(nodes.map(n=>n.node_type),[1,2,1]);
    assert.equal(nodes[0].word.words,copy);assert.equal(nodes[0].word.style.bold,true);
    assert.deepEqual(nodes[1],{node_type:2,emote:{raw_text:target}});assert.equal(nodes[2].word.words,'后文');
    assert.equal(result.summary,copy+target+'后文');
    assert.equal(result.notices.find(n=>n.message.includes('系统表情'))?.severity,'info');
  }
});

test('tears of joy and facepalm remain distinct; Unicode emoji stays literal Unicode',()=>{
  const result=toOpus(`<p>笑哭：😂 ${image('Lol')} 捂脸：${image('2_05')}</p>`,{document});
  const nodes=result.content.paragraphs[0].text.nodes;
  assert.deepEqual(nodes.filter(n=>n.emote).map(n=>n.emote.raw_text),['[喜极而泣]','[笑哭]']);
  assert.ok(nodes[0].word.words.includes('😂'));
});

test('unrecognized images, forged domains, large examples, captions and formulas are not emotes',()=>{
  for(const html of [image('Unknown'),image().replace('res.wx.qq.com','example.com'),image().replace('res.wx.qq.com','res.wx.qq.com.example.com'),image().replace('/newemoji/','/article/'),image('Yellowdog','400px'),image().replace('inline-block','block'),`<figure>${image()}<figcaption>表情的设计分析</figcaption></figure>`,`<span data-formula="x">${image()}</span>`,`<code>${image()}</code>`,`<section data-sync-composite-layout="grid-overlay">${image()}</section>`]){
    assert.equal(wechatEmote(parse(html).images[0]),null);
  }
  assert.equal(findRasterTargets(parse(`<p>未知表情${image('Unknown')}</p>`)).length,1);
  assert.equal(toOpus('<p>[doge] 是普通文字，不是表情节点</p>',{document}).stats.emotes,0);
});

test('native emote background and identity survive draft verification; changed or missing emotes fail',()=>{
  const result=toOpus(`<p>前<span style="background-color:#ffee00">${image()}</span>后${image('Lol')}</p>`,{document});
  const payload=buildDraftPayload({title:'表情测试',content:result.content});
  const make=()=>({...structuredClone(payload.arg),article_id:123,list:{id:0}});
  const nodes=result.content.paragraphs[0].text.nodes;
  assert.equal(nodes[1].emote.bg_style.color.color,'#ffee00');
  assert.equal(verifyDraft(payload,make()).ok,true);
  for(const mutate of [nodes=>{nodes[1].emote.raw_text='[微笑]';},nodes=>nodes.splice(1,1),nodes=>{nodes[1].emote.bg_style.color.color='#ff0000';},nodes=>nodes.reverse()]){
    const draft=make();mutate(draft.opus.content.paragraphs[0].text.nodes);assert.equal(verifyDraft(payload,draft).ok,false);
  }
  assert.throws(()=>buildDraftPayload({title:'无效',content:{paragraphs:[{para_type:1,text:{nodes:[{node_type:2,emote:{raw_text:'doge'}}]}}]}}),/无效的原生表情/);
});
