import { useEffect } from "react";

/**
 * Sets document.title per route. The suffix keeps every tab identifiable as
 * Ship-It; the previous title is restored on unmount so a crash in one page
 * does not leave a stale title behind.
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — Ship-It`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
