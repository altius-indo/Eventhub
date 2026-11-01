import Link from "next/link";

/** Header bell linking to the notification centre (MSG-05), with the unread count. */
export function NotificationBell({ count, label }: { count: number; label: string }) {
  return (
    <Link href="/notifications" aria-label={label} title={label} className="relative inline-flex size-11 items-center justify-center rounded-md hover:bg-surface-muted">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 min-w-5 rounded-full bg-danger px-1 text-center text-xs font-semibold leading-5 text-danger-contrast">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
