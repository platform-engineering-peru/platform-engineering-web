import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('the approved original is preserved unchanged',async()=>{
 const bytes=await readFile('public/brand/official/mark-original.png');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'8ae48a743f3ebf84e0eb6ca43553677e12cec3c3b000a3d18889ae50b9bd006b');
});
test('header, branding and community use the approved mark instead of the redrawn SVG',async()=>{
 for(const path of ['src/components/layout/Header.astro','src/modules/branding/Branding.astro','src/modules/community/AboutCommunity.astro','src/lib/structured-data.ts']){
  const source=await readFile(path,'utf8');
  assert.ok(source.includes('brand/official/mark.png'),path);
  assert.ok(!source.includes('brand/official/mark.svg'),path);
 }
});

test('favicon uses a transparent, tightly framed PNG with a versioned URL',async()=>{
 const {default:sharp}=await import('sharp');
 const file='public/favicon-transparent.png';
 const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,64);
 assert.equal(info.height,64);
 assert.equal(data[3],0,'corner must be transparent');
 let visible=0;
 for(let i=3;i<data.length;i+=4) if(data[i]>128) visible++;
 assert.ok(visible>info.width*info.height*.35,'mark must remain readable at tab size');
 const layout=await readFile('src/layouts/BaseLayout.astro','utf8');
 assert.ok(layout.includes('favicon-transparent.png'));
});

test('downloadable HD master and compatibility SVG match the site master',async()=>{
 const master=await readFile('public/brand/official/mark.png');
 assert.deepEqual(await readFile('public/brand/kit/01-avatars-icons/logo-transparent-hd.png'),master);
 const svg=await readFile('public/brand/kit/04-vectores-svg/logo-isometrico-3capas-ukuku-transparent.svg','utf8');
 assert.ok(svg.includes(master.toString('base64')));
});
