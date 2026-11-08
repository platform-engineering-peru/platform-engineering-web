import test from 'node:test';
import assert from 'node:assert/strict';
import {networkPose,networkReveal,NETWORK_COLORS} from '../src/modules/community/network-motion.ts';
test('community choreography has bounded depth and staged entrance',()=>{
 assert.equal(networkReveal(0),0);assert.equal(networkReveal(3,5),1);
 assert.ok(networkReveal(.5,0)>networkReveal(.5,5));
 for(let t=0;t<60;t+=.25)for(let i=0;i<6;i++){
  const p=networkPose(i,t,.3,-.2);assert.ok(Object.values(p).every(Number.isFinite));assert.ok(p.scale>.7&&p.scale<1.4);
 }
 assert.notDeepEqual(networkPose(1,0),networkPose(1,5));
});
test('reduced motion freezes poses and skips entrance',()=>{
 assert.deepEqual(networkPose(2,0,0,0,true),networkPose(2,60,0,0,true));
 assert.equal(networkReveal(0,5,true),1);
 assert.deepEqual(Object.values(NETWORK_COLORS),['#5B2EFF','#00D96E','#C4B5FD','#090C20']);
});
