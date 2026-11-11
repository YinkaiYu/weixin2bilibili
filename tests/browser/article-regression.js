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
      const reviewedStyles=[...raw.querySelectorAll('#js_content section')].filter(el=>el.style.backgroundColor||el.style.backgroundImage).map(el=>{const ancestors=[];for(let node=el.parentElement;node;node=node.parentElement)ancestors.push({tag:node.tagName,color:node.style.color,background:node.style.backgroundColor});return {text:el.textContent.slice(0,60),style:el.style.cssText,ancestors,children:[...el.querySelectorAll('[style]')].filter(n=>n.style.color||n.style.backgroundColor).map(n=>({text:n.textContent.slice(0,16),color:n.style.color,background:n.style.backgroundColor}))};});
      for(const item of reviewedStyles){const el=[...raw.querySelectorAll('#js_content section')].find(el=>el.style.cssText===item.style);item.backgroundImage=el.style.backgroundImage;}
      const paperStyles=[...raw.querySelectorAll("section")].filter(el=>el.style.backgroundImage.includes("gradient")&&el.querySelectorAll("p").length>=3).map(el=>({image:el.style.backgroundImage,size:el.style.backgroundSize,repeat:el.style.backgroundRepeat}));
      const source=parseArticle(sample.html,{document});
      const doc=new DOMParser().parseFromString(source.html,'text/html');
      const targets=findRasterTargets(doc);
      const rasterDetails=targets.map(t=>({tag:t.tagName,style:t.style.cssText,text:t.textContent.slice(0,50),characters:t.textContent.length,images:t.querySelectorAll('img').length,gifs:t.querySelectorAll('img[data-type="gif"]').length,html:t.outerHTML.slice(0,500)}));
      for(const [index,target]of targets.entries()){
        const p=doc.createElement('p'),img=doc.createElement('img');
        img.src=`https://i0.hdslb.com/bfs/mock/raster-${index}.png`;p.append(img);target.replaceWith(p);
      }
      const images=new Map();
      for(const [index,img]of [...doc.images].entries()){
        const url=`https://i0.hdslb.com/bfs/mock/image-${index}.png`;
        img.src=url;images.set(url,{width:680,height:320,size:80});
      }
      // This offline page does not call the recognition API; every source URL
      // remains unverified regardless of its domain or article identity.
      const sourceUrls=[...doc.querySelectorAll('a[data-sync-source-link="true"]')].map(a=>a.href);
      const native=toOpus(doc.body.innerHTML,{document,images,sourceLinkValidation:{accepted:[],rejected:[],failed:sourceUrls}});
      const pics=native.content.paragraphs.flatMap(p=>p.pic?.pics||[]);
      const text=native.content.paragraphs.filter(p=>p.text).map(p=>p.text.nodes.map(n=>n.word?.words||'').join(''));
      const emphasizedWords=native.content.paragraphs.flatMap(p=>p.text?.nodes||[]).filter(n=>n.word?.color&&n.word.style?.bold).map(n=>({text:n.word.words,color:n.word.color,background:n.word.bg_style||null}));
      results.push({name:sample.name,paperStyles,parsed:source.stats,raster:targets.length,rasterDetails,native:native.stats,captions:pics.filter(p=>p.comment).length,code:native.content.paragraphs.filter(p=>p.code).length,navigation:text.filter(t=>/^问答导航$|^Q\d+\s/.test(t)),emphasizedWords,sourceUrls,sourceUrlVisible:sourceUrls.every(url=>text.some(t=>t.includes(url))),blocking:native.blockingIssues,reviewedStyles:native.blockingIssues.length?reviewedStyles:[]});
    }
    output.textContent=JSON.stringify(results,null,2);output.dataset.done='true';
  }catch(error){output.textContent=error.message;output.dataset.done='false';}
};
