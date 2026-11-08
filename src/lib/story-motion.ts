const clamp = (n:number) => Math.max(0,Math.min(1,n));
const smooth = (n:number) => n*n*(3-2*n);
export function assemblyState(progress:number,reduced=false){
 const p=reduced?1:clamp(progress);
 return {scale:1+.12*smooth(p),layers:[.08,.27,.46].map(start=>smooth(clamp((p-start)/.38)))};
}
export function flightState(progress:number,reduced=false){
 if(reduced)return {x:.12,y:0,scale:1,rotation:0};
 const p=Math.max(0,Math.min(4,progress));
 const anchors=[.12,.07,.55,.07,.55];
 const index=Math.min(3,Math.floor(p)),t=p-index,e=smooth(t),arc=Math.sin(t*Math.PI);
 const direction=anchors[index+1]>anchors[index]?1:-1;
 return {x:anchors[index]+(anchors[index+1]-anchors[index])*e,y:arc*65,scale:1-arc*.18,rotation:arc*direction*17};
}

// Each chapter has its own bounded gesture, composed with the scroll flight.
export function mascotGesture(chapter:number,time:number,reduced=false){
 if(reduced)return {x:0,y:0,rotation:0,scale:1};
 const t=time;
 switch(chapter){
  case 0:return {x:0,y:Math.sin(t*1.5)*9,rotation:Math.sin(t*2.4)*6,scale:1};
  case 1:return {x:Math.sin(t*1.2)*10,y:-Math.abs(Math.sin(t*1.2))*19,rotation:Math.cos(t*1.2)*4,scale:1};
  case 2:return {x:Math.sin(t*.8)*7,y:0,rotation:Math.sin(t*.8)*9,scale:1+Math.sin(t*.8)*.025};
  case 3:return {x:Math.cos(t*.7)*14,y:Math.sin(t*.7)*14,rotation:Math.sin(t*.7)*3,scale:1};
  default:return {x:Math.sin(t)*12,y:-Math.abs(Math.sin(t*1.7))*10,rotation:Math.sin(t*1.7)*5,scale:1+Math.sin(t*1.7)*.015};
 }
}

export function slideState(progress:number){
 const p=Math.max(0,Math.min(4,progress));
 const anchors=[.1,.06,.55,.06,.55];
 const i=Math.min(3,Math.floor(p)),t=smooth(p-i);
 const seated=smooth(clamp((p-3.4)/.6));
 const direction=Math.sign(anchors[i+1]-anchors[i]);
 const turn=seated===1?0:Math.sin((p-i)*Math.PI)*(1-seated);
 return {x:anchors[i]+(anchors[i+1]-anchors[i])*t,seated,rotation:turn*direction*24,yaw:turn*direction*22};
}
