import { useId, useState } from "react";
import { IconChevronDown } from "../components/icons";

/*
 * Small building blocks for the Devices panel.
 *
 * The app has no shared primitives layer — every other feature keeps its helpers file-local — so
 * these stay scoped to `devices/` rather than becoming a `src/components/ui` that only one feature
 * uses. They exist because this panel renders the same shapes eight or nine times each, and the old
 * version had drifted into four spellings of "a button" and six of "a section heading".
 *
 * Every value here is a theme token. The panel is read on a phone in daylight and on an OLED
 * desktop at night, and a single hardcoded grey shows up immediately in one of the four themes.
 */

/** The canonical section heading, matching `SettingsPanel`'s. */
export function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  /** Optional right-aligned detail — a size, a count. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {trailing && <span className="text-xs tabular-nums text-muted">{trailing}</span>}
      </div>
      {children}
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>;
}

type ButtonProps = {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** Fill the available width. Used for the paired action buttons on a device card. */
  block?: boolean;
  children: React.ReactNode;
};

/**
 * Three weights, and no more.
 *
 * `primary` is the one thing to do; `ghost` is a real alternative sitting beside it; `quiet` is for
 * actions that must be reachable but should never compete — Unpair, Cancel, Remove. The old panel
 * rendered all three at the same visual weight, which is why nothing on it looked clickable and
 * everything looked equally consequential.
 */
export function Button({
  variant = "ghost",
  onClick,
  disabled,
  title,
  block,
  children,
}: ButtonProps & { variant?: "primary" | "ghost" | "quiet" }) {
  // `flex-1 min-w-0` rather than `w-full`: these sit two-to-a-row inside a flex container, where a
  // percentage width leaves the split at the mercy of the label lengths.
  const shared = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm transition-colors disabled:cursor-default disabled:opacity-40 ${
    block ? "min-w-0 flex-1" : ""
  }`;
  const look = {
    primary: "bg-accent px-4 py-1.5 font-medium text-accent-fg hover:opacity-90",
    ghost: "border border-border bg-surface-2 px-3 py-1.5 text-text hover:border-accent/50",
    quiet: "px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text",
  }[variant];

  return (
    <button onClick={onClick} disabled={disabled} title={title} className={`${shared} ${look}`}>
      {children}
    </button>
  );
}

/** A square icon-only button, for cancel and star toggles. */
export function IconButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
        active ? "text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * A surface for one device or one grouped idea.
 *
 * `index` drives a staggered entrance so a list of devices assembles rather than appearing. Capped
 * by the caller — past about six the stagger stops reading as polish and starts reading as lag.
 */
export function Card({
  index = 0,
  className = "",
  children,
}: {
  index?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ "--i": index } as React.CSSProperties}
      className={`animate-rise rounded-xl border border-border bg-surface-2/40 p-3 ${className}`}
    >
      {children}
    </div>
  );
}

export type Presence = "ready" | "connected" | "away" | "busy";

/**
 * The live dot beside a device name.
 *
 * "Ready" gets an expanding ring — the panel's only continuously animated element, and the one
 * thing that distinguishes a rendered list from a live one. "Connected" is the same dot without it:
 * a phone is genuinely reachable and syncs notes, it just has no folder to browse, and the old
 * panel's flat text made that read as a degraded state rather than the normal one.
 */
export function StatusDot({ presence }: { presence: Presence }) {
  if (presence === "away") {
    return <span className="h-2 w-2 shrink-0 rounded-full border border-muted" />;
  }
  if (presence === "busy") {
    return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />;
  }
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {presence === "ready" && (
        <span className="animate-pulse-ring absolute inset-0 rounded-full bg-accent" />
      )}
      <span className="relative h-2 w-2 rounded-full bg-accent" />
    </span>
  );
}

/** Name + dot, as one chip. */
export function StatusChip({ presence, label }: { presence: Presence; label: string }) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-xs ${
        presence === "away" ? "text-muted" : "text-text"
      }`}
    >
      <StatusDot presence={presence} />
      {label}
    </span>
  );
}

/**
 * A collapsed row of secondary actions.
 *
 * Everything a device card can do that is not "browse it" or "sync with it" lives behind this. Not
 * to hide it, but because the panel's central problem was four verbs presented at equal weight with
 * no indication which one you wanted.
 */
export function Disclosure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-text"
      >
        {label}
        <IconChevronDown
          className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id={id} className="animate-fade-in mt-2 flex flex-col items-start gap-1">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A progress bar.
 *
 * The travelling sheen is not decoration: a bar that has stopped moving and a bar moving slowly are
 * identical at a glance, and over Wi-Fi the second is the common case. `done` freezes it and
 * switches to a solid fill so the end of a transfer is visible rather than inferred.
 */
export function ProgressBar({ fraction, done }: { fraction: number; done?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="h-1 overflow-hidden rounded-full bg-surface-2">
      <div
        className="relative h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
        style={{ width: `${done ? 100 : pct}%` }}
      >
        {!done && pct > 0 && (
          <span className="animate-sheen absolute inset-y-0 w-1/3 bg-accent-fg/25" />
        )}
      </div>
    </div>
  );
}
