import {parseArticle} from '/lib/article.js';
import {findRasterTargets} from '/lib/raster.js';
import {toOpus} from '/lib/opus.js';

document.querySelector('#run').onclick=async()=>{
  const output=document.querySelector('#result');output.textContent='正在检查';
  try{
    const response=await fetch('/__test__/private-samples.json');
    if(!response.ok)throw new Error('缺少本机私有样稿清单。');
    const samples=await response.json(),results=[];
    for(const sample of samples){
      const raw=new DOMParser().parseFromString(sample.html,'text/html');
      const reviewedStyles=[...raw.querySelectorAll('#js_content section')].filter(el=>['rgb(239, 239, 246)','rgb(252, 248, 243)'].includes(el.style.backgroundColor)).map(el=>{const ancestors=[];for(let node=el.parentElement;node;node=node.parentElement)ancestors.push({tag:node.tagName,color:node.style.color,background:node.style.backgroundColor});return {text:el.textContent.slice(0,60),style:el.style.cssText,ancestors,children:[...el.querySelectorAll('[style]')].filter(n=>n.style.color||n.style.backgroundColor).map(n=>({text:n.textContent.slice(0,16),color:n.style.color,background:n.style.backgroundColor}))};});
      for(const item of reviewedStyles){const el=[...raw.querySelectorAll('#js_content section')].find(el=>el.style.cssText===item.style);item.backgroundImage=el.style.backgroundImage;}
      const source=parseArticle(sample.html,{document});
      const doc=new DOMParser().parseFromString(source.html,'text/html');
      const targets=findRasterTargets(doc);
      for(const [index,target]of targets.entries()){
        const p=doc.createElement('p'),img=doc.createElement('img');
        img.src=`https://i0.hdslb.com/bfs/mock/raster-${index}.png`;p.append(img);target.replaceWith(p);
      }
      const images=new Map();
      for(const [index,img]of [...doc.images].entries()){
        const url=`https://i0.hdslb.com/bfs/mock/image-${index}.png`;
        img.src=url;images.set(url,{width:680,height:320,size:80});
      }
      // This one source URL was rejected by Bilibili's native link dialog and
      // parse API. The local test never calls that API or claims other URLs pass.
      const sourceUrls=[...doc.querySelectorAll('a[data-sync-source-link="true"]')].map(a=>a.href);
      const rejected=sourceUrls.filter(url=>url==='https://knowablemagazine.org/content/article/health-disease/2026/disease-sniffing-tests-get-closer-to-reality');
      const native=toOpus(doc.body.innerHTML,{document,images,sourceLinkValidation:{accepted:[],rejected,failed:sourceUrls.filter(url=>!rejected.includes(url))}});
      const pics=native.content.paragraphs.flatMap(p=>p.pic?.pics||[]);
      const text=native.content.paragraphs.filter(p=>p.text).map(p=>p.text.nodes.map(n=>n.word?.words||'').join(''));
      const brownHeadings=native.content.paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.word?.color==='#ae430e'&&n.word.style?.bold).map(n=>({text:n.word.words,color:n.word.color,background:n.word.bg_style||null}));
      results.push({name:sample.name,parsed:source.stats,raster:targets.length,native:native.stats,captions:pics.filter(p=>p.comment).length,code:native.content.paragraphs.filter(p=>p.code).length,navigation:text.filter(t=>/^问答导航$|^Q\d+\s/.test(t)),brownHeadings,sourceUrls,sourceUrlVisible:sourceUrls.every(url=>text.some(t=>t.includes(url))),blocking:native.blockingIssues,reviewedStyles:native.blockingIssues.length?reviewedStyles:[]});
    }
    output.textContent=JSON.stringify(results,null,2);output.dataset.done='true';
  }catch(error){output.textContent=error.message;output.dataset.done='false';}
};
