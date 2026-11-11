/** Read known WeChat album literals without evaluating any page JavaScript. */
const OPEN = new Map([['{','}'], ['[',']'], ['(',')']]);
const REGEX_PREFIX = new Set('return throw case delete void typeof new in instanceof yield await else do'.split(' '));
const CONTROL = new Set('if while for with switch catch'.split(' '));

function quoted(source, start) {
  const quote=source[start];
  for(let i=start+1;i<source.length;i++) {
    if(source[i]==='\\'){i++;continue;}
    if(source[i]===quote)return {end:i+1,raw:source.slice(start+1,i)};
    if(source[i]==='\n'||source[i]==='\r')return null;
  }
  return null;
}

function regexEnd(source,start) {
  let characterClass=false;
  for(let i=start+1;i<source.length;i++) {
    if(source[i]==='\\'){i++;continue;}
    if(source[i]==='\n'||source[i]==='\r')return -1;
    if(source[i]==='[')characterClass=true;
    if(source[i]===']')characterClass=false;
    if(source[i]==='/'&&!characterClass){while(/[a-z]/i.test(source[i+1]||'')&&i+1<source.length)i++;return i+1;}
  }
  return -1;
}

function templateEnd(source,start,depth) {
  if(depth>20)return -1;
  for(let i=start+1;i<source.length;i++) {
    if(source[i]==='\\'){i++;continue;}
    if(source[i]==='`')return i+1;
    if(source[i]==='$'&&source[i+1]==='{') {
      const nested=tokenize(source,i+2,true,depth+1);
      if(!nested.closed)return -1;
      i=nested.end-1;
    }
  }
  return -1;
}

// Opaque strings, comments, regexes and templates cannot introduce assignments.
// This is a literal reader, not a JavaScript interpreter. At ambiguous syntax
// it stops instead of guessing; already read complete metadata remains usable.
function tokenize(source,start=0,interpolation=false,depth=0) {
  const tokens=[],parens=[];
  let i=start,braces=0,canRegex=true;
  const add=(kind,value,raw)=>tokens.push({kind,value,raw});
  while(i<source.length) {
    const c=source[i],next=source[i+1];
    if(/\s/.test(c)){i++;continue;}
    if(c==='/'&&next==='/'){const end=source.indexOf('\n',i+2);i=end<0?source.length:end+1;continue;}
    if(c==='/'&&next==='*'){const end=source.indexOf('*/',i+2);if(end<0)break;i=end+2;continue;}
    if(c==='"'||c==="'") {
      const literal=quoted(source,i);if(!literal)break;
      add('string','',literal.raw);i=literal.end;canRegex=false;continue;
    }
    if(c==='`') {const end=templateEnd(source,i,depth);if(end<0)break;add('opaque','template');i=end;canRegex=false;continue;}
    if(c==='/') {
      // A full JS parser is needed to disambiguate division from every possible
      // regex statement (including ASI after a labelled break). Do not expose
      // that slash's contents as code. The observed metadata uses no division.
      if(canRegex!==true)break;
      const end=regexEnd(source,i);if(end<0)break;
      add('opaque','regex');i=end;canRegex=false;continue;
    }
    if(/[a-z_$]/i.test(c)) {
      const begin=i++;while(/[\w$]/.test(source[i]||'')&&i<source.length)i++;
      const value=source.slice(begin,i);add('word',value);canRegex=REGEX_PREFIX.has(value);continue;
    }
    if(/[0-9]/.test(c)) {
      const begin=i++;while(/[\w.]/.test(source[i]||'')&&i<source.length)i++;
      add('number',source.slice(begin,i));canRegex=false;continue;
    }
    if(c==='}'&&interpolation&&braces===0)return {tokens,end:i+1,closed:true};
    if(c==='(')parens.push(CONTROL.has(tokens.at(-1)?.value));
    if(c==='{')braces++;
    if(c==='}')braces--;
    add('punct',c);i++;
    if(c===')')canRegex=parens.pop()?true:false;
    else if(c==='}' )canRegex=null;
    else if(c===']')canRegex=false;
    else canRegex=c!=='.';
  }
  return {tokens,end:i,closed:!interpolation};
}

function matchingGroups(tokens) {
  const ends=new Map(),stack=[];
  for(let i=0;i<tokens.length;i++) {
    if(tokens[i].kind!=='punct')continue;
    const value=tokens[i].value;
    if(OPEN.has(value))stack.push(i);
    else if(['}',']',')'].includes(value)) {
      const open=stack.pop();
      if(open!==undefined&&OPEN.get(tokens[open].value)===value)ends.set(open,i);
      else stack.length=0;
    }
  }
  return ends;
}

function memberEnd(tokens,ends,start,close) {
  let i=start;
  while(i<close&&tokens[i].value!==',') {
    if(OPEN.has(tokens[i].value)){if(!ends.has(i))return close;i=ends.get(i)+1;}
    else i++;
  }
  return i;
}

function properties(tokens,ends,open,decode) {
  const close=ends.get(open),result=new Map();
  if(tokens[open]?.value!=='{'||close===undefined)return null;
  for(let i=open+1;i<close;) {
    if(tokens[i].value===','){i++;continue;}
    const key=tokens[i];
    // Computed keys, spreads, shorthand and methods could override a literal.
    if(!['word','string'].includes(key.kind)||tokens[i+1]?.value!==':')return null;
    let name;try{name=key.kind==='string'?decode(key.raw):key.value;}catch{return null;}
    const end=memberEnd(tokens,ends,i+2,close);
    result.set(name,result.has(name)?null:{start:i+2,end});
    i=end+1;
  }
  return result;
}

function objectValue(tokens,ends,range) {
  return range&&tokens[range.start]?.value==='{'&&ends.get(range.start)===range.end-1?range.start:null;
}

/** decode receives only raw contents of a quoted JavaScript string. */
export function scriptAlbumTitles(document,decode) {
  const titles=[];
  if(typeof decode!=='function')return titles;
  const readTitle=(tokens,ends,open)=>{
    const range=properties(tokens,ends,open,decode)?.get('title');
    if(!range||range.end!==range.start+1||tokens[range.start]?.kind!=='string')return;
    try{const title=decode(tokens[range.start].raw);if(typeof title==='string'&&title.trim())titles.push(title);}catch{/* Malformed strings are not album names. */}
  };
  for(const script of document.querySelectorAll('script')) {
    if(script.hasAttribute('src'))continue;
    const source=script.textContent||'';
    if(!source.includes('cgiDataNew')&&!source.includes('album_info_list'))continue;
    const {tokens,end:scannedUntil}=tokenize(source),ends=matchingGroups(tokens);
    const literalAssignment=open=>{
      const close=ends.get(open),next=close===undefined?null:tokens[close+1];
      return close!==undefined&&(next?[';','}'].includes(next.value):scannedUntil===source.length);
    };
    for(let i=0;i<tokens.length;i++) {
      const at=n=>tokens[i+n]?.value;
      if(at(0)==='window'&&at(1)==='.'&&at(2)==='cgiDataNew'&&at(3)==='='&&at(4)==='{'&&tokens[i-1]?.value!=='.'&&literalAssignment(i+4)) {
        const root=properties(tokens,ends,i+4,decode);
        const album=objectValue(tokens,ends,root?.get('appmsgalbuminfo'));
        if(album!==null)readTitle(tokens,ends,album);
      }
      if(at(0)==='album_info_list'&&at(1)==='='&&at(2)==='['&&
        (!tokens[i-1]||['var','let','const',';','{','}'].includes(tokens[i-1].value))&&literalAssignment(i+2)) {
        const close=ends.get(i+2);if(close===undefined)continue;
        for(let j=i+3;j<close;) {
          if(tokens[j].value===','){j++;continue;}
          const end=memberEnd(tokens,ends,j,close),open=objectValue(tokens,ends,{start:j,end});
          if(open!==null)readTitle(tokens,ends,open);
          j=end+1;
        }
      }
    }
  }
  return [...new Set(titles)];
}
