import * as THREE from 'three';
import {deformUkuku} from './ukuku-rig';
export async function createUkukuPuppet(host:HTMLElement){
 const img=host.querySelector<HTMLImageElement>('img')!;
 let renderer:THREE.WebGLRenderer;
 try{renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});}catch{return null;}
 const texture=await new THREE.TextureLoader().loadAsync(img.src).catch(()=>null);
 if(!texture){renderer.dispose();return null;}
 texture.colorSpace=THREE.SRGBColorSpace;
 const aspect=texture.image.width/texture.image.height;
 const geometry=new THREE.PlaneGeometry(aspect,1,40,48);
 const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:false});
 const mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.add(mesh);
 const camera=new THREE.OrthographicCamera(-.5,.5,.5,-.5,.1,10);camera.position.z=2;
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setClearColor(0,0);renderer.domElement.className='ukuku-puppet';
 renderer.domElement.setAttribute('aria-hidden','true');host.append(renderer.domElement);
 const resize=()=>{const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);const ratio=w/h;const size=Math.max(1.15,aspect/ratio*1.15);camera.left=-size*ratio/2;camera.right=size*ratio/2;camera.top=size/2;camera.bottom=-size/2;camera.updateProjectionMatrix();};
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 const positions=geometry.attributes.position;
 const source=new Float32Array(positions.array);
 host.classList.add('has-puppet');
 return {
  render(time:number,chapter:number,still:boolean){
   for(let i=0;i<positions.count;i++){
    const x=source[i*3]/aspect+.5,y=.5-source[i*3+1];
    const p=deformUkuku(x,y,time,chapter,still);positions.setXY(i,(p.x-.5)*aspect,.5-p.y);
   }
   positions.needsUpdate=true;renderer.render(scene,camera);
  },
  dispose(){observer.disconnect();geometry.dispose();material.dispose();texture.dispose();renderer.dispose();renderer.domElement.remove();host.classList.remove('has-puppet');}
 };
}
