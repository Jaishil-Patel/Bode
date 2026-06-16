// Minimal inline icon set (stroke = currentColor) so we ship no icon dependency.
type P = { className?: string };
const base = "h-[18px] w-[18px]";
const svg = (children: React.ReactNode, className?: string) => (
  <svg
    className={`${base} ${className ?? ""}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const IconOpen = (p: P) =>
  svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p.className);
export const IconSearch = (p: P) =>
  svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, p.className);
export const IconSidebar = (p: P) =>
  svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>, p.className);
export const IconZoomIn = (p: P) =>
  svg(<><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M21 21l-4.3-4.3" /></>, p.className);
export const IconZoomOut = (p: P) =>
  svg(<><circle cx="11" cy="11" r="7" /><path d="M8 11h6M21 21l-4.3-4.3" /></>, p.className);
export const IconFitWidth = (p: P) =>
  svg(<><path d="M3 12h18" /><path d="m6 9-3 3 3 3M18 9l3 3-3 3" /></>, p.className);
export const IconFitPage = (p: P) =>
  svg(<rect x="5" y="3" width="14" height="18" rx="2" />, p.className);
export const IconSettings = (p: P) =>
  svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>, p.className);
export const IconChevronUp = (p: P) => svg(<path d="m6 15 6-6 6 6" />, p.className);
export const IconChevronDown = (p: P) => svg(<path d="m6 9 6 6 6-6" />, p.className);
export const IconChevronRight = (p: P) => svg(<path d="m9 6 6 6-6 6" />, p.className);
export const IconClose = (p: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, p.className);
export const IconZen = (p: P) =>
  svg(<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />, p.className);
export const IconCursor = (p: P) =>
  svg(<path d="m4 3 7 17 2.5-6.5L20 11z" />, p.className);
export const IconHighlight = (p: P) =>
  svg(<><path d="M12 3 6 9l5 5 6-6z" /><path d="M11 14 6 9l-2 5-1 4 4-1z" /><path d="M3 21h7" /></>, p.className);
export const IconText = (p: P) =>
  svg(<><path d="M5 5h14" /><path d="M12 5v14" /><path d="M9 19h6" /></>, p.className);
export const IconSquare = (p: P) => svg(<rect x="4" y="4" width="16" height="16" rx="1.5" />, p.className);
export const IconCircle = (p: P) => svg(<circle cx="12" cy="12" r="8" />, p.className);
export const IconPen = (p: P) =>
  svg(<path d="M12 19l7-7a2.1 2.1 0 0 0-3-3l-7 7-1 4z" />, p.className);
export const IconTrash = (p: P) =>
  svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>, p.className);
