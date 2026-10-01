export function WrenchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M14.7 6.3a4.5 4.5 0 0 0 5.6 5.6l-8.3 8.3a2.4 2.4 0 0 1-3.4-3.4Z" />
      <path d="M14.7 6.3 12 3.6a4.5 4.5 0 0 0-4 7.5" />
      <path d="M6.2 17.8h.01" />
    </svg>
  );
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="3" />
      <path d="M10 9.25 15 12l-5 2.75Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2.75 4.75 5.5v5.9c0 4.4 3 8.2 7.25 9.85 4.25-1.65 7.25-5.45 7.25-9.85V5.5Z" />
      <path d="m9.2 11.9 2 2 3.6-3.9" />
    </svg>
  );
}
