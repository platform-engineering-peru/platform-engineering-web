import sharp from 'sharp';
import {stat} from 'node:fs/promises';
import {imageSources} from './image-manifest.mjs';
let before=0,after=0;
for(const source of imageSources){
 const input=`public/${source}`, output=input.replace(/\.png$/,'.webp');
 await sharp(input).webp({lossless:true,effort:6}).toFile(output);
 before+=(await stat(input)).size; after+=(await stat(output)).size;
}
console.log(`${imageSources.length} lossless previews: ${before} → ${after} bytes (${((1-after/before)*100).toFixed(1)}% smaller). Originals retained.`);
