import {assemblyState} from '../../lib/story-motion';
export function initAboutStory(){
 const root=document.querySelector<HTMLElement>('[data-about-build]');
 if(!root||root.dataset.ready)return;root.dataset.ready='true';
 const layers=Array.from(root.querySelectorAll<HTMLElement>('[data-build-layer]'));
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let frame=0;
 const render=()=>{frame=0;const rect=root.getBoundingClientRect();const state=assemblyState((82-rect.top)/(innerHeight*.6),reduced.matches);root.style.setProperty('--assembly-scale',String(state.scale));layers.forEach((layer,i)=>layer.style.setProperty('--layer',String(state.layers[i])));};
 const schedule=()=>{if(!frame)frame=requestAnimationFrame(render)};
 window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);reduced.addEventListener('change',schedule);render();
 document.addEventListener('astro:before-swap',()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);reduced.removeEventListener('change',schedule)},{once:true});
}
