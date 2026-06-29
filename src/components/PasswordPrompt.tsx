import { useEffect, useRef, useState } from "react";
import { useViewer } from "../store/viewerStore";

/**
 * Modal that asks for the password of an encrypted PDF. Driven by `passwordPrompt` on the viewer
 * store: it appears when a load rejects with a PasswordException, and stays open (flagged `wrong`)
 * when a supplied password is rejected. Mirrors the SignaturePad modal styling.
 */
export default function PasswordPrompt() {
  const prompt = useViewer((s) => s.passwordPrompt);
  const submitPassword = useViewer((s) => s.submitPassword);
  const cancelPassword = useViewer((s) => s.cancelPassword);

  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset and focus whenever a new prompt opens (or the same one is re-flagged wrong).
  useEffect(() => {
    if (!prompt) return;
    setValue("");
    setBusy(false);
    inputRef.current?.focus();
  }, [prompt?.path, prompt?.wrong]);

  if (!prompt) return null;

  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    await submitPassword(value);
    // If the password was wrong the prompt stays open; the effect above re-focuses on `wrong`.
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={cancelPassword}
    >
      <div
        className="w-[26rem] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-sm font-medium text-text">
          Password required
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="truncate text-sm text-muted" title={prompt.name}>
            “{prompt.name}” is password-protected.
          </p>
          <input
            ref={inputRef}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") cancelPassword();
            }}
            placeholder="Enter password"
            autoFocus
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
          {prompt.wrong && (
            <p className="text-sm text-red-500">Incorrect password — try again.</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={cancelPassword}
            className="rounded-md px-3 py-1.5 text-sm text-text transition-colors hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!value || busy}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
