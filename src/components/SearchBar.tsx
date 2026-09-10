import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";
import { IconChevronUp, IconChevronDown, IconClose } from "./icons";

export default function SearchBar() {
  const { search, runSearch, nextMatch, prevMatch, clearSearch, toggleSearch } = useViewer();
  const [value, setValue] = useState(search.query);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<number>();

  useEffect(() => {
    if (search.open) inputRef.current?.focus();
  }, [search.open]);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => runSearch(value), 220);
    return () => window.clearTimeout(debounce.current);
  }, [value, runSearch]);

  if (!search.open) return null;

  const total = search.matches.length;
  const pos = search.current >= 0 ? search.current + 1 : 0;

  return (
        /*
     * Anchored to both edges on a phone, to the right edge alone once there is room.
     *
     * Pinned only to the right, the bar sized itself from its contents — a 224px input, the match
     * counter, three buttons — and came to a little over 400px against a 360px screen, so it ran
     * off the left edge and took the input's first characters with it. Below `sm` it spans instead
     * and the input takes what is left; from `sm` up the fixed width comes back, because a search
     * field that grows with the window is not what anyone wants on a desktop.
     */
    <div className="glass absolute left-2 right-2 top-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-lg animate-fade-in sm:left-auto sm:right-4">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? prevMatch : nextMatch)();
          if (e.key === "Escape") {
            clearSearch();
            toggleSearch(false);
          }
        }}
        placeholder="Find in document"
        className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-sm text-text outline-none sm:w-56 sm:flex-none"
      />
      <span className="min-w-[3rem] shrink-0 px-1 text-center text-xs text-muted sm:min-w-[64px]">
        {search.busy ? "…" : total ? `${pos} / ${total}` : value ? "0 / 0" : ""}
      </span>
      <button
        onClick={prevMatch}
        title="Previous (Shift+Enter)"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconChevronUp />
      </button>
      <button
        onClick={nextMatch}
        title="Next (Enter)"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconChevronDown />
      </button>
      <button
        onClick={() => {
          clearSearch();
          toggleSearch(false);
        }}
        title="Close (Esc)"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconClose />
      </button>
    </div>
  );
}
