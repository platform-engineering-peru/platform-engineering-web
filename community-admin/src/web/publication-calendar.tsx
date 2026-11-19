import React, { useMemo, useRef, useState } from "react";
import { AppIcon, ProviderLogo } from "./icons";
import {
  calendarDate,
  calendarZone,
  groupPublications,
  monthCells,
  publicationInstant,
  shiftDate,
  shiftMonth,
} from "./calendar";
import "./publication-calendar.css";
export type CalendarPublication = {
  id: string;
  channel: string;
  kind?: "event";
  recordId?: string;
  source?: string;
  destination?: string;
  state: string;
  payload?: { title?: string; text?: string };
  schedule_at?: string | null;
  scheduleAt?: string | null;
};
const weekdays = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const dateLabel = (
  day: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "full" },
) =>
  new Intl.DateTimeFormat("es-PE", { ...options, timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
const title = (record: CalendarPublication) =>
  record.payload?.title ||
  record.payload?.text?.slice(0, 100) ||
  "Publicación sin título";
const states: Record<string, string> = {
  published: "Publicado",
  draft: "Borrador",
  approved: "Aprobado",
  scheduled: "Programado",
  failed: "Error",
  queued: "En cola",
  needs_reconnection: "Requiere reconexión",
  awaiting_approval: "En revisión",
  cancelled: "Cancelado",
};
export function PublicationCalendar({
  items,
  localDrafts = [],
  loading = false,
  onChoose,
  now = new Date(),
}: {
  items: CalendarPublication[];
  localDrafts?: CalendarPublication[];
  loading?: boolean;
  onChoose: (record: CalendarPublication) => void;
  now?: Date;
}) {
  const today = calendarDate(now.toISOString());
  const [month, setMonth] = useState(today.slice(0, 7)),
    [selected, setSelected] = useState(today),
    [view, setView] = useState<"month" | "agenda">("month");
  const grid = useRef<HTMLDivElement>(null);
  const { days, unscheduled } = useMemo(
    () => groupPublications(items),
    [items],
  );
  const cells = monthCells(month);
  const monthEntries = [...days.entries()]
    .filter(([day]) => day.startsWith(month))
    .sort(([a], [b]) => a.localeCompare(b));
  function select(day: string, focus = false) {
    setSelected(day);
    setMonth(day.slice(0, 7));
    if (focus)
      requestAnimationFrame(() =>
        grid.current
          ?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
          ?.focus(),
      );
  }
  function moveMonth(amount: number) {
    const next = shiftMonth(month, amount);
    setMonth(next);
    setSelected(`${next}-01`);
  }
  function records(records: CalendarPublication[]) {
    return (
      <ul className="editorial-activities">
        {records.map((record) => (
          <li key={record.id}>
            <button
              className="editorial-activity"
              onClick={() => onChoose(record)}
            >
              <ProviderLogo provider={record.channel} size={22} />
              <span>
                <strong>{title(record)}</strong>
                <small>
                  {publicationInstant(record)
                    ? new Date(publicationInstant(record)!).toLocaleTimeString(
                        "es-PE",
                        {
                          timeZone: calendarZone,
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      )
                    : "Sin fecha"}{" "}
                  ·{" "}
                  {record.kind === "event"
                    ? "Evento"
                    : record.channel === "youtube"
                      ? "YouTube"
                      : "LinkedIn"}
                  {record.destination ? ` · ${record.destination}` : ""}
                </small>
                <span className="calendar-state">
                  {record.source ?? states[record.state] ?? record.state}
                </span>
              </span>
              <AppIcon name="arrowRight" size={16} />
              <span className="sr-only">
                {record.kind === "event" ? "Abrir evento" : "Abrir publicación"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section
      className="editorial-calendar"
      aria-label="Calendario editorial"
      aria-busy={loading}
    >
      {loading && (
        <p className="calendar-keyboard" role="status">
          Consultando actividades…
        </p>
      )}
      <header className="calendar-toolbar">
        <div>
          <span className="eyebrow">PLAN EDITORIAL</span>
          <h2 aria-live="polite">
            {dateLabel(`${month}-01`, { month: "long", year: "numeric" })}
          </h2>
          <p>America/Lima · UTC−05:00</p>
        </div>
        <div className="calendar-controls">
          <div
            className="calendar-view"
            role="group"
            aria-label="Vista del calendario"
          >
            <button
              aria-pressed={view === "month"}
              onClick={() => setView("month")}
            >
              <AppIcon name="grid" size={17} />
              Mes
            </button>
            <button
              aria-pressed={view === "agenda"}
              onClick={() => setView("agenda")}
            >
              <AppIcon name="list" size={17} />
              Agenda
            </button>
          </div>
          <div
            className="calendar-paging"
            role="group"
            aria-label="Navegar por meses"
          >
            <button aria-label="Mes anterior" onClick={() => moveMonth(-1)}>
              <AppIcon name="arrowLeft" size={18} />
            </button>
            <button onClick={() => select(today)}>Hoy</button>
            <button aria-label="Mes siguiente" onClick={() => moveMonth(1)}>
              <AppIcon name="arrowRight" size={18} />
            </button>
          </div>
        </div>
      </header>
      <div className="calendar-layout">
        <div className="calendar-main">
          {view === "month" ? (
            <>
              <div className="calendar-weekdays" aria-hidden="true">
                {weekdays.map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>
              <div
                ref={grid}
                className="calendar-grid"
                role="grid"
                aria-label={dateLabel(`${month}-01`, {
                  month: "long",
                  year: "numeric",
                })}
              >
                {Array.from({ length: cells.length / 7 }, (_, week) => (
                  <div className="calendar-week" role="row" key={week}>
                    {cells.slice(week * 7, week * 7 + 7).map((day) => {
                      const entries = days.get(day) ?? [];
                      return (
                        <div
                          role="gridcell"
                          aria-selected={day === selected}
                          className="calendar-cell"
                          data-outside={!day.startsWith(month)}
                          data-today={day === today}
                          key={day}
                        >
                          <button
                            className="calendar-date"
                            data-day={day}
                            tabIndex={day === selected ? 0 : -1}
                            aria-current={day === today ? "date" : undefined}
                            aria-label={`${dateLabel(day)} · ${entries.length} actividades`}
                            onClick={() => select(day)}
                            onKeyDown={(e) => {
                              const offsets: Record<string, number> = {
                                ArrowLeft: -1,
                                ArrowRight: 1,
                                ArrowUp: -7,
                                ArrowDown: 7,
                              };
                              if (e.key in offsets) {
                                e.preventDefault();
                                select(shiftDate(day, offsets[e.key]), true);
                              } else if (e.key === "Home" || e.key === "End") {
                                e.preventDefault();
                                const weekday =
                                  (new Date(`${day}T12:00:00Z`).getUTCDay() +
                                    6) %
                                  7;
                                select(
                                  shiftDate(
                                    day,
                                    e.key === "Home" ? -weekday : 6 - weekday,
                                  ),
                                  true,
                                );
                              } else if (
                                e.key === "PageUp" ||
                                e.key === "PageDown"
                              ) {
                                e.preventDefault();
                                select(
                                  `${shiftMonth(day.slice(0, 7), e.key === "PageUp" ? -1 : 1)}-01`,
                                  true,
                                );
                              }
                            }}
                          >
                            <span>{Number(day.slice(-2))}</span>
                            {entries.length > 0 && (
                              <span className="calendar-count">
                                {entries.length}
                                <span className="sr-only"> actividades</span>
                              </span>
                            )}
                          </button>
                          <div className="calendar-chips">
                            {entries.slice(0, 2).map((record) => (
                              <button
                                key={record.id}
                                onClick={() => onChoose(record)}
                                title={title(record)}
                              >
                                <ProviderLogo
                                  provider={record.channel}
                                  size={14}
                                />
                                <span>{title(record)}</span>
                              </button>
                            ))}
                            {entries.length > 2 && (
                              <button
                                className="calendar-more"
                                onClick={() => select(day)}
                              >
                                +{entries.length - 2} más
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <p className="calendar-keyboard">
                Usa las flechas para elegir un día; RePág y AvPág cambian de
                mes.
              </p>
            </>
          ) : (
            <div className="calendar-agenda">
              {monthEntries.length ? (
                monthEntries.map(([day, entries]) => (
                  <section key={day}>
                    <h3>
                      {dateLabel(day, {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })}
                    </h3>
                    {records(entries)}
                  </section>
                ))
              ) : (
                <div className="calendar-empty">
                  <AppIcon name="calendar" size={32} />
                  <h3>Un mes por planificar</h3>
                  <p>
                    No hay actividades con fecha en este mes. Los borradores sin
                    fecha están debajo.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="calendar-day-detail" aria-label="Actividades del día">
          <span className="eyebrow">DÍA SELECCIONADO</span>
          <h3>
            {dateLabel(selected, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </h3>
          <p>{(days.get(selected) ?? []).length} actividades</p>
          {days.get(selected)?.length ? (
            records(days.get(selected)!)
          ) : (
            <div className="calendar-empty">
              <AppIcon name="calendar" size={28} />
              <p>
                {loading ? "Consultando actividades…" : "Este día está libre."}
              </p>
              <small>Abre un borrador para asignarle una fecha.</small>
            </div>
          )}
        </aside>
      </div>
      {localDrafts.length > 0 && (
        <section className="calendar-unscheduled calendar-local-drafts">
          <div className="section-heading">
            <div>
              <h3>
                Cambios locales de eventos <span>{localDrafts.length}</span>
              </h3>
              <p>
                Versiones separadas de la fuente compartida. Una PR abierta
                todavía no cambia el calendario canónico.
              </p>
            </div>
            <AppIcon name="file" size={24} />
          </div>
          {records(localDrafts)}
        </section>
      )}
      <section className="calendar-unscheduled">
        <div className="section-heading">
          <div>
            <h3>
              Sin programar <span>{unscheduled.length}</span>
            </h3>
            <p>
              Borradores y actividades que todavía no tienen una fecha válida.
            </p>
          </div>
          <AppIcon name="inbox" size={24} />
        </div>
        {unscheduled.length ? (
          records(unscheduled)
        ) : (
          <p className="field-help">Todas las actividades tienen fecha.</p>
        )}
      </section>
    </section>
  );
}
