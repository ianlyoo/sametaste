/** "$1,757.73"; negative values get a true minus sign. */
export function formatMoney(n: number, currency = "USD", opts: { cents?: boolean } = {}): string {
  const cents = opts.cents ?? true;
  const s = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(Math.abs(n));
  return n < 0 ? `−${s}` : s;
}
