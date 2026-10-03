import { useEffect, useState } from "react";

function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

// One clock for the whole page, shared by every countdown on it. Counting down
// to an absolute instant rather than up from mount keeps the value correct
// after the tab has been in the background.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export function LeaseCountdown({
  leaseExpiresAt,
  now,
}: {
  leaseExpiresAt: string;
  now: number;
}) {
  const expiresAt = new Date(leaseExpiresAt).getTime();

  if (Number.isNaN(expiresAt)) return null;

  const remaining = (expiresAt - now) / 1000;

  if (remaining <= 0) {
    return (
      <span className="text-xs text-rose-300">
        Session expired or already stopped
      </span>
    );
  }

  // Warn well before the cutoff: under ten minutes is when someone wants to
  // wrap up or extend rather than keep working.
  const urgent = remaining <= 600;

  return (
    <span
      className={`text-xs ${urgent ? "text-amber-300" : "text-zinc-500"}`}
      title={`Stopped automatically at ${new Date(leaseExpiresAt).toLocaleString()}`}
    >
      Stops in{" "}
      <span className="font-mono tabular-nums">{formatCountdown(remaining)}</span>
      <span className="text-zinc-600">
        {" "}
        · {new Date(leaseExpiresAt).toLocaleTimeString()}
      </span>
    </span>
  );
}
