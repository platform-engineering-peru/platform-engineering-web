const header = document.querySelector<HTMLElement>("[data-header]");
if (header) {
  const menus = [...header.querySelectorAll<HTMLDetailsElement>("[data-mega]")];
  const close = (except?: HTMLDetailsElement) =>
    menus.forEach((m) => {
      if (m !== except) m.open = false;
    });
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) close(menu);
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });
  });
  document.addEventListener("click", (e) => {
    if (!header.contains(e.target as Node)) close();
  });
  header.addEventListener("focusout", (event) => {
    // Safari can clear focus on pointerdown without focusing the clicked link.
    // Hiding the panel here would remove that link before pointerup/click.
    // A real keyboard focus destination outside the header may close it safely;
    // pointer clicks outside are handled by the document click listener above.
    const destination = event.relatedTarget;
    if (destination instanceof Node && !header.contains(destination)) close();
  });
  header
    .querySelectorAll<HTMLAnchorElement>("a[href]")
    .forEach((link) => link.addEventListener("click", () => {
      close();
      header.classList.remove("is-open");
      header.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
    }));
  header
    .querySelectorAll("[data-search-open], [data-join-open]")
    .forEach((button) => button.addEventListener("click", () => close()));
}
