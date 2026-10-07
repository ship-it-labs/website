import { useState, type ReactNode } from "react";

/**
 * Show-all/collapse pattern for long lists. The hook owns the slice state;
 * the component below is the zero-boilerplate version for plain containers.
 * For lists where a trailing button would be invalid HTML (e.g. inside an
 * <ol>), use the hook directly and render the toggle after the list.
 */
export function useShowMore<T>(items: T[], initial = 5): {
  visible: T[];
  expanded: boolean;
  hidden: number;
  toggle: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const fits = items.length <= initial;
  return {
    visible: expanded || fits ? items : items.slice(0, initial),
    expanded,
    hidden: fits ? 0 : items.length - initial,
    toggle: () => setExpanded((v) => !v),
  };
}

export function ShowMoreButton({
  expanded,
  hidden,
  onToggle,
  expandLabel,
  collapseLabel = "Show fewer",
}: {
  expanded: boolean;
  hidden: number;
  onToggle: () => void;
  expandLabel: (hidden: number) => string;
  collapseLabel?: string;
}) {
  if (hidden === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-6 rounded-xl border border-white/10 px-5 py-2.5 text-sm text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
    >
      {expanded ? collapseLabel : expandLabel(hidden)}
    </button>
  );
}

export function ShowMore<T>({
  items,
  initial = 5,
  renderItem,
  expandLabel,
  collapseLabel = "Show fewer",
}: {
  items: T[];
  initial?: number;
  renderItem: (item: T, index: number) => ReactNode;
  expandLabel: (hidden: number) => string;
  collapseLabel?: string;
}) {
  const { visible, expanded, hidden, toggle } = useShowMore(items, initial);
  return (
    <>
      {visible.map(renderItem)}
      <ShowMoreButton
        expanded={expanded}
        hidden={hidden}
        onToggle={toggle}
        expandLabel={expandLabel}
        collapseLabel={collapseLabel}
      />
    </>
  );
}
