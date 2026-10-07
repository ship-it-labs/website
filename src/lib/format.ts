const grouped = new Intl.NumberFormat("en-US");

/**
 * Thousand-separated display for counts (hours, builds, seconds). Raw values
 * stay numeric everywhere else — this is presentation only, so 1000 renders
 * as "1,000" without touching sorting, billing math or API payloads.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return grouped.format(value);
}
