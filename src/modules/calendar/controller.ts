import {
  limaDay,
  monthActivities,
  monthCells,
  shiftDay,
  shiftMonth,
} from "./model";
import type { ActivityView } from "./view";

/** Progressive enhancement: the server-rendered monthly agenda remains usable without JavaScript. */
export function initializeCalendars() {
  document
    .querySelectorAll<HTMLElement>("[data-tech-calendar]")
    .forEach((root) => {
      if (root.dataset.initialized) return;
      root.dataset.initialized = "true";
      const en = root.dataset.lang === "en";
      const locale = en ? "en" : "es-PE";
      const activities = JSON.parse(
        root.dataset.activities ?? "[]",
      ) as ActivityView[];
      const today = root.dataset.today!;
      let selected = today,
        month = today.slice(0, 7);
      const grid = root.querySelector<HTMLElement>("[data-calendar-grid]")!;
      const monthLabel = root.querySelector<HTMLElement>("[data-month-label]")!;
      const dayLabel = root.querySelector<HTMLElement>("[data-day-label]")!;
      const monthList = root.querySelector<HTMLElement>(
        "[data-month-activities]",
      )!;
      const dayList = root.querySelector<HTMLElement>("[data-day-activities]")!;
      const format = (day: string, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
          new Date(day + "T12:00:00Z"),
        );
      const element = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        text?: string,
      ) => {
        const el = document.createElement(tag);
        if (text) el.textContent = text;
        return el;
      };
      function list(target: HTMLElement, items: ActivityView[]) {
        target.replaceChildren();
        if (!items.length) {
          const empty = element(
            "p",
            en
              ? "No activities scheduled for these dates."
              : "No hay actividades programadas para estas fechas.",
          );
          empty.className = "calendar-empty";
          target.append(empty);
          return;
        }
        items.forEach((item) => {
          const article = element("article");
          article.className = "calendar-activity";
          const time = element(
            "time",
            `${format(limaDay(item.startsAt), { day: "numeric", month: "short" })} · ${item.time}`,
          );
          time.dateTime = item.startsAt;
          const title = element("h4");
          const link = element("a", item.title + " ↗");
          link.href = item.href;
          title.append(link);
          article.append(time, title);
          if (item.community)
            article.append(
              element(
                "p",
                (item.kind === "guest"
                  ? en
                    ? "Invited community: "
                    : "Comunidad invitada: "
                  : item.kind === "own"
                    ? en
                      ? "Our community: "
                      : "Nuestra comunidad: "
                    : "") + item.community,
              ),
            );
          article.append(element("p", item.venue));
          if (item.sourceZone !== "America/Lima")
            article.append(
              element(
                "p",
                (en ? "Original time zone: " : "Zona horaria de origen: ") +
                  item.sourceZone,
              ),
            );
          if (item.sourceUrl) {
            const source = element(
              "a",
              en ? "Activity source ↗" : "Fuente de la actividad ↗",
            );
            source.href = item.sourceUrl;
            source.rel = "noopener noreferrer";
            source.className = "calendar-source";
            article.append(source);
          }
          target.append(article);
        });
      }
      function render(focus = false) {
        monthLabel.textContent = format(month + "-01", {
          month: "long",
          year: "numeric",
        });
        const items = monthActivities(activities, month);
        grid.replaceChildren();
        const header = element("div");
        header.setAttribute("role", "row");
        header.className = "calendar-week";
        for (let i = 0; i < 7; i++) {
          const name = element(
            "span",
            format(shiftDay("2026-11-16", i), { weekday: "short" }),
          );
          name.setAttribute("role", "columnheader");
          header.append(name);
        }
        grid.append(header);
        const cells = monthCells(month);
        for (let week = 0; week < cells.length; week += 7) {
          const row = element("div");
          row.className = "calendar-week";
          row.setAttribute("role", "row");
          cells.slice(week, week + 7).forEach((day) => {
            const cell = element("div");
            cell.setAttribute("role", "gridcell");
            if (day) {
              const dayItems = items.filter(
                (item) => limaDay(item.startsAt) === day,
              );
              const button = element("button", String(Number(day.slice(-2))));
              button.type = "button";
              button.dataset.day = day;
              button.tabIndex = day === selected ? 0 : -1;
              button.setAttribute(
                "aria-label",
                format(day, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }) +
                  ` · ${dayItems.length} ` +
                  (en ? "activities" : "actividades"),
              );
              button.setAttribute("aria-pressed", String(day === selected));
              cell.setAttribute("aria-selected", String(day === selected));
              if (day === today) button.setAttribute("aria-current", "date");
              if (dayItems.length) {
                const count = element("span", String(dayItems.length));
                count.className = "calendar-count";
                count.setAttribute("aria-hidden", "true");
                button.append(count);
              }
              button.addEventListener("click", () => {
                selected = day;
                render(true);
              });
              button.addEventListener("keydown", (e) => {
                const offset = (
                  {
                    ArrowLeft: -1,
                    ArrowRight: 1,
                    ArrowUp: -7,
                    ArrowDown: 7,
                  } as Record<string, number>
                )[e.key];
                if (offset !== undefined) {
                  e.preventDefault();
                  selected = shiftDay(day, offset);
                } else if (e.key === "Home" || e.key === "End") {
                  e.preventDefault();
                  const weekday =
                    (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
                  selected = shiftDay(
                    day,
                    e.key === "Home" ? -weekday : 6 - weekday,
                  );
                } else if (e.key === "PageUp" || e.key === "PageDown") {
                  e.preventDefault();
                  selected =
                    shiftMonth(month, e.key === "PageUp" ? -1 : 1) + "-01";
                } else return;
                month = selected.slice(0, 7);
                render(true);
              });
              cell.append(button);
            }
            row.append(cell);
          });
          grid.append(row);
        }
        dayLabel.textContent = format(selected, {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        list(
          dayList,
          items.filter((item) => limaDay(item.startsAt) === selected),
        );
        list(monthList, items);
        if (focus)
          grid
            .querySelector<HTMLButtonElement>(`[data-day="${selected}"]`)
            ?.focus({ preventScroll: true });
      }
      root
        .querySelectorAll<HTMLButtonElement>("[data-month-step]")
        .forEach((button) =>
          button.addEventListener("click", () => {
            month = shiftMonth(month, Number(button.dataset.monthStep));
            selected = month + "-01";
            render();
          }),
        );
      root
        .querySelector<HTMLButtonElement>("[data-calendar-today]")!
        .addEventListener("click", () => {
          selected = limaDay(new Date());
          month = selected.slice(0, 7);
          render(true);
        });
      root.querySelector<HTMLElement>("[data-calendar-controls]")!.hidden =
        false;
      root.querySelector<HTMLElement>("[data-month-view]")!.hidden = false;
      render();
    });
}
