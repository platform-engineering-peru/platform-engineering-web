import * as THREE from "three";
import { wrapIndex } from "../resources/archive-geometry";
const root = document.querySelector<HTMLElement>("[data-memories]");
if (root) {
  const stage = root.querySelector<HTMLElement>("[data-memory-stage]")!,
    tiles = [...root.querySelectorAll<HTMLButtonElement>("[data-memory-tile]")],
    mount = root.querySelector<HTMLElement>("[data-memory-canvas]")!;
  const reduced = matchMedia("(prefers-reduced-motion:reduce)"),
    desktop = matchMedia("(min-width:651px)"),
    dialog = root.querySelector<HTMLDialogElement>("[data-memory-dialog]")!;
  let index = 0,
    target = 0,
    current = 0,
    raf = 0,
    visible = true,
    renderer: THREE.WebGLRenderer | undefined,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    meshes: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [],
    width = 1,
    height = 1,
    oldOverflow = "",
    origin: HTMLElement | null = null;
  const vertex = `varying vec2 vUv; varying float vDepth; uniform float uCenter; uniform float uWidth; uniform float uVelocity; void main(){vUv=uv; vec3 p=position; p.x*=380.;p.y*=255.;p.x+=uCenter;float q=p.x/uWidth*3.2-.2;float curve=sin(q*3.14159)*exp(-q*q*.5);float depth=curve*(70.+abs(uVelocity)*18.);p.y+=depth*.43; p.y+=sin(q*2.)*p.y*.07;vDepth=curve;gl_Position=projectionMatrix*modelViewMatrix*vec4(p.x,p.y,-depth*1.8,1.);}`;
  const fragment = `varying vec2 vUv;varying float vDepth;uniform sampler2D uTexture; void main(){vec2 p=abs(vUv-.5)-vec2(.47,.46);float d=length(max(p,0.))+min(max(p.x,p.y),0.)-.025;float a=1.-smoothstep(-.003,.003,d);vec3 c=texture2D(uTexture,vUv).rgb;c*=1.-max(0.,vDepth)*.48;gl_FragColor=vec4(c,a);}`;
  function texture(tile: HTMLElement, i: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 1000;
    canvas.height = 670;
    const c = canvas.getContext("2d")!;
    const col = tile.style.getPropertyValue("--memory-color");
    c.fillStyle = col;
    c.fillRect(0, 0, 1000, 670);
    const g = c.createLinearGradient(0, 0, 1000, 670);
    g.addColorStop(0, "#ffffff99");
    g.addColorStop(1, "#ffffff00");
    c.fillStyle = g;
    c.fillRect(0, 0, 1000, 670);
    c.save();
    c.translate(510, 310);
    c.rotate(-0.3 + i * 0.09);
    for (let k = 0; k < 7; k++) {
      c.strokeStyle = `rgba(35,23,48,${0.5 - k * 0.045})`;
      c.lineWidth = 2;
      c.strokeRect(-160 + k * 18, -170 + k * 24, 310, 270);
    }
    c.restore();
    c.fillStyle = "#ffffff65";
    c.font = "500 260px sans-serif";
    c.fillText(String(i + 1).padStart(2, "0"), 35, 500);
    c.fillStyle = "#24182e";
    c.font = "22px sans-serif";
    c.fillText("PE / COLLECTIVE MEMORY", 45, 55);
    c.font = "32px sans-serif";
    c.fillText("Lorem ipsum / " + String(i + 1).padStart(2, "0"), 45, 610);
    c.fillText("↗", 900, 610);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const render = () => {
    raf = 0;
    if (!renderer || !visible || document.hidden || !desktop.matches) return;
    current += (target - current) * (reduced.matches ? 1 : 0.085);
    const gap = 405,
      L = gap * tiles.length;
    meshes.forEach((m, i) => {
      let x = ((((i * gap - current + L / 2) % L) + L) % L) - L / 2;
      m.material.uniforms.uCenter.value = x;
      m.material.uniforms.uWidth.value = width;
      m.material.uniforms.uVelocity.value = Math.min(
        5,
        Math.abs(target - current) / 160,
      );
    });
    renderer.render(scene, camera);
    if (Math.abs(target - current) > 0.05) raf = requestAnimationFrame(render);
  };
  const wake = () => {
    if (!raf && visible && !document.hidden)
      raf = requestAnimationFrame(render);
  };
  const resize = () => {
    if (!renderer) return;
    width = stage.clientWidth;
    height = stage.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.fov = (2 * Math.atan(height / 2000) * 180) / Math.PI;
    camera.updateProjectionMatrix();
    root.classList.toggle("is-webgl", desktop.matches);
    tiles.forEach((t) => (t.tabIndex = desktop.matches ? -1 : 0));
    wake();
  };
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 3000);
    camera.position.z = 1000;
    tiles.forEach((tile, i) => {
      const material = new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          uTexture: { value: texture(tile, i) },
          uCenter: { value: 0 },
          uWidth: { value: 1 },
          uVelocity: { value: 0 },
        },
        transparent: true,
        depthTest: false,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 72, 12), material);
      scene.add(m);
      meshes.push(m);
    });
    mount.append(renderer.domElement);
    resize();
    new ResizeObserver(resize).observe(stage);
    renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      renderer = undefined;
      root.classList.remove("is-webgl");
      tiles.forEach((t) => (t.tabIndex = 0));
      cancelAnimationFrame(raf);
      raf = 0;
    });
  } catch (error) {
    console.warn("Memories renderer unavailable:", error);
    root.classList.remove("is-webgl");
    renderer = undefined;
  }
  const update = () => {
    index = wrapIndex(Math.round(target / 405), tiles.length);
    root.querySelector("[data-memory-count]")!.textContent =
      String(index + 1).padStart(2, "0") + " / 08";
  };
  const move = (delta: number, instant = false) => {
    target += delta * 405;
    if (instant || reduced.matches) current = target;
    update();
    if (!desktop.matches || !renderer)
      tiles[index].scrollIntoView({
        behavior: "instant",
        block: "nearest",
        inline: "center",
      });
    wake();
  };
  const open = () => {
    root.querySelector("[data-memory-id]")!.textContent = String(
      index + 1,
    ).padStart(2, "0");
    (root.querySelector("[data-memory-art]") as HTMLElement).style.setProperty(
      "--memory-color",
      tiles[index].style.getPropertyValue("--memory-color"),
    );
    origin = document.activeElement as HTMLElement;
    oldOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
  };
  const fallback = root.querySelector<HTMLElement>("[data-memory-fallback]")!;
  fallback.addEventListener(
    "scroll",
    () => {
      if (desktop.matches && renderer) return;
      const center =
        fallback.getBoundingClientRect().left + fallback.clientWidth / 2;
      const nearest = tiles.reduce(
        (best, tile, i) => {
          const rect = tile.getBoundingClientRect();
          const distance = Math.abs(rect.left + rect.width / 2 - center);
          return distance < best.distance ? { index: i, distance } : best;
        },
        { index: 0, distance: Infinity },
      );
      target = current = nearest.index * 405;
      update();
    },
    { passive: true },
  );
  root
    .querySelector("[data-memory-prev]")!
    .addEventListener("click", (e) => move(-1, (e as MouseEvent).detail === 0));
  root
    .querySelector("[data-memory-next]")!
    .addEventListener("click", (e) => move(1, (e as MouseEvent).detail === 0));
  root.querySelector("[data-memory-open]")!.addEventListener("click", open);
  tiles.forEach((t, i) =>
    t.addEventListener("click", () => {
      index = i;
      target = current = i * 405;
      update();
      open();
      wake();
    }),
  );
  root
    .querySelector("[data-memory-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    document.documentElement.style.overflow = oldOverflow;
    origin?.focus({ preventScroll: true });
  });
  stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      move(e.key === "ArrowRight" ? 1 : -1, true);
    }
    if (e.key === "Enter" && e.target === stage) {
      e.preventDefault();
      open();
    }
  });
  let down: { x: number; y: number; t: number } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary || !desktop.matches || !renderer) return;
    down = { x: e.clientX, y: e.clientY, t: target };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      target = down.t - dx * 1.5;
      update();
      wake();
    }
  });
  stage.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    down = null;
    target = Math.round(target / 405) * 405;
    update();
    wake();
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const rect = stage.getBoundingClientRect();
      const offset = Math.round((e.clientX - rect.left - rect.width / 2) / 405);
      if (offset) move(offset);
      else open();
    }
  });
  stage.addEventListener("pointercancel", () => {
    down = null;
  });
  stage.addEventListener("pointerleave", () => {
    if (down) {
      down = null;
      target = Math.round(target / 405) * 405;
      wake();
    }
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && desktop.matches) {
        e.preventDefault();
        target += e.deltaX;
        update();
        wake();
      }
    },
    { passive: false },
  );
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) wake();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }).observe(stage);
  document.addEventListener("visibilitychange", wake);
  desktop.addEventListener("change", resize);
  reduced.addEventListener("change", () => {
    current = target;
    wake();
  });
}
