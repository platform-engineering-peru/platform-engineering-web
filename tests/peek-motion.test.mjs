import test from 'node:test';
import assert from 'node:assert/strict';
import {peekProgress} from '../src/modules/home/peek-motion.ts';
test('Ukuku peeks low in the viewport, hides on scroll and reveals in reverse',()=>{
 assert.equal(peekProgress(800,1000),0);assert.equal(peekProgress(-200,1000),1);
 assert.ok(peekProgress(0,1000)>peekProgress(300,1000));
 assert.equal(peekProgress(-100,1000,true),0);assert.equal(peekProgress(0,0),0);
});

test("head remains fully visible through the middle of the viewport",()=>{assert.equal(peekProgress(400,1000),0);assert.equal(peekProgress(350,1000),0);});
