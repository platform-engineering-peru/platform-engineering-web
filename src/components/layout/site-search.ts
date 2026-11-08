import { searchEntries } from "../../lib/search";
const dialog = document.querySelector<HTMLDialogElement>("[data-site-search]");
if (dialog) {
  const entries = JSON.parse(dialog.dataset.entries!) as {
    title: string;
    text: string;
    href: string;
    kind: string;
  }[];
  const query = dialog.querySelector<HTMLInputElement>("[data-site-query]")!;
  const results = dialog.querySelector<HTMLElement>("[data-site-results]")!;
  let oldOverflow = "";
  const render = () => {
    const matches = searchEntries(entries, query.value);
    dialog.querySelector("[data-site-result-count]")!.textContent =
      `${matches.length} ${matches.length === 1 ? dialog.dataset.countSingular : dialog.dataset.countLabel}`;
    results.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "site-search__empty";
      empty.textContent = dialog.dataset.empty!;
      results.append(empty);
      return;
    }
    matches.forEach((entry) => {
      const link = document.createElement("a");
      link.href = entry.href;
      if (entry.href.startsWith("https://")) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      const body = document.createElement("span"),
        type = document.createElement("small"),
        title = document.createElement("strong"),
        arrow = document.createElement("span");
      type.textContent = entry.kind;
      title.textContent = entry.title;
      arrow.textContent = "↗";
      arrow.setAttribute("aria-hidden", "true");
      body.append(type, title);
      link.append(body, arrow);
      results.append(link);
    });
  };
  const open = () => {
    if (document.querySelector("dialog[open]")) return;
    oldOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    render();
    dialog.showModal();
    query.focus();
  };
  document
    .querySelectorAll("[data-search-open]")
    .forEach((button) => button.addEventListener("click", open));
  dialog
    .querySelector("[data-search-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    document.documentElement.style.overflow = oldOverflow;
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  });
  query.addEventListener("input", render);
  dialog.addEventListener("keydown", (event) => {
    const links = [...results.querySelectorAll("a")];
    if (!links.length) return;
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      links[(index + 1) % links.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index <= 0) query.focus();
      else links[index - 1].focus();
    } else if (event.key === "Enter" && event.target === query) {
      event.preventDefault();
      links[0].click();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (dialog.open) dialog.close();
      else open();
    }
  });
}
