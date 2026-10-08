/**
 * Amount masking for the chart tooltip.
 *
 * The summary does not need a mask of its own: `AmountDisplay` from
 * `@wealthfolio/ui` takes an `isHidden` prop and renders the host's own
 * `••••`. The tooltip is a formatter that must return a string, so no component
 * can be used there — hence this one helper, holding the same mask.
 *
 * One fixed string, on purpose. Masking only the digits left the group separators
 * and the compact suffix intact, so a hidden total still gave the order of
 * magnitude away (`PLN ••• •••` reads as hundreds of thousands) and the axis
 * literally printed `••• mln`. The axis is therefore hidden outright instead
 * (see `ContributionChart`'s `hideAxis`).
 *
 * Pure and locale-agnostic: the caller passes the already formatted string, which
 * keeps the policy testable without `Intl`.
 */

/** Byte-for-byte what the host renders for a hidden amount. */
export const HIDDEN_AMOUNT = '••••';

/**
 * Renders a formatted amount, or the fixed mask while hiding is on.
 *
 * The result depends on `hidden` alone, never on the value, so neither the length
 * nor the separators of the formatted amount can be inferred from it.
 */
export function maskAmount(formatted: string, hidden: boolean): string {
  return hidden ? HIDDEN_AMOUNT : formatted;
}
