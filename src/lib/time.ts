/**
 * Compact relative time ("12d ago", "in 3d") for ages and deadlines.
 * Absolute dates stay in the title attribute at call sites — this is the
 * glanceable form, not the precise one.
 */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "unknown";

  const diffMs = now - at;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  let text: string;
  if (abs < minute) {
    text = "just now";
    return text;
  } else if (abs < hour) {
    const n = Math.floor(abs / minute);
    text = `${n}m`;
  } else if (abs < day) {
    const n = Math.floor(abs / hour);
    text = `${n}h`;
  } else if (abs < 30 * day) {
    const n = Math.floor(abs / day);
    text = `${n}d`;
  } else if (abs < 365 * day) {
    const n = Math.floor(abs / (30 * day));
    text = `${n}mo`;
  } else {
    const n = Math.floor(abs / (365 * day));
    text = `${n}y`;
  }

  return future ? `in ${text}` : `${text} ago`;
}
