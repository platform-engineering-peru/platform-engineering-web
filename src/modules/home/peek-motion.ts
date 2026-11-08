/** Hide progressively as the seam travels from the lower to the upper viewport. */
export function peekProgress(top:number,viewport:number,reduced=false){
 if(reduced||viewport<=0)return 0;
 const t=Math.max(0,Math.min(1,(viewport*.35-top)/(viewport*.5)));
 return t*t*(3-2*t);
}
