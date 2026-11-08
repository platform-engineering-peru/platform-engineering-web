import { wrapIndex } from "../resources/archive-geometry";
const root = document.querySelector<HTMLElement>("[data-jobs]");
if (root) {
  root.classList.add("is-enhanced");
  const stage = root.querySelector<HTMLElement>("[data-job-stage]")!,
    cards = [...root.querySelectorAll<HTMLButtonElement>("[data-job]")];
  const dialog = root.querySelector<HTMLDialogElement>("[data-job-dialog]")!,
    reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let shown = cards,
    target = 0,
    current = 0,
    raf = 0,
    tx = 0,
    ty = 0,
    x = 0,
    y = 0,
    visible = false;
  let paused = reduced.matches, hovering = false, lastFrame = 0, lastInteraction = 0;
  const motionButton = root.querySelector<HTMLButtonElement>('[data-job-motion]')!;
  const syncMotion = () => {
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.textContent = paused ? '▶ ' + (document.documentElement.lang.startsWith('en') ? 'Play' : 'Reanudar') : 'Ⅱ ' + (document.documentElement.lang.startsWith('en') ? 'Pause' : 'Pausar');
    motionButton.setAttribute('aria-label', document.documentElement.lang.startsWith('en') ? (paused ? 'Resume automatic movement' : 'Pause automatic movement') : (paused ? 'Reanudar movimiento automático' : 'Pausar movimiento automático'));
  };
  const canAuto = () => !paused && !reduced.matches && !hovering && !dialog.open && !root.contains(document.activeElement) && performance.now() - lastInteraction > 2200;
  motionButton.addEventListener('click', () => { paused = !paused; syncMotion(); wake(); });
  root.addEventListener('pointerenter', () => { hovering = true; });
  root.addEventListener('pointerleave', () => { hovering = false; wake(); });
  root.addEventListener('focusout', () => { lastInteraction = performance.now(); wake(); });
  root.addEventListener('pointerdown', () => { lastInteraction = performance.now(); });
  const title = root.querySelector("[data-job-title]")!,
    position = root.querySelector("[data-job-position]")!;
  let lastActive: HTMLButtonElement | undefined;
  const update = () => {
    const i = wrapIndex(Math.round(target), shown.length);
    if (lastActive === shown[i]) return;
    lastActive = shown[i];
    title.textContent = shown[i].querySelector("strong")!.textContent;
    position.textContent = `${String(i + 1).padStart(2, "0")} / ${String(shown.length).padStart(2, "0")}`;
    cards.forEach((c) =>
      c.setAttribute("aria-pressed", String(c === shown[i])),
    );
  };
  const render = (timestamp = performance.now()) => {
    raf = 0;
    if (!visible || document.hidden) return;
    const elapsed = Math.min(50, lastFrame ? timestamp - lastFrame : 0);
    lastFrame = timestamp;
    if (canAuto()) { target += elapsed / 6500; update(); }
    current += (target - current) * (reduced.matches ? 1 : 0.13);
    x += (tx - x) * 0.12;
    y += (ty - y) * 0.12;
    shown.forEach((card, i) => {
      let d = (((i - current) % shown.length) + shown.length) % shown.length;
      if (d > shown.length / 2) d -= shown.length;
      const angle = d * (shown.length < 4 ? 1.2 : 0.95),
        wide = stage.clientWidth > 650;
      const radius = wide ? 420 : 310;
      const px = Math.sin(angle) * radius,
        pz = (Math.cos(angle) - 1) * 260;
      card.style.transform = `translate(-50%,-50%) translate3d(${px}px,${Math.sin(angle) * -20}px,${pz}px) rotateY(${-angle * 45 + x * 7}deg) rotateX(${-y * 5}deg)`;
      card.style.zIndex = String(10 - Math.round(Math.abs(d) * 2));
      // Opacity on the 3D parent flattens its faces and exposes the back through the front.
      card.style.setProperty('--card-shade', String(Math.min(0.36, Math.abs(d) * 0.14)));
      card.tabIndex = Math.abs(d) < 0.51 ? 0 : -1;
    });
    if (
      (!paused && !reduced.matches && !hovering && !dialog.open && !root.contains(document.activeElement)) ||
      Math.abs(target - current) > 0.001 ||
      Math.abs(tx - x) + Math.abs(ty - y) > 0.005
    )
      raf = requestAnimationFrame(render);
  };
  const wake = () => {
    if (!raf && visible && !document.hidden)
      raf = requestAnimationFrame(render);
  };
  const move = (delta: number, instant = false) => {
    lastInteraction = performance.now();
    target = Math.round(target) + delta;
    if (instant || reduced.matches) current = target;
    update();
    wake();
  };
  root
    .querySelector("[data-job-prev]")!
    .addEventListener("click", (e) => move(-1, (e as MouseEvent).detail === 0));
  root
    .querySelector("[data-job-next]")!
    .addEventListener("click", (e) => move(1, (e as MouseEvent).detail === 0));

  // Vertical wheel still scrolls the page; horizontal gestures control the cylinder.
  stage.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (horizontal) event.preventDefault();
    lastInteraction = performance.now();
    const delta = horizontal ? event.deltaX : event.deltaY;
    const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    target += Math.max(-160, Math.min(160, pixels)) / 380;
    if (reduced.matches) current = target;
    update(); wake();
  }, {passive:false});
  let origin: HTMLElement | null = null,
    oldOverflow = "";
  const open = (card: HTMLButtonElement) => {
    origin = document.activeElement as HTMLElement;
    const template = root.querySelector<HTMLTemplateElement>(
      `[data-job-template="${card.dataset.job}"]`,
    )!;
    root
      .querySelector("[data-job-content]")!
      .replaceChildren(template.content.cloneNode(true));
    oldOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
  };
  cards.forEach((card) =>
    card.addEventListener("click", () => {
      if (suppress) {
        suppress = false;
        return;
      }
      const i = shown.indexOf(card),
        active = wrapIndex(Math.round(target), shown.length);
      if (i === active) open(card);
      else move(i - active);
    }),
  );
  root
    .querySelector("[data-job-open]")!
    .addEventListener("click", () =>
      open(shown[wrapIndex(Math.round(target), shown.length)]),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-job-list]")
    .forEach((b) =>
      b.addEventListener("click", () => open(cards[Number(b.dataset.jobList)])),
    );
  root
    .querySelector("[data-job-close]")!
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
      open(shown[wrapIndex(Math.round(target), shown.length)]);
    }
  });
  let down: { x: number; y: number } | null = null,
    suppress = false;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    down = { x: e.clientX, y: e.clientY };
    suppress = false;
  });
  stage.addEventListener("pointermove", (e) => {
    if (reduced.matches || e.pointerType === "touch") return;
    const r = stage.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    wake();
  });
  stage.addEventListener("pointerleave", () => {
    tx = ty = 0;
    down = null;
    wake();
  });
  stage.addEventListener("pointercancel", () => {
    down = null;
  });
  stage.addEventListener("pointerup", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x,
      dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      suppress = true;
      move(dx < 0 ? 1 : -1);
    }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-job-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      shown = cards.filter(
        (c) =>
          b.dataset.jobFilter === "all" ||
          c.dataset.mode === b.dataset.jobFilter,
      );
      cards.forEach((c) => (c.hidden = !shown.includes(c)));
      root
        .querySelectorAll("[data-job-filter]")
        .forEach((f) => f.setAttribute("aria-pressed", String(f === b)));
      lastActive = undefined;
      target = current = 0;
      root.querySelector("[data-job-count]")!.textContent =
        String(shown.length).padStart(2, "0") +
        " / " +
        (document.documentElement.lang.startsWith("en")
          ? "OPPORTUNITIES"
          : "OPORTUNIDADES");
      update();
      wake();
    }),
  );
  new ResizeObserver(wake).observe(stage);
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    lastFrame = 0;
    if (visible) wake();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }).observe(stage);
  document.addEventListener("visibilitychange", wake);
  reduced.addEventListener("change", () => {
    paused = reduced.matches; syncMotion();
    tx = ty = x = y = 0;
    current = target;
    wake();
  });
  syncMotion();
  update();
  wake();
}
