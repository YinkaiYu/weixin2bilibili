import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('extension');
const port=Number(process.env.PREVIEW_PORT||43127);
const types={'.html':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png'};
http.createServer(async(req,res)=>{
  try{let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/')pathname='/__test__/browser.html';
    let data,file;
    if(pathname==='/__test__/private-samples.json'){file='private-samples.json';data=await readFile(path.resolve('test-artifacts/browser-article-fixtures.json'));}
    else if(pathname==='/__test__/native-ui.js'){file='native-ui.js';data=(await readFile(path.join(root,file),'utf8')).replace('function isEditorUrl(value) {',`function isEditorUrl(value) {\n    if (new URL(value).origin === 'http://127.0.0.1:${port}') return true;`);}
    else {const base=pathname.startsWith('/__test__/')?path.resolve('tests/browser'):root;const relative=pathname.startsWith('/__test__/')?pathname.slice('/__test__'.length):pathname;file=path.resolve(base,'.'+relative);if(!file.startsWith(base+path.sep))throw new Error();data=await readFile(file);}
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Preview ready: http://127.0.0.1:${port}`));
