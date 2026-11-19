import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import sharp from 'sharp';
import { Window } from 'happy-dom';
import { validateMemories, projectMemories } from '../src/data/memories-contract.ts';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/memories-baseline.json', import.meta.url)));
const directory = new URL('../content/memories/', import.meta.url);
const records = () => readdirSync(directory).map(name => JSON.parse(readFileSync(new URL(name, directory))));
const valid = () => structuredClone(records());
test('migration preserves the exact bilingual projection independently of file order', () => {
  for (const [lang, offsets] of [['es-pe', [0,2,4]], ['en', [1,3,5]]]) {
    const photos = projectMemories(validateMemories(records().reverse()), lang, path => `/repo/${path}`);
    assert.deepEqual(photos, baseline.photos.map((row,i) => ({src:`/repo/memories/community-0${i+1}.jpg`,title:row[offsets[0]],alt:row[offsets[1]],description:row[offsets[2]]})));
  }
});
const invalid = [
 ['missing locale', r => { delete r[0].title.en; }, '/title'],
 ['private fields', r => { r[0].email = 'private@example.org'; }, '/email'],
 ['nested private fields', r => { r[0].media[0].token = 'secret'; }, '/media/0/token'],
 ['unsafe URL', r => { r[0].media[0].path = 'https://private.example/photo.jpg'; }, '/media/0/path'],
 ['path traversal', r => { r[0].media[0].path = 'memories/../secret.jpg'; }, '/media/0/path'],
 ['empty alt', r => { r[0].media[0].alt.en = ''; }, '/alt/en'],
 ['dimensions', r => { r[0].media[0].width = 0; }, '/width'],
 ['unknown version', r => { r[0].schemaVersion = 2; }, '/schemaVersion'],
 ['invalid UUID', r => { r[0].id = 'kcd'; }, '/id'],
 ['duplicate identity', r => { r[1].id = r[0].id; }, '/id'],
 ['duplicate order', r => { r[1].displayOrder = r[0].displayOrder; }, '/displayOrder'],
 ['duplicate slug', r => { r[1].slug = r[0].slug; }, '/slug'],
 ['duplicate media', r => { r[0].media.push(structuredClone(r[0].media[0])); }, '/media/1/id'],
 ['unknown event', r => { r[0].eventId = 'd3896632-91f3-4d82-8d88-0b052ed20ac3'; }, '/eventId'],
 ['date contradiction', r => { r[0].capturedAt = '2026-11-08'; }, '/capturedAt'],
 ['invented timestamp format', r => { r[0].updatedAt = 'yesterday'; }, '/updatedAt'],
 ['unknown media', r => { r[0].media[0].path = 'memories/missing.jpg'; }, '/media/0/path'],
 ['unapproved large media', r => { r[0].media[0].width = 3000; }, '/media/0/width'],
];
for (const [name, mutate, path] of invalid) test(`rejects ${name} with a field path`, () => {
  const r = valid(); mutate(r); assert.throws(() => validateMemories(r), error => error.message.includes(path));
});
test('archived memories are validated but excluded from the gallery', () => {
  const r=valid(); r[0].status='archived';
  assert.equal(projectMemories(validateMemories(r), 'en', x=>x).length,4);
});
test('legacy media metadata matches the original files and dates remain honest', async () => {
  for (const r of validateMemories(records())) {
    assert.equal(r.updatedAt,null);
    assert.equal(r.capturedAt,null);
    assert.equal(r.captureYear,null);
    assert.equal(r.datePrecision,'unknown');
    for (const m of r.media) {
      const actual=await sharp(new URL(`../public/${m.path}`, import.meta.url).pathname).metadata();
      assert.equal(m.width,actual.width); assert.equal(m.height,actual.height);
    }
  }
});
test('both built locales preserve tile and modal hooks and exact public content', async () => {
  for (const lang of ['en','es-pe']) {
    const window=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
    window.document.write(readFileSync(new URL(`../dist/${lang}/memories/index.html`,import.meta.url),'utf8'));
    const tiles=[...window.document.querySelectorAll('[data-memory-tile]')];
    const expected=projectMemories(validateMemories(records()),lang,x=>x);
    assert.equal(tiles.length,5);
    tiles.forEach((tile,i)=>{
      assert.equal(tile.dataset.memoryTile,String(i));
      assert.equal(tile.dataset.title,expected[i].title);
      assert.equal(tile.dataset.description,expected[i].description);
      assert.equal(tile.querySelector('img').alt,expected[i].alt);
      assert.ok(tile.querySelector('img').getAttribute('src').endsWith('/'+expected[i].src));
    });
    for(const hook of ['stage','canvas','fallback','prev','next','open','count','dialog','photo','close']) assert.ok(window.document.querySelector(`[data-memory-${hook}]`));
    assert.equal(window.document.querySelector('#memory-dialog-title').textContent,expected[0].title);
    await window.happyDOM.abort();
  }
});
