// Normalized image coordinates. Soft bone weights preserve the furry silhouette.
export function deformUkuku(x:number,y:number,time:number,chapter:number,still=false){
 if(still)return {x,y};
 const weight=(cx:number,cy:number,rx:number,ry:number)=>Math.exp(-(((x-cx)/rx)**2+((y-cy)/ry)**2)*2);
 let dx=0,dy=0;
 const rotate=(cx:number,cy:number,angle:number,w:number)=>{
  const c=Math.cos(angle),s=Math.sin(angle),px=x-cx,py=y-cy;
  dx+=((px*c-py*s)-px)*w;dy+=((px*s+py*c)-py)*w;
 };
 // Shoulder-pivoted greeting; a much slower reach in the cloud chapter.
 const wave=chapter===0?Math.sin(time*4)*.27:Math.sin(time*1.9)*.12;
 rotate(.66,.4,wave,weight(.83,.21,.26,.31));
 rotate(.46,.4,Math.sin(time*(chapter===2?1.5:.9))*.065,weight(.5,.25,.3,.24));
 rotate(.43,.59,-Math.sin(time*2)*.13,weight(.16,.46,.24,.18));
 rotate(.5,.7,Math.sin(time*2.5)*.11,weight(.38,.84,.4,.25));
 const breathe=Math.sin(time*1.7)*.012*weight(.49,.57,.3,.3);
 dx+=(x-.49)*breathe;dy-=breathe*.35;
 return {x:x+dx,y:y+dy};
}
