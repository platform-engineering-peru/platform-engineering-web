export const peekVariants = [
 {frame:0,side:'left',size:180},
 {frame:1,side:'right',size:135},
 {frame:2,side:'right',size:260},
 {frame:3,side:'bottom',size:210},
] as const;
export function peekFrame(frame:number){return {x:frame%2 ? -100 : 0,y:frame>=2 ? -100 : 0};}
