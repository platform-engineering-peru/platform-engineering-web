import assert from 'node:assert/strict';
import sharp from 'sharp';
import {imageSources} from './image-manifest.mjs';
// Compare rendered pixels, not compressed bytes. Transparent RGB is irrelevant.
for(const source of imageSources){
 const decode=async path=>sharp(path).flatten({background:'#171322'}).raw().toBuffer({resolveWithObject:true});
 const a=await decode(`public/${source}`), b=await decode(`public/${source.replace(/\.png$/,'.webp')}`);
 assert.deepEqual(a.info,b.info,source);
 assert.ok(a.data.equals(b.data),`Visual pixels changed: ${source}`);
 const alpha=async path=>(await sharp(path).ensureAlpha().extractChannel('alpha').raw().toBuffer());
 assert.ok((await alpha(`public/${source}`)).equals(await alpha(`public/${source.replace(/\.png$/,'.webp')}`)),`Alpha changed: ${source}`);
}
console.log(`Verified lossless pixels and transparency for ${imageSources.length} previews.`);
