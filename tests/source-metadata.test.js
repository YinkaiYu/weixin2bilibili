import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {scriptAlbumTitles} from '../extension/lib/source-metadata.js';
import {parseArticle} from '../extension/lib/article.js';

const document=new JSDOM('').window.document;
const doc=html=>new document.defaultView.DOMParser().parseFromString(html,'text/html');
const fromScript=source=>scriptAlbumTitles(doc(`<script>${source}</script>`),raw=>raw);

test('reads only the direct album title in known structured metadata',()=>{
  const source=`(function(){try{window.cgiDataNew={title:'文章标题', other:{appmsgalbuminfo:{title:'无关嵌套'}},appmsgalbuminfo:{album_id:'123',title:'正经玩',size:'526'*1}};}catch(error){}})();
    var album_info_list=[{title:'正经玩',size:'526'*1,id:'123'.match(/[0-9]{8,}/)},{title:'问答'}];`;
  assert.deepEqual(fromScript(source),['正经玩','问答']);
});

test('does not execute code or read fake assignments from strings, comments, templates or regexes',()=>{
  const fake='window.cgiDataNew={appmsgalbuminfo:{title:"伪栏目"}};';
  const source=`// ${fake}\n/* ${fake} */\nconst text=${JSON.stringify(fake)};const pattern=/window.cgiDataNew={appmsgalbuminfo:{title:"伪栏目"}}/;
    if(true)/album_info_list = [{title:"假栏目"}]/.test('');
    const template=\`literal ${fake} \${(()=>{const nested=\`nested ${fake}\`;return nested;})()}\`;
    globalThis.metadataScriptExecuted=true;
    window.cgiDataNew={appmsgalbuminfo:{title:'真实栏目'}};`;
  assert.deepEqual(fromScript(source),['真实栏目']);
  assert.equal(globalThis.metadataScriptExecuted,undefined);
});

test('ignores unrelated objects, expression values, duplicates and overriding spreads',()=>{
  assert.deepEqual(fromScript(`other.window.cgiDataNew={appmsgalbuminfo:{title:'无关对象'}};other.album_info_list=[{title:'无关列表'}];var title='无关标题';`),[]);
  assert.deepEqual(fromScript(`window.cgiDataNew={appmsgalbuminfo:{title:danger()}};var album_info_list=[{title:'前缀'+'后缀'},{title:'旧',title:'新'},{title:'未知',...other},{['title']:'计算属性'}];`),[]);
  assert.deepEqual(fromScript(`window.cgiDataNew={appmsgalbuminfo:{title:'旧'},appmsgalbuminfo:{title:'新'}};`),[]);
});

test('requires the assigned value itself to be a literal instead of an accessed or computed result',()=>{
  assert.deepEqual(fromScript(`window.cgiDataNew={appmsgalbuminfo:{title:'中间对象'}}.other;var album_info_list=[{title:'中间数组'}].map(transform);`),[]);
  assert.deepEqual(fromScript(`window.cgiDataNew={appmsgalbuminfo:{title:'条件对象'}}||other;var album_info_list=[{title:'拼接数组'}]+other;`),[]);
  assert.deepEqual(fromScript(`window.cgiDataNew={appmsgalbuminfo:{title:'运算对象'}}/2;`),[]);
  assert.deepEqual(fromScript(`var album_info_list=[{title:'运算数组'}]/2;`),[]);
});

test('supports quoted keys and delegates string decoding without evaluating expressions',()=>{
  const raw=String.raw`window.cgiDataNew={'appmsgalbuminfo':{'title':'\u6b63\u7ecf\u73a9 &amp; \x41'}};`;
  const article=parseArticle(`<script>${raw}</script><h1 id="activity-name">测试</h1><div id="js_content"><p>正文</p></div>`,{document});
  assert.deepEqual(article.collectionNames,['正经玩 & A']);
  assert.deepEqual(fromScript(`var album_info_list=[{title:'escaped\\\'quote'},{title:'second'}];`),["escaped\\'quote",'second']);
});

test('does not let malformed or external scripts supply metadata',()=>{
  assert.deepEqual(scriptAlbumTitles(doc(`<script src="https://example.test/code.js">var album_info_list=[{title:'忽略'}]</script>`),raw=>raw),[]);
  assert.deepEqual(fromScript(`var album_info_list=[{title:'unterminated`),[]);
  assert.deepEqual(fromScript(`/* var album_info_list=[{title:'伪栏目'}]`),[]);
  assert.deepEqual(scriptAlbumTitles(doc(`<script>var album_info_list=[{title:'坏转义'}]</script>`),()=>{throw new Error('decode failed');}),[]);
  assert.deepEqual(fromScript(`outer:for(;;){break outer\n/window.cgiDataNew={appmsgalbuminfo:{title:'正则伪栏目'}}/.test('');}`),[]);
});

test('keeps distinct explicit album candidates instead of choosing the first title',()=>{
  const article=parseArticle(`<script>var album_info_list=[{title:'问答'},{title:'正经玩'},{title:'问答'}]</script><h1 id="activity-name">文章 | 标题候选</h1><div id="js_content">正文</div>`,{document});
  assert.deepEqual(article.collectionNames,['问答','正经玩']);
});

const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','测试文章');
const cases=[
  ['不抽血不拍片，闻一闻就能接收身体警报？？？.html','翻译专栏'],
  ['为什么只睡20分钟，下午就能精神满满？_ No. 537.html','问答'],
  ['你知道你的手机有多清晰吗？居然用一束光就能测量手机的清晰度？ _ 正经玩.html','正经玩'],
  ['摸了半天找不到头，胶带却记得你撕到哪儿？.html','线上科学日'],
  ['要宣布翻篇了？那我磁化损失呢，厉娜.html','线上科学日'],
];
const albumDom='#js_album_name,.js_album_title,.album_read_title,.album__name,.album_name_title,.js_album_directory__name,.album_tag_name,[data-album-title],[data-album-name],[data-column-name]';
for(const [filename,expected]of cases)test(`script-only album metadata without rendered collection DOM: ${expected} / ${filename}`,{skip:!fs.existsSync(path.join(directory,filename))&&'用户本地样稿未附带。'},()=>{
  const source=doc(fs.readFileSync(path.join(directory,filename),'utf8'));
  for(const element of source.querySelectorAll(albumDom))element.remove();
  assert.equal(source.querySelectorAll(albumDom).length,0);
  assert.deepEqual(scriptAlbumTitles(source,raw=>raw),[expected]);
  assert.deepEqual(parseArticle(source.documentElement.outerHTML,{document}).collectionNames,[expected]);
});
