import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {validatePublicContent} from '../src/data/public-content.ts';
const types=['events','speakers','organizers','resources','courses','settings','brands'];
const source=()=>({blog:[],...Object.fromEntries(types.map(type=>[type,readdirSync(new URL(`../content/${type}/`,import.meta.url)).map(file=>JSON.parse(readFileSync(new URL(`../content/${type}/${file}`,import.meta.url))))]))});
test('canonical baseline validates and content changes remain data driven',()=>{
 const input=source(); assert.equal(validatePublicContent(input).speakers.length,13);
 input.events[0].title.en='A revised event'; assert.equal(validatePublicContent(input).events.find(r=>r.id===input.events[0].id).title.en,'A revised event');
});
for(const [name,mutate] of [
 ['unknown speaker',r=>{r.events[0].speakerIds=['00000000-0000-4000-8000-000000000000']}],
 ['archived speaker on a published event',r=>{r.speakers.find(s=>s.id===r.events[0].speakerIds[0]).status='archived'}],
 ['shared resource ordering',r=>{r.courses[0].displayOrder=r.resources[0].displayOrder}],
 ['shared resource slug',r=>{r.courses[0].slug=r.resources[0].slug}],
 ['missing site settings',r=>{r.settings=[]}],
 ['archived site settings',r=>{r.settings[0].status='archived'}],
 ['additional site settings',r=>{r.settings.push({...r.settings[0],id:'00000000-0000-4000-8000-000000000000',slug:'another',displayOrder:100})}],
 ['private field',r=>{r.organizers[0].privateNotes='hidden'}],
])test(`rejects ${name} before public rendering`,()=>{const r=source();mutate(r);assert.throws(()=>validatePublicContent(r));});
test('empty and fully archived collections do not restore hardcoded content',()=>{const input=source();input.events=[];input.speakers=[];input.resources.forEach(r=>r.status='archived');input.courses.forEach(r=>r.status='archived');const result=validatePublicContent(input);assert.equal(result.events.length,0);assert.equal(result.resources.filter(r=>r.status==='published').length,0);});

test('renderer compatibility manifest pins the actual reader and schema bytes for each type',async()=>{
 const {createHash}=await import('node:crypto');
 const manifest=JSON.parse(readFileSync(new URL('../content/publication-compatibility.json',import.meta.url)));
 assert.equal(manifest.schemaVersion,1);assert.deepEqual(Object.keys(manifest.types).sort(),[...types,'memories','blog'].sort());
 for(const entry of Object.values(manifest.types))for(const file of [...Object.entries(entry.requiredFiles).map(([path,sha256])=>({path,sha256})),{path:entry.schemaPath,sha256:entry.schemaSha256}]){
  assert.match(file.path,/^(src|content)\//);assert.ok(!file.path.includes('..'));
  assert.equal(createHash('sha256').update(readFileSync(new URL('../'+file.path,import.meta.url))).digest('hex'),file.sha256,file.path);
 }
});
