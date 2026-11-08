import {readdir,readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const files=['README.md','AGENTS.md','CONTRIBUTING.md',...(await readdir('docs')).filter(f=>f.endsWith('.md')).map(f=>'docs/'+f),'design/BRAND_GUIDELINES.md'];
let count=0;
for(const file of files){
 const text=await readFile(file,'utf8');
 for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
  const link=match[1];if(/^(https?:|mailto:|#)/.test(link))continue;
  await access(resolve(dirname(file),link.split('#')[0]));count++;
 }
}
console.log(`Verified ${count} local documentation links in ${files.length} English documents.`);
