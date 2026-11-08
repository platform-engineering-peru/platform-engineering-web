import {slideState} from '../../lib/story-motion';
export function initUkuku(){
 const root=document.querySelector<HTMLElement>('[data-journey]');if(!root||root.dataset.ready)return;root.dataset.ready='true';
 const stage=root.querySelector<HTMLElement>('.ukuku-stage')!;
 const scenes=Array.from(root.querySelectorAll<HTMLElement>('[data-scene]'));
 const bar=root.querySelector<HTMLElement>('[data-progress]')!,label=root.querySelector<HTMLElement>('[data-chapter-label]')!;
 const button=root.querySelector<HTMLButtonElement>('[data-motion]')!;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let paused=reduced.matches,frame=0,last=0,current=0,time=0;
 button.addEventListener('click',()=>{paused=!paused;button.setAttribute('aria-pressed',String(paused));button.textContent=paused?'▷':'Ⅱ';button.setAttribute('aria-label',paused?'Reanudar movimiento':'Pausar movimiento')});
 const update=(now:number)=>{
  const dt=Math.min((now-last)/1000,.05);last=now;
  const rect=root.getBoundingClientRect();
  if(rect.bottom>0&&rect.top<innerHeight){
   const tops=scenes.map(s=>s.getBoundingClientRect().top);let i=0;
   while(i<tops.length-1&&tops[i+1]<innerHeight*.12)i++;
   const fraction=i===4?0:Math.max(0,Math.min(1,(innerHeight*.12-tops[i])/(tops[i+1]-tops[i])));
   const target=i+fraction;
   current=reduced.matches?target:current+(target-current)*(1-Math.exp(-dt*9));
   const state=slideState(current),quiet=paused||reduced.matches;
   if(!quiet)time+=dt;
   const intro=Math.max(0,1-current);
   stage.style.setProperty('--bear-x',`${state.x*innerWidth}px`);
   stage.style.setProperty('--bear-y',`${quiet?0:Math.sin(time*1.8)*2*(1-state.seated)}px`);
   stage.style.setProperty('--bear-r',`${quiet?0:state.rotation}deg`);
   stage.style.setProperty('--bear-scale','1');
   stage.style.setProperty('--bear-yaw',`${quiet?0:state.yaw}deg`);
   stage.style.setProperty('--bear-top',`${24+intro*15}%`);
   stage.style.setProperty('--bear-height',`${65-intro*10}%`);
   stage.style.setProperty('--mobile-top',target<.5?'27%':'2%');
   stage.style.setProperty('--mobile-height',target<.5?'40%':'34%');
   stage.style.setProperty('--seated',String(state.seated));
   stage.style.setProperty('--slide-opacity',String(1-state.seated));
   stage.style.setProperty('--slide-squash',String(1-state.seated*.15));
   bar.style.transform=`scaleX(${Math.max(0,Math.min(1,-rect.top/(rect.height-innerHeight)))})`;
   label.textContent=i===0?'00 / UKUKU':`0${i} / 04`;
  }
  frame=requestAnimationFrame(update);
 };
 frame=requestAnimationFrame(update);
 document.addEventListener('astro:before-swap',()=>cancelAnimationFrame(frame),{once:true});
}
