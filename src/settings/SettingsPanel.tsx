import { useSettings } from "./useSettings";
import { BUILT_IN_THEMES, type CustomTheme } from "./themes";
import { IconClose } from "../components/icons";

const CUSTOM_FIELDS: { key: keyof CustomTheme; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "surface", label: "Surface" },
  { key: "surface2", label: "Surface 2" },
  { key: "border", label: "Border" },
  { key: "text", label: "Text" },
  { key: "muted", label: "Muted" },
  { key: "accent", label: "Accent" },
  { key: "accentFg", label: "Accent text" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border py-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm text-text">
      {label}
      <button
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-surface-2"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    theme,
    customTheme,
    layout,
    setTheme,
    setCustomThemeVar,
    updateLayout,
  } = useSettings();

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-[380px] max-w-[92vw] overflow-auto bg-surface p-5 shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Settings</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2">
            <IconClose />
          </button>
        </div>

        <Section title="Theme">
          <div className="grid grid-cols-5 gap-2">
            {BUILT_IN_THEMES.map((t) => (
              <button
                key={t.name}
                onClick={() => setTheme(t.name)}
                title={t.label}
                className={`flex h-12 items-center justify-center rounded-md border-2 ${
                  theme === t.name ? "border-accent" : "border-border"
                }`}
                style={{ background: t.swatch }}
              />
            ))}
          </div>
          {theme === "custom" && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CUSTOM_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-2 text-sm text-text">
                  <span className="text-muted">{f.label}</span>
                  <input
                    type="color"
                    value={customTheme[f.key]}
                    onChange={(e) => setCustomThemeVar(f.key, e.target.value)}
                    className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                  />
                </label>
              ))}
            </div>
          )}
        </Section>

        <Section title="Layout">
          <Toggle
            label="Continuous scrolling"
            checked={layout.continuous}
            onChange={(v) => updateLayout({ continuous: v })}
          />
          <Toggle
            label="Sidebar on left"
            checked={layout.sidebarSide === "left"}
            onChange={(v) => updateLayout({ sidebarSide: v ? "left" : "right" })}
          />
          <Toggle
            label="Auto-hide toolbar in zen mode"
            checked={layout.toolbarAutoHide}
            onChange={(v) => updateLayout({ toolbarAutoHide: v })}
          />
          <label className="mt-2 flex items-center justify-between text-sm text-text">
            Page gap
            <input
              type="range"
              min={0}
              max={48}
              value={layout.pageGap}
              onChange={(e) => updateLayout({ pageGap: Number(e.target.value) })}
              className="w-40 accent-[var(--accent)]"
            />
          </label>
        </Section>

        <Section title="Shortcuts">
          <ul className="space-y-1 text-sm text-muted">
            {[
              ["Open PDF", "Ctrl+O"],
              ["Find", "Ctrl+F"],
              ["Command palette", "Ctrl+K"],
              ["Toggle sidebar", "Ctrl+B"],
              ["Zoom in / out", "Ctrl + / Ctrl -"],
              ["Reset zoom", "Ctrl+0"],
              ["Next / previous page", "PageDn / PageUp"],
            ].map(([k, v]) => (
              <li key={k} className="flex justify-between">
                <span>{k}</span>
                <kbd className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text">{v}</kbd>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
