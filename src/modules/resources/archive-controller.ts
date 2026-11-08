import { arcPose, relativeIndex, wrapIndex } from "./archive-geometry";
import { searchEntries } from "../../lib/search";

document
  .querySelectorAll<HTMLElement>("[data-resource-archive]")
  .forEach((root) => {
    const shelf = root.querySelector<HTMLElement>("[data-archive-shelf]")!;
    const tapes = [...root.querySelectorAll<HTMLButtonElement>("[data-tape]")];
    const input = root.querySelector<HTMLInputElement>(
      "[data-archive-search]",
    )!;
    const range = root.querySelector<HTMLInputElement>("[data-archive-range]")!;
    const dialog = root.querySelector<HTMLDialogElement>(
      "[data-archive-detail]",
    )!;
    const reduced = matchMedia("(prefers-reduced-motion:reduce)");
    let filtered = [...tapes],
      topic = "all",
      position = 0,
      target = 0,
      frame = 0,
      lastTime = 0,
      active = -1,
      height = 280,
      visible = true;
    let drag: {
        id: number;
        x: number;
        y: number;
        target: number;
        active: boolean;
      } | null = null,
      suppressClick = false,
      previousFocus: HTMLElement | null = null,
      oldOverflow = "";
    const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
      root.querySelector<T>(selector)!;
    const render = () => {
      filtered.forEach((tape, i) => {
        const pose = arcPose(
          relativeIndex(i, position, filtered.length),
          height,
          innerWidth < 768,
        );
        tape.style.transform = `translate3d(${pose.x}px,${pose.y}px,${pose.z}px) rotateY(${pose.rotation}deg)`;
        tape.style.zIndex = String(Math.round(3000 + pose.z));
        tape.style.setProperty("--shade", String(pose.shade));
        tape.style.setProperty("--front-shade", String((1 - pose.open) * 0.82));
        tape.tabIndex =
          i === wrapIndex(Math.round(position), filtered.length) ? 0 : -1;
      });
    };
    const updateCaption = () => {
      const index = wrapIndex(Math.round(target), filtered.length);
      if (!filtered.length || active === index) return;
      active = index;
      const tape = filtered[index];
      const title = get("[data-active-title]");
      title.textContent = tape.dataset.title!;
      get("[data-active-meta]").textContent = tape.dataset.meta!;
      get("[data-active-number]").textContent =
        `${String(index + 1).padStart(2, "0")} / ${String(filtered.length).padStart(2, "0")}`;
      range.value = String(index + 1);
      range.setAttribute("aria-valuetext", tape.dataset.title!);
    };
    const tick = (time: number) => {
      frame = 0;
      const dt = Math.min((time - lastTime) / 1000 || 0.016, 0.05);
      lastTime = time;
      position +=
        (target - position) * (1 - Math.exp(-(drag?.active ? 18 : 9) * dt));
      if (Math.abs(target - position) < 0.001) position = target;
      render();
      if (position !== target && visible && !dialog.open)
        frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frame && visible && !dialog.open) {
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    const go = (next: number, instant = false) => {
      if (!filtered.length) return;
      target = next;
      updateCaption();
      if (reduced.matches || instant) {
        cancelAnimationFrame(frame);
        frame = 0;
        position = target;
        render();
      } else start();
    };
    const measure = () => {
      height = Math.min(
        innerWidth < 768 ? innerWidth * 0.57 : innerWidth * 0.245,
        innerWidth < 768 ? 285 : 310,
      );
      shelf.style.setProperty("--tape-h", `${height}px`);
      shelf.style.setProperty("--spine-w", `${(height * 142) / 840}px`);
      shelf.style.setProperty("--cover-w", `${(height * 474) / 900}px`);
      render();
    };
    const filter = () => {
      const entries = tapes
        .filter((t) => topic === "all" || t.dataset.topic === topic)
        .map((tape) => ({
          title: tape.dataset.title!,
          text: tape.dataset.text!,
          tape,
        }));
      filtered = searchEntries(entries, input.value).map((x) => x.tape);
      tapes.forEach((t) => (t.hidden = !filtered.includes(t)));
      get("[data-archive-count]").textContent =
        `${filtered.length} ${get("[data-archive-count]").dataset.label}`;
      get("[data-archive-caption]").hidden = !filtered.length;
      get("[data-archive-empty]").hidden = !!filtered.length;
      get("[data-archive-ruler]").hidden = !filtered.length;
      shelf.hidden = !filtered.length;
      range.max = String(Math.max(1, filtered.length));
      get("[data-ruler-caption]").textContent =
        `01 — ${String(filtered.length).padStart(2, "0")}`;
      get(".archive-ruler__ticks").replaceChildren(
        ...filtered.map((_, i) => {
          const span = document.createElement("span");
          span.textContent = String(i + 1).padStart(2, "0");
          return span;
        }),
      );
      root
        .querySelectorAll<HTMLButtonElement>(
          "[data-archive-prev],[data-archive-next]",
        )
        .forEach((b) => (b.disabled = filtered.length < 2));
      active = -1;
      position = 0;
      go(0, true);
    };
    const selectTape = (tape: HTMLButtonElement, instant = false) => {
      const index = filtered.indexOf(tape);
      go(
        target +
          relativeIndex(
            index,
            wrapIndex(Math.round(target), filtered.length),
            filtered.length,
          ),
        instant,
      );
    };
    const open = (instant = false) => {
      if (!filtered.length || dialog.open) return;
      go(Math.round(target), true);
      const tape = filtered[wrapIndex(Math.round(target), filtered.length)];
      const template = get<HTMLTemplateElement>(
        `[data-resource-detail="${tape.dataset.tape}"]`,
      );
      get("[data-archive-detail-body]").replaceChildren(
        template.content.cloneNode(true),
      );
      previousFocus = document.activeElement as HTMLElement;
      oldOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      dialog.showModal();
      const rect = tape
        .querySelector(".archive-front")!
        .getBoundingClientRect();
      if (!reduced.matches && !instant)
        dialog.animate(
          [
            {
              clipPath: `inset(${Math.max(0, rect.top)}px ${Math.max(0, innerWidth - rect.right)}px ${Math.max(0, innerHeight - rect.bottom)}px ${Math.max(0, rect.left)}px round 3px)`,
            },
            { clipPath: "inset(0px 0px 0px 0px round 0px)" },
          ],
          { duration: 480, easing: "cubic-bezier(.22,.8,.2,1)" },
        );
    };
    const close = () => {
      dialog.close();
    };
    get("[data-archive-close]").addEventListener("click", close);
    dialog.addEventListener("close", () => {
      document.documentElement.style.overflow = oldOverflow;
      previousFocus?.focus();
    });
    get("[data-archive-open]").addEventListener("click", (e) =>
      open((e as MouseEvent).detail === 0),
    );
    tapes.forEach((tape) =>
      tape.addEventListener("click", (e) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (
          filtered.indexOf(tape) ===
          wrapIndex(Math.round(target), filtered.length)
        )
          open(e.detail === 0);
        else selectTape(tape, e.detail === 0);
      }),
    );
    get("[data-archive-prev]").addEventListener("click", (e) =>
      go(Math.round(target) - 1, (e as MouseEvent).detail === 0),
    );
    get("[data-archive-next]").addEventListener("click", (e) =>
      go(Math.round(target) + 1, (e as MouseEvent).detail === 0),
    );
    shelf.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        go(Math.round(target) + (e.key === "ArrowRight" ? 1 : -1), true);
      } else if (e.key === "Enter" && e.target === shelf) {
        e.preventDefault();
        open(true);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        go(e.key === "Home" ? 0 : filtered.length - 1, true);
      }
    });
    range.addEventListener("input", () => go(Number(range.value) - 1, true));
    input.addEventListener("input", filter);
    get("[data-archive-filters]")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) =>
        button.addEventListener("click", () => {
          topic = button.dataset.topic!;
          get("[data-archive-filters]")
            .querySelectorAll("button")
            .forEach((b) =>
              b.setAttribute("aria-pressed", String(b === button)),
            );
          filter();
        }),
      );
    get("[data-archive-reset]").addEventListener("click", () => {
      input.value = "";
      topic = "all";
      get("[data-archive-filters]")
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((b) =>
          b.setAttribute("aria-pressed", String(b.dataset.topic === "all")),
        );
      filter();
      input.focus();
    });
    shelf.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || e.button !== 0 || filtered.length < 2) return;
      suppressClick = false;
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        target,
        active: false,
      };
    });
    shelf.addEventListener(
      "pointermove",
      (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x,
          dy = e.clientY - drag.y;
        if (!drag.active) {
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
            drag = null;
            return;
          }
          if (Math.abs(dx) < 6) return;
          drag.active = true;
          shelf.setPointerCapture(e.pointerId);
          shelf.classList.add("is-dragging");
        }
        go(drag.target - dx / (height * 0.23));
      },
      { passive: true },
    );
    const endDrag = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const moved = drag.active;
      drag = null;
      shelf.classList.remove("is-dragging");
      if (shelf.hasPointerCapture(e.pointerId))
        shelf.releasePointerCapture(e.pointerId);
      if (moved) {
        suppressClick = true;
        go(Math.round(target));
      }
    };
    shelf.addEventListener("click", (event) => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    }, true);
    shelf.addEventListener("pointerup", endDrag);
    shelf.addEventListener("pointercancel", endDrag);
    // Vertical wheel scrolling remains page scrolling; horizontal trackpad movement scrubs the shelf.
    shelf.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || filtered.length < 2)
          return;
        e.preventDefault();
        go(target + (e.deltaX / (height * 0.23)) * 0.35);
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => go(Math.round(target)), 140);
      },
      { passive: false },
    );
    let wheelTimer: ReturnType<typeof setTimeout>;
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "/" &&
        !document.querySelector("dialog[open]") &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable) &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        input.focus();
      }
    });
    reduced.addEventListener("change", () => go(Math.round(target), true));
    const resize = new ResizeObserver(measure);
    resize.observe(shelf);
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    observer.observe(shelf);
    root.classList.add("is-ready");
    measure();
    filter();
    document.addEventListener(
      "astro:before-swap",
      () => {
        cancelAnimationFrame(frame);
        clearTimeout(wheelTimer);
        resize.disconnect();
        observer.disconnect();
      },
      { once: true },
    );
  });
