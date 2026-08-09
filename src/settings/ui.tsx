/*
 * Building blocks for the Settings panel.
 *
 * A deliberate sibling of `devices/ui.tsx` rather than a shared import: the app keeps its helpers
 * per-feature, and the two panels want the same *vocabulary* without wanting the same components.
 * A settings row is a label / description / control triple that no device card ever renders, and a
 * device card's presence dots and progress bars have no meaning here. Section and Hint are the two
 * shapes that genuinely coincide, and they are four lines each.
 *
 * Every colour is a theme token. Note that Tailwind's opacity modifier does NOT work on them —
 * `bg-accent/15` compiles to nothing, because the tokens are whole `var(--x)` strings rather than
 * colour channels. Use the `.tint-accent` / `.tint-hover` helpers in index.css instead.
 */

export type Edge = "top" | "bottom" | "left" | "right";

/** The canonical section heading, matching `devices/ui.tsx`. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-2 text-xs leading-relaxed text-muted">{children}</p>;
}

/**
 * A labelled setting.
 *
 * `description` is where the panel earns "intuitive": most of these controls are guessable from
 * their label alone, but a few (Open PDFs in, Remove password when saving) are not, and a one-line
 * explanation in place beats a tooltip nobody hovers.
 */
export function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-2 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-text">{label}</div>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ checked }: { checked: boolean }) {
  return (
    <span
      className={`relative block h-[22px] w-[38px] shrink-0 rounded-full border transition-colors ${
        checked ? "border-accent bg-accent" : "border-border bg-surface-2"
      }`}
    >
      {/* The knob takes a theme token on both sides rather than a flat white: white-on-surface-2 is
          nearly invisible in the light theme, which made "off" look like a disabled control. */}
      <span
        className={`absolute top-[2px] h-4 w-4 rounded-full transition-all ${
          checked ? "left-[18px] bg-accent-fg" : "left-[2px] bg-muted"
        }`}
      />
    </span>
  );
}

/**
 * A toggle whose entire row is the hit target, so the label and description are clickable too.
 *
 * It has to be one `<button>` for that: a `<label htmlFor>` pointing at a button does not activate
 * it, since labels only forward clicks to real form controls.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="no-press hover-tint flex w-full items-center justify-between gap-4 rounded-lg px-2 py-2.5 text-left transition-colors"
    >
      <span className="min-w-0">
        <span className="block text-sm text-text">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
        )}
      </span>
      <Switch checked={checked} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            value === o.value ? "bg-accent text-accent-fg" : "text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A range input plus its current value, so the number is never a mystery mid-drag. */
export function Slider({
  value,
  min,
  max,
  onChange,
  format,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  label: string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        // `--val` drives the filled portion of the track; see `.bode-range` in index.css.
        style={{ "--val": `${pct}%` } as React.CSSProperties}
        className="bode-range w-32"
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">
        {format(value)}
      </span>
    </div>
  );
}

/**
 * Which edge the tools bar docks to, picked on a miniature of the window.
 *
 * This replaces a four-option segmented control reading "Bottom | Top | Left | Right", which was
 * both too wide for the row and asked you to translate a compass direction into a screen position.
 * Clicking the edge you want needs no translation.
 */
export function EdgePicker({ value, onChange }: { value: Edge; onChange: (v: Edge) => void }) {
  /*
   * The hit target is the whole cell, not the pill.
   *
   * Drawn as a 3x3 grid — edges in the side cells, corners and centre left empty — so each target is
   * a comfortable block rather than the 6px-thick bar you can see, and no two overlap the way
   * absolutely-positioned strips stretched to a usable size would. Aiming at the pill itself was the
   * whole complaint.
   */
  const cell = (edge: Edge, label: string, area: string, pill: string) => (
    <button
      key={edge}
      type="button"
      onClick={() => onChange(edge)}
      title={label}
      aria-label={label}
      aria-pressed={value === edge}
      style={{ gridArea: area }}
      className="group flex items-center justify-center"
    >
      <span
        // Inactive edges take `muted`, not `border`: border against surface-2 is a couple of points
        // of luminance apart in every theme, which left the three edges you had not picked
        // invisible — the control looked like a decorative box with one coloured stripe.
        className={`rounded-[3px] transition-colors ${pill} ${
          value === edge ? "bg-accent" : "bg-muted group-hover:bg-text"
        }`}
      />
    </button>
  );

  return (
    // Size and grid tracks live in `.edge-picker` (index.css) so a coarse pointer can be given
    // finger-sized cells without keeping a second copy of the layout here.
    <div className="edge-picker rounded-md border border-border bg-surface-2">
      {/* grid-area is row-start / column-start / row-end / column-end. */}
      {cell("top", "Top", "1 / 2 / 2 / 3", "h-1.5 w-8")}
      {cell("left", "Left", "2 / 1 / 3 / 2", "h-4 w-1.5")}
      {cell("right", "Right", "2 / 3 / 3 / 4", "h-4 w-1.5")}
      {cell("bottom", "Bottom", "3 / 2 / 4 / 3", "h-1.5 w-8")}
    </div>
  );
}

/** A secondary action that must be reachable without competing — Clear, Revoke. */
export function QuietButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-tint shrink-0 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-text"
    >
      {children}
    </button>
  );
}

/** Empty-state copy for a list that is empty because nothing has happened yet, not because of an error. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
      {children}
    </p>
  );
}
