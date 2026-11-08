export const NETWORK_COLORS={violet:'#5B2EFF',green:'#00D96E',lavender:'#C4B5FD',navy:'#090C20'};
export function networkPose(index:number,time:number,yaw=0,pitch=0,reduced=false){
 const t=reduced?0:time;
 const angle=index*Math.PI/3+t*.105;
 const x=Math.cos(angle)*148,y=Math.sin(angle)*132,z=Math.sin(angle*2+t*.08)*64;
 const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
 const dx=x*cy+z*sy,dz=z*cy-x*sy;
 const dy=y*cp-dz*sp,depth=dz*cp+y*sp;
 const scale=560/(560-depth);
 return {x:dx*scale,y:dy*scale,z:depth,scale};
}
export function networkReveal(time:number,index=0,reduced=false){
 if(reduced)return 1;
 const t=Math.max(0,Math.min(1,(time-index*.09)/1.4));
 return 1-Math.pow(1-t,4);
}
