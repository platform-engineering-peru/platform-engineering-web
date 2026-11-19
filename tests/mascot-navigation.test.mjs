import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initUkuku } from '../src/modules/mascot/mascot-motion.ts';

for (const reduced of [false, true]) {
  test(`story controls navigate scenes and clamp endpoints (reduced=${reduced})`, () => {
    const window = new Window();
    window.document.documentElement.lang = 'en';
    window.document.body.innerHTML = `<div data-journey><div class="ukuku-stage"></div>${Array.from({length:5},()=>'<section data-scene></section>').join('')}<i data-progress></i><span data-chapter-label></span><button data-motion></button><button data-story-prev></button><button data-story-next></button></div>`;
    const keys = ['window','document','matchMedia','requestAnimationFrame','cancelAnimationFrame','innerHeight','innerWidth'];
    const saved = new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
    let tick, scrollY = 0, movement;
    Object.assign(globalThis, {window,document:window.document,innerHeight:800,innerWidth:390,
      matchMedia:()=>({matches:reduced}), requestAnimationFrame:callback=>(tick=callback,1),cancelAnimationFrame:()=>{}});
    Object.defineProperty(window,'scrollY',{get:()=>scrollY});
    window.scrollTo = options => {movement=options;scrollY=options.top;};
    const root=window.document.querySelector('[data-journey]');
    root.getBoundingClientRect=()=>({top:-scrollY,bottom:5000-scrollY,height:5000});
    [...root.querySelectorAll('[data-scene]')].forEach((scene,i)=>{scene.getBoundingClientRect=()=>({top:i*1000-scrollY});});
    try {
      initUkuku();tick(16);
      const prev=root.querySelector('[data-story-prev]'),next=root.querySelector('[data-story-next]');
      assert.equal(prev.disabled,true);
      for(let i=1;i<=4;i++){
        next.click();tick(16+i*16);
        assert.equal(root.querySelector('[data-chapter-label]').textContent,`0${i} / 04`);
        assert.equal(movement.behavior,reduced?'instant':'smooth');
      }
      assert.equal(next.disabled,true);
      prev.click();tick(96);
      assert.equal(root.querySelector('[data-chapter-label]').textContent,'03 / 04');
      assert.equal(next.disabled,false);
    } finally {
      for(const [key,descriptor] of saved) descriptor ? Object.defineProperty(globalThis,key,descriptor) : delete globalThis[key];
      window.happyDOM.abort();
    }
  });
}
