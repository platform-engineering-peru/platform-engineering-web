import {test} from 'node:test';
import assert from 'node:assert/strict';
import {slideState} from '../src/lib/story-motion.ts';
test('Ukuku slides through the story and settles into a seated pose at the end',()=>{
 assert.equal(slideState(0).seated,0);assert.equal(slideState(2).seated,0);
 assert.equal(slideState(4).seated,1);assert.equal(slideState(5).seated,1);
 assert.ok(slideState(3.8).seated>slideState(3.5).seated);
 assert.equal(slideState(4).rotation,0);
 for(const p of [-1,0,1,2,3,4,5])for(const v of Object.values(slideState(p)))assert.ok(Number.isFinite(v));
});
test('Ukuku banks into each slide direction and straightens at rest',()=>{
 assert.ok(slideState(1.5).rotation>18);
 assert.ok(slideState(2.5).rotation< -18);
 assert.ok(slideState(1.5).yaw>15);
 assert.equal(slideState(4).yaw,0);
 for(const boundary of [1,2,3])assert.ok(Math.abs(slideState(boundary-.001).rotation-slideState(boundary+.001).rotation)<1);
});
