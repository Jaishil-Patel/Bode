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
    <div className="absolute right-4 top-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-lg animate-fade-in">
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
        className="w-56 rounded bg-surface-2 px-2 py-1 text-sm text-text outline-none"
      />
      <span className="min-w-[64px] px-1 text-center text-xs text-muted">
        {search.busy ? "…" : total ? `${pos} / ${total}` : value ? "0 / 0" : ""}
      </span>
      <button
        onClick={prevMatch}
        title="Previous (Shift+Enter)"
        className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconChevronUp />
      </button>
      <button
        onClick={nextMatch}
        title="Next (Enter)"
        className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconChevronDown />
      </button>
      <button
        onClick={() => {
          clearSearch();
          toggleSearch(false);
        }}
        title="Close (Esc)"
        className="flex h-7 w-7 items-center justify-center rounded hover:bg-surface-2"
      >
        <IconClose />
      </button>
    </div>
  );
}
