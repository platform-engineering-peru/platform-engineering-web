import { wrapIndex } from "../resources/archive-geometry";
document
  .querySelectorAll<HTMLElement>("[data-people-carousel]")
  .forEach((root) => {
    const figures = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-person]"),
    ];
    let active = 0;
    const reduced = matchMedia("(prefers-reduced-motion:reduce)");
    let instantTimer: ReturnType<typeof setTimeout>;
    const select = (index: number, instant = false) => {
      active = wrapIndex(index, figures.length);
      root.classList.toggle("is-instant", instant || reduced.matches);
      clearTimeout(instantTimer);
      figures.forEach((figure, i) => {
        figure.dataset.role =
          i === active
            ? "center"
            : i === wrapIndex(active + 1, figures.length)
              ? "right"
              : "left";
        figure.setAttribute("aria-pressed", String(i === active));
      });
      root.style.setProperty("--people-color", figures[active].dataset.color!);
      root.querySelector("[data-people-ghost]")!.textContent =
        figures[active].dataset.short!.toUpperCase();
      root.querySelector("[data-people-count]")!.textContent =
        `${String(active + 1).padStart(2, "0")} / 03`;
      root
        .querySelectorAll<HTMLElement>("[data-person-profile]")
        .forEach((el, i) => (el.hidden = i !== active));
      instantTimer = setTimeout(() => root.classList.remove("is-instant"), 50);
    };
    select(0, true);
    figures.forEach((figure, i) =>
      figure.addEventListener("click", (e) => select(i, e.detail === 0)),
    );
    root
      .querySelector("[data-people-prev]")!
      .addEventListener("click", (e) =>
        select(active - 1, (e as MouseEvent).detail === 0),
      );
    root
      .querySelector("[data-people-next]")!
      .addEventListener("click", (e) =>
        select(active + 1, (e as MouseEvent).detail === 0),
      );
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        select(active + (e.key === "ArrowRight" ? 1 : -1), true);
      }
    });
    const stage = root.querySelector<HTMLElement>("[data-people-stage]")!;
    let start: { x: number; y: number; id: number } | null = null;
    stage.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      suppressClick = false;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    stage.addEventListener("pointerup", (e) => {
      if (start?.id !== e.pointerId) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        select(active + (dx < 0 ? 1 : -1));
        suppressClick = true;
      }
    });
    let suppressClick = false;
    stage.addEventListener(
      "click",
      (e) => {
        if (suppressClick) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick = false;
        }
      },
      true,
    );
    stage.addEventListener("pointercancel", () => {
      start = null;
    });
  });
