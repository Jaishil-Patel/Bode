/*
 * What a document shows while it is being read.
 *
 * A little stack of pages: the front one is scanned top to bottom — a lit accent line passing down
 * it, uncovering its text — then flicks away, and the next page comes forward to be read. All of
 * the motion lives in index.css behind the reduced-motion query; without it this is a still stack
 * of pages with a label, which says the same thing.
 *
 * Fades in after a beat, so a document that opens instantly never flashes it.
 */

const LINES = ["62%", "100%", "88%", "94%", "70%"];

export default function LoadingIndicator({ name }: { name?: string | null }) {
  return (
    <div role="status" aria-live="polite" className="loader flex flex-col items-center gap-6">
      <div className="loader-stage" aria-hidden>
        <div className="loader-glow" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="loader-page" style={{ "--i": i } as React.CSSProperties}>
            {LINES.map((w, j) => (
              <span
                key={j}
                className={j === 0 ? "loader-line loader-line-title" : "loader-line"}
                style={{ width: w }}
              />
            ))}
            <span className="loader-scan" />
          </div>
        ))}
      </div>
      <div className="flex max-w-[min(80vw,360px)] items-baseline gap-1 text-sm text-muted">
        <span className="truncate">{name ? `Opening ${name}` : "Loading"}</span>
        <span className="loader-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}
