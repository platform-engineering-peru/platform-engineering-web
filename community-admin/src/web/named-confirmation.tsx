import { createPortal } from "react-dom";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  confirmationAllowed,
  sameConfirmationTarget,
  type ConfirmationTarget,
} from "./confirmation-intent";
/** Each confirmation captures one displayed revision; callers retain their existing domain API. */
export function NamedConfirmation({
  target,
  label,
  title,
  description,
  confirmLabel,
  minReasonLength = 0,
  reasonLabel = "Motivo de la eliminación",
  disabled = false,
  onConfirm,
}: {
  target: ConfirmationTarget;
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  minReasonLength?: number;
  reasonLabel?: string;
  disabled?: boolean;
  onConfirm: (intent: {
    target: ConfirmationTarget;
    reason: string;
  }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const [captured, setCaptured] = useState<ConfirmationTarget | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const live = useRef({ target, disabled });
  live.current = { target, disabled };
  const titleId = useId(),
    descriptionId = useId(),
    reasonId = useId();
  useEffect(() => {
    const wasOpen = dialog.current?.open;
    dialog.current?.close();
    if (wasOpen && trigger.current?.isConnected) trigger.current.focus();
    setCaptured(null);
    setReason("");
    setError("");
  }, [target.module, target.id, target.version, target.action]);
  useEffect(
    () => () => {
      dialog.current?.close();
    },
    [],
  );
  function close() {
    if (busy) return;
    dialog.current?.close();
    setCaptured(null);
    setReason("");
    setError("");
    if (trigger.current?.isConnected) trigger.current.focus();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (
      !confirmationAllowed(
        live.current.target,
        captured,
        live.current.disabled,
        busy || pending.current,
        reason,
        minReasonLength,
      )
    )
      return;
    const intent = { target: { ...captured! }, reason: reason.trim() };
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm(intent);
      if (sameConfirmationTarget(live.current.target, intent.target)) {
        dialog.current?.close();
        setCaptured(null);
        setReason("");
        if (trigger.current?.isConnected) trigger.current.focus();
      }
    } catch (e) {
      if (sameConfirmationTarget(live.current.target, intent.target))
        setError(
          e instanceof Error
            ? e.message
            : "No se completó la acción. No cambies de revisión antes de comprobar el resultado.",
        );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        ref={trigger}
        disabled={disabled || busy}
        onClick={() => {
          if (disabled || busy) return;
          setCaptured({ ...target });
          setReason("");
          setError("");
          dialog.current?.showModal();
          cancel.current?.focus();
        }}
      >
        {label}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <dialog
            ref={dialog}
            className="named-confirmation"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
          >
            <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
              <h2 id={titleId}>
                {title} «{captured?.name ?? target.name}»
              </h2>
              <p id={descriptionId}>{description}</p>
              <p className="field-help">
                Revisión: {String(captured?.version ?? target.version)}
              </p>
              {minReasonLength > 0 && (
                <label htmlFor={reasonId}>
                  {reasonLabel}
                  <textarea
                    id={reasonId}
                    value={reason}
                    disabled={busy}
                    minLength={minReasonLength}
                    required
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              )}
              {error && (
                <p className="alert" role="alert">
                  {error}
                </p>
              )}
              {busy && <p role="status">Procesando la acción confirmada…</p>}
              <div className="named-confirmation-actions">
                <button
                  type="button"
                  ref={cancel}
                  disabled={busy}
                  onClick={close}
                >
                  Volver sin cambios
                </button>
                <button
                  type="submit"
                  className="danger"
                  disabled={
                    !confirmationAllowed(
                      target,
                      captured,
                      disabled,
                      busy,
                      reason,
                      minReasonLength,
                    )
                  }
                >
                  {confirmLabel}
                </button>
              </div>
            </form>
          </dialog>,
          document.body,
        )}
    </>
  );
}
