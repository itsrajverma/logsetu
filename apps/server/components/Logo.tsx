export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#1b1b1e" />
        <path d="M8 7v18h16" fill="none" stroke="#3987e5" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="24" cy="9" r="3" fill="#e34948" />
      </svg>
      {!compact && <span className="font-semibold tracking-tight">LogSetu</span>}
    </span>
  );
}
