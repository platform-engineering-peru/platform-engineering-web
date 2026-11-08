import {networkPose,networkReveal,NETWORK_COLORS as color} from './network-motion';
export function initCommunityNetwork(){
 const root=document.querySelector<HTMLElement>('[data-community-constellation]');
 if(!root||root.dataset.ready)return;root.dataset.ready='true';
 const canvas=root.querySelector<HTMLCanvasElement>('[data-network-canvas]')!;
 const ctx=canvas.getContext('2d');if(!ctx)return;
 const scene=root.querySelector<HTMLElement>('.community-constellation-scene')!;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let frame=0,last=0,time=0,entrance=0,visible=false,width=400,height=430;
 let mouseX=0,mouseY=0,rx=0,ry=0;
 const labels=document.documentElement.lang.startsWith('en')?['BUILD','LEARN','CONNECT','SHARE','EXPLORE','CREATE']:['CONSTRUIR','APRENDER','CONECTAR','COMPARTIR','EXPLORAR','CREAR'];
 function resize(){const rect=scene.getBoundingClientRect();width=rect.width;height=rect.height;const ratio=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);ctx!.setTransform(ratio,0,0,ratio,0,0);wake()}
 const draw=(now:number)=>{
  frame=0;if(!visible||document.hidden)return;
  const dt=last?Math.min((now-last)/1000,.05):.016;last=now;
  if(!reduced.matches){time+=dt;entrance+=dt}
  const rect=scene.getBoundingClientRect();
  const scroll=Math.max(-1,Math.min(1,(innerHeight*.5-rect.top-height*.5)/innerHeight));
  const ease=1-Math.exp(-dt*4);
  rx+=(mouseX*.2-rx)*ease;ry+=(mouseY*.14-ry)*ease;
  const yaw=reduced.matches?0:rx+scroll*.32,pitch=reduced.matches?0:ry+Math.sin(time*.16)*.08;
  const dark=document.documentElement.dataset.theme==='dark';
  const ink=dark?color.lavender:color.violet;
  const reveal=networkReveal(entrance,0,reduced.matches);
  ctx!.clearRect(0,0,width,height);ctx!.save();
  const fit=Math.min(width/450,height/470);
  ctx!.translate(width/2,height*.49);ctx!.scale(fit,fit);
  // Soft light beneath the shared platform, using the brand's own colors.
  const glow=ctx!.createRadialGradient(0,10,18,0,10,205);glow.addColorStop(0,dark?'#5B2EFF32':'#C4B5FD55');glow.addColorStop(.7,'#5B2EFF05');glow.addColorStop(1,'#5B2EFF00');ctx!.fillStyle=glow;ctx!.fillRect(-225,-235,450,470);
  // Three dimensional meridians: the slow camera movement changes their depth.
  for(let ring=0;ring<3;ring++){
   ctx!.beginPath();for(let j=0;j<=100;j++){const a=j/100*Math.PI*2,rot=ring*Math.PI/3+yaw;const x=Math.cos(a)*178,y=Math.sin(a)*178;const px=x*Math.cos(rot),pz=x*Math.sin(rot);const py=y*Math.cos(.65+pitch)-pz*Math.sin(.65+pitch);const z=pz*Math.cos(.65+pitch)+y*Math.sin(.65+pitch);const perspective=560/(560-z);const dx=px*perspective*reveal,dy=py*perspective*reveal;j?ctx!.lineTo(dx,dy):ctx!.moveTo(dx,dy)}ctx!.strokeStyle=dark?'#C4B5FD25':'#5B2EFF20';ctx!.lineWidth=.8;ctx!.stroke();
  }
  // Small depth cues drift behind the people, never competing with the content.
  for(let i=0;i<22;i++){const a=i*2.399+time*.025,r=90+(i%7)*16;ctx!.globalAlpha=.14+(i%3)*.07;ctx!.fillStyle=i%4===0?color.green:ink;ctx!.beginPath();ctx!.arc(Math.cos(a)*r,Math.sin(a)*r,1+(i%2)*.5,0,Math.PI*2);ctx!.fill()}ctx!.globalAlpha=1;
  const nodes=Array.from({length:6},(_,i)=>({...networkPose(i,time,yaw,pitch,reduced.matches),i,entry:networkReveal(entrance,i,reduced.matches)}));
  for(const node of nodes){
   const x=node.x*node.entry,y=node.y*node.entry;
   const bend=22*Math.sin(node.i*1.2+time*.13),cx=x*.45-y*.16,cy=y*.45+x*.16+bend;
   ctx!.beginPath();ctx!.moveTo(0,0);ctx!.quadraticCurveTo(cx,cy,x,y);ctx!.strokeStyle=dark?'#C4B5FD35':'#5B2EFF2c';ctx!.lineWidth=1;ctx!.stroke();
   if(!reduced.matches)for(let p=0;p<2;p++){
    const t=((time*.23+node.i*.17+p*.5)%1),u=1-t;
    const sx=2*u*t*cx+t*t*x,sy=2*u*t*cy+t*t*y;
    ctx!.globalAlpha=Math.sin(t*Math.PI)*node.entry;ctx!.shadowColor=color.green;ctx!.shadowBlur=9;ctx!.fillStyle=color.green;ctx!.beginPath();ctx!.arc(sx,sy,2.4,0,Math.PI*2);ctx!.fill();ctx!.shadowBlur=0;ctx!.globalAlpha=1;
   }
  }
  nodes.sort((a,b)=>a.z-b.z).forEach(node=>{
   ctx!.save();ctx!.translate(node.x*node.entry,node.y*node.entry);ctx!.scale(node.scale*(.85+node.entry*.15),node.scale*(.85+node.entry*.15));ctx!.globalAlpha=node.entry*(.7+(node.z+65)/430);
   ctx!.shadowColor=dark?'#00000055':'#5B2EFF24';ctx!.shadowBlur=18;ctx!.shadowOffsetY=8;
   const surface=ctx!.createLinearGradient(-25,-25,25,25);surface.addColorStop(0,dark?'#35304e':'#ffffff');surface.addColorStop(1,dark?color.navy:'#e9e2ff');ctx!.fillStyle=surface;ctx!.beginPath();ctx!.roundRect(-25,-25,50,50,16);ctx!.fill();ctx!.shadowBlur=0;ctx!.shadowOffsetY=0;ctx!.strokeStyle=dark?'#C4B5FD70':'#ffffff';ctx!.lineWidth=1.3;ctx!.stroke();
   ctx!.fillStyle=ink;ctx!.beginPath();ctx!.arc(0,-6,5.5,0,Math.PI*2);ctx!.fill();ctx!.strokeStyle=ink;ctx!.lineWidth=2;ctx!.lineCap='round';ctx!.beginPath();ctx!.moveTo(-10,11);ctx!.bezierCurveTo(-10,0,10,0,10,11);ctx!.stroke();
   ctx!.fillStyle=dark?color.lavender:'#615577';ctx!.textAlign='center';ctx!.font='8px monospace';ctx!.fillText(labels[node.i],0,41);ctx!.restore();
  });
  ctx!.restore();
  scene.style.setProperty('--network-x',`${rx*25}px`);scene.style.setProperty('--network-y',`${ry*20}px`);scene.style.setProperty('--network-reveal',String(reveal));
  if(!reduced.matches)frame=requestAnimationFrame(draw);
 };
 function wake(){if(!frame&&visible&&!document.hidden){last=0;frame=requestAnimationFrame(draw)}}
 const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(visible)wake();else{cancelAnimationFrame(frame);frame=0}},{threshold:.05});observer.observe(root);
 const size=new ResizeObserver(resize);size.observe(scene);
 const move=(e:PointerEvent)=>{const r=scene.getBoundingClientRect();mouseX=(e.clientX-r.left)/r.width-.5;mouseY=(e.clientY-r.top)/r.height-.5;wake()};
 const leave=()=>{mouseX=mouseY=0};scene.addEventListener('pointermove',move);scene.addEventListener('pointerleave',leave);
 reduced.addEventListener('change',wake);document.addEventListener('visibilitychange',wake);
 const theme=new MutationObserver(wake);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});resize();
 document.addEventListener('astro:before-swap',()=>{cancelAnimationFrame(frame);observer.disconnect();size.disconnect();theme.disconnect();scene.removeEventListener('pointermove',move);scene.removeEventListener('pointerleave',leave);reduced.removeEventListener('change',wake);document.removeEventListener('visibilitychange',wake)},{once:true});
}
