import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  description,
  onClose,
  children,
  width = "max-w-3xl",
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  // Escape closes, and the page behind must not scroll under the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/80 p-4 backdrop-blur-sm sm:p-8"
      // A click on the backdrop closes; clicks inside the card must not bubble.
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass w-full ${width} my-auto rounded-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-white">{title}</h2>
            {description && (
              <p className="mt-1 text-sm text-zinc-500">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
