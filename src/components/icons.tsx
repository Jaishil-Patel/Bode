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
// Highlighter: a chisel-tip marker drawing a highlighted swipe.
export const IconHighlight = (p: P) =>
  svg(<><path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></>, p.className);
// Text box: a "T" inside a frame.
export const IconText = (p: P) =>
  svg(<><rect x="2.5" y="3.5" width="19" height="17" rx="1.5" /><path d="M7.5 8.5h9" /><path d="M12 8.5V16" /></>, p.className);
export const IconSquare = (p: P) => svg(<rect x="2.5" y="2.5" width="19" height="19" rx="2" />, p.className);
export const IconCircle = (p: P) => svg(<circle cx="12" cy="12" r="9.5" />, p.className);
// Freehand draw: the old marker-tip glyph.
export const IconPen = (p: P) =>
  svg(<><path d="M12 3 6 9l5 5 6-6z" /><path d="M11 14 6 9l-2 5-1 4 4-1z" /><path d="M3 21h7" /></>, p.className);
export const IconTrash = (p: P) =>
  svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>, p.className);
// Edit text: lines of text with an I-beam caret (modifying existing text).
export const IconEdit = (p: P) =>
  svg(<><path d="M3 5.5h10" /><path d="M3 12h7" /><path d="M3 18.5h10" /><path d="M19 5v14" /><path d="M17 5h4" /><path d="M17 19h4" /></>, p.className);
export const IconSignature = (p: P) =>
  svg(<><path d="M3 17c2 0 3-7 5-7s1 5 3 5 2-8 4-8 2 6 4 6" /><path d="M3 21h18" /></>, p.className);
export const IconSave = (p: P) =>
  svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>, p.className);
export const IconUndo = (p: P) =>
  svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10H8" /></>, p.className);
export const IconRedo = (p: P) =>
  svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h7" /></>, p.className);
// Drag handle: two columns of dots (a "grip").
export const IconGrip = (p: P) =>
  svg(
    <>
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </>,
    p.className
  );
export const IconEraser = (p: P) =>
  svg(<><path d="M7 21 3.5 17.5a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L13 19" /><path d="M7 21h12" /><path d="m9 12 4 4" /></>, p.className);
