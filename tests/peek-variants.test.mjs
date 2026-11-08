import test from 'node:test';
import assert from 'node:assert/strict';
import {peekVariants, peekFrame} from '../src/modules/home/peek-variants.ts';
test('four unique poses and deliberately varied sizes',()=>{
 assert.equal(peekVariants.length,4);
 assert.equal(new Set(peekVariants.map(v=>v.frame)).size,4);
 const sizes=peekVariants.map(v=>v.size);
 assert.equal(new Set(sizes).size,4);
 assert.ok(Math.max(...sizes)/Math.min(...sizes)>=1.6);
});
test('sprite frames cover the four quadrants without repeating',()=>{
 assert.deepEqual([0,1,2,3].map(peekFrame),[{x:0,y:0},{x:-100,y:0},{x:0,y:-100},{x:-100,y:-100}]);
});
