export type ConfirmationTarget = {
  module: string;
  id: string;
  version: number | string;
  name: string;
  action?: string;
};
export function sameConfirmationTarget(
  a: ConfirmationTarget,
  b: ConfirmationTarget | null,
) {
  return (
    !!b &&
    a.module === b.module &&
    a.id === b.id &&
    a.version === b.version &&
    a.action === b.action
  );
}
export function confirmationAllowed(
  current: ConfirmationTarget,
  captured: ConfirmationTarget | null,
  disabled: boolean,
  busy: boolean,
  reason: string,
  minReasonLength: number,
) {
  return (
    sameConfirmationTarget(current, captured) &&
    !disabled &&
    !busy &&
    reason.trim().length >= minReasonLength
  );
}
