import { useEffect, useState } from "react";

/**
 * Tracks navigator.onLine via the browser's online/offline events. Starts
 * from the current value so a page loaded while offline renders the banner
 * on the first paint instead of after the first event fires.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    () => typeof navigator === "undefined" || navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
