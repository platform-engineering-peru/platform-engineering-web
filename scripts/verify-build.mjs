import {readdir,readFile,access,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const root=resolve('dist');
const base=(process.env.BASE_PATH||'/').replace(/\/+$/,'');
const walk=async dir=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat();
const files=(await walk(root)).filter(f=>f.endsWith('.html'));
let checked=0;
for(const file of files){
 const pagePath=file.slice(root.length).replace(/index\.html$/,'');
 const url=new URL(base+pagePath,'https://build.test');
 const window=new Window({url:url.href,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
 window.document.write(await readFile(file,'utf8'));
 for(const element of window.document.querySelectorAll('[src],a[href],link[href]')){
  const raw=element.getAttribute('src')||element.getAttribute('href');
  if(!raw||/^(#|https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(raw))continue;
  const target=new URL(raw,url);
  assert.ok(!base||target.pathname.startsWith(base+'/'),`Missing base path: ${raw} in ${file}`);
  const path=resolve(root,'.'+decodeURIComponent(target.pathname.slice(base.length)));
  assert.ok(path.startsWith(root),`Escaping build: ${raw}`);
  try{const info=await stat(path);await access(info.isDirectory()?join(path,'index.html'):path);checked++;}
  catch{throw new Error(`Broken local URL ${raw} in ${file}`);}
 }
 await window.happyDOM.abort();
}
assert.ok(files.length>=30,'Expected both language route trees');
console.log(`Verified ${checked} local links/assets across ${files.length} pages (base: ${base||'/'}).`);
