import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assemblyState, flightState} from '../src/lib/story-motion.ts';
test('assembly clamps at either end, builds progressively and reverses with scroll',()=>{
 assert.equal(assemblyState(-1).layers[0],0);
 assert.deepEqual(assemblyState(2).layers,[1,1,1]);
 assert.ok(assemblyState(.5).layers[0]>assemblyState(.2).layers[0]);
 assert.ok(assemblyState(.2).scale<assemblyState(.8).scale);
 assert.deepEqual(assemblyState(.2),assemblyState(.2));
});
test('flight lands at chapter anchors with finite transforms, including last chapter',()=>{
 for(const p of [-1,0,.5,1,2,3,4,5]) for(const v of Object.values(flightState(p))) assert.ok(Number.isFinite(v));
 assert.equal(flightState(1).x,.07); assert.equal(flightState(2).x,.55);
 assert.deepEqual(flightState(8),flightState(4));
});
test('flight dives and banks between anchors, returns continuously in reverse',()=>{
 const middle=flightState(1.5);assert.ok(Math.abs(middle.rotation)>5);
 assert.ok(middle.y>flightState(1).y);assert.ok(middle.scale<flightState(1).scale);
 const a=flightState(1.9999),b=flightState(2);assert.ok(Math.abs(a.x-b.x)<.001);
});
test('reduced motion keeps the mascot still and assembly fully visible',()=>{
 assert.deepEqual(flightState(0,true),flightState(3,true));
 assert.deepEqual(assemblyState(0,true).layers,[1,1,1]);
});

test('Ukuku has distinct chapter gestures and a stationary reduced-motion fallback', async()=>{
 const {mascotGesture}=await import('../src/lib/story-motion.ts');
 const poses=[0,1,2,3,4].map(chapter=>mascotGesture(chapter,1.2));
 assert.equal(new Set(poses.map(p=>JSON.stringify(p))).size,5);
 for(const chapter of [0,1,2,3,4]){
  assert.deepEqual(mascotGesture(chapter,8,true),{x:0,y:0,rotation:0,scale:1});
  for(const t of [0,1,5,100]) for(const v of Object.values(mascotGesture(chapter,t))) assert.ok(Number.isFinite(v));
 }
});
