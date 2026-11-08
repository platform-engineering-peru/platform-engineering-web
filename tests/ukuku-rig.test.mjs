import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deformUkuku} from '../src/modules/mascot/ukuku-rig';
test('rig moves the raised paw independently from the torso',()=>{
 const paw=deformUkuku(.83,.21,1,0),body=deformUkuku(.5,.6,1,0);
 assert.ok(Math.hypot(paw.x-.83,paw.y-.21)>Math.hypot(body.x-.5,body.y-.6));
});
test('reduced motion preserves the original mesh and boundaries remain finite',()=>{
 for(const x of [0,.2,.5,.8,1])for(const y of [0,.2,.5,.8,1]){
 assert.deepEqual(deformUkuku(x,y,3,2,true),{x,y});
 const p=deformUkuku(x,y,3,2);assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
 }
});
