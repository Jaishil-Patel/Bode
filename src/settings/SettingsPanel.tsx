import { useState } from "react";
import { useSettings } from "./useSettings";
import { useViewer } from "../store/viewerStore";
import { BUILT_IN_THEMES, customThemeVars, type CustomTheme, type ThemeName } from "./themes";
import { isAndroid } from "../platform/files";
import { TOOLS } from "../annotations/tools";
import ToolbarCustomizer from "./ToolbarCustomizer";
import {
  IconBook,
  IconClose,
  IconKeyboard,
  IconPalette,
  IconShield,
  IconSidebar,
} from "../components/icons";
import {
  EdgePicker,
  EmptyNote,
  Hint,
  QuietButton,
  Row,
  Section,
  Segmented,
  Slider,
  ToggleRow,
  type Edge,
} from "./ui";

/*
 * The Settings drawer.
 *
 * Organised as five categories behind an icon rail rather than one long scroll. The settings
 * themselves did not change shape — what changed is that "Layout" used to be a grab bag holding
 * scrolling behaviour and chrome placement at once, so finding anything meant reading all of it.
 */

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

type TabId = "appearance" | "reading" | "interface" | "privacy" | "shortcuts";

const ALL_TABS: { id: TabId; label: string; Icon: (p: { className?: string }) => JSX.Element }[] = [
  { id: "appearance", label: "Appearance", Icon: IconPalette },
  { id: "reading", label: "Reading", Icon: IconBook },
  { id: "interface", label: "Interface", Icon: IconSidebar },
  { id: "privacy", label: "Privacy", Icon: IconShield },
  { id: "shortcuts", label: "Shortcuts", Icon: IconKeyboard },
];

// Android has no keyboard to press, so the Shortcuts category is a page of key names the reader
// can never use. It is dropped from the rail there rather than shown as a dead category.
const TABS = ALL_TABS.filter((t) => t.id !== "shortcuts" || !isAndroid());

/*
 * Every shortcut the global handler in App.tsx actually binds.
 *
 * The tools group is generated from the registry rather than typed out, because a hand-written
 * copy of it drifted the moment a tool was added: this list claimed to name every single-key tool
 * shortcut while silently missing the form tool. Generated, it cannot be wrong again — and the
 * shortcuts stay listed for tools the user has taken off the bar, since those still work.
 */
const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "File",
    items: [
      ["Open", "Ctrl+O"],
      ["Save text tab", "Ctrl+S"],
      ["Toggle source editor", "Ctrl+E"],
    ],
  },
  {
    group: "View",
    items: [
      ["Toggle sidebar", "Ctrl+B"],
      ["Zoom in / out", "Ctrl+= / Ctrl+-"],
      ["Reset zoom", "Ctrl+0"],
      ["Fullscreen", "F11"],
      ["Close overlay / exit fullscreen", "Esc"],
    ],
  },
  {
    group: "Navigate",
    items: [
      ["Find", "Ctrl+F"],
      ["Command palette", "Ctrl+K"],
      ["Next / previous page", "PageDn / PageUp"],
    ],
  },
  {
    group: "Tools",
    items: TOOLS.map((t): [string, string] => [t.name, t.key.toUpperCase()]),
  },
  {
    group: "Edit",
    items: [
      ["Undo / redo", "Ctrl+Z / Ctrl+Y"],
      ["Delete selected", "Del"],
    ],
  },
];

/**
 * A theme preview rendered in the theme it represents.
 *
 * The miniature carries its own `data-theme`, so themes.css supplies the colours and this stays
 * correct when a theme is added or retuned — the previous version stored one flat swatch colour per
 * theme in themes.ts, a second copy of a value that already lived in the stylesheet.
 */
function ThemeCard({
  name,
  label,
  active,
  custom,
  onSelect,
}: {
  name: ThemeName;
  label: string;
  active: boolean;
  custom: CustomTheme;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`no-press flex flex-col items-center gap-1.5 rounded-xl border-2 p-1.5 transition-colors ${
        active ? "border-accent" : "border-border hover:border-muted"
      }`}
    >
      <span
        data-theme={name}
        // themes.css defines no values for the custom theme (they are written onto <html> only while
        // it is the active one), so the preview has to carry them itself.
        style={name === "custom" ? customThemeVars(custom) : undefined}
        className="flex h-11 w-full flex-col justify-between overflow-hidden rounded-lg bg-bg p-1.5"
      >
        <span className="h-1.5 w-7 rounded-full bg-surface-2" />
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <span className="h-1.5 w-5 rounded-full bg-surface-2" />
        </span>
      </span>
      <span className={`text-[11px] ${active ? "text-text" : "text-muted"}`}>{label}</span>
    </button>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const {
    theme,
    customTheme,
    layout,
    recents,
    setTheme,
    setCustomThemeVar,
    updateLayout,
    clearRecents,
  } = useSettings();

  const [tab, setTab] = useState<TabId>("appearance");

  const filePath = useViewer((s) => s.filePath);
  const encryptedPaths = useViewer((s) => s.encryptedPaths);
  const exportUnlocked = useViewer((s) => s.exportUnlocked);
  const isEncrypted = !!filePath && encryptedPaths.includes(filePath);

  const panes: Record<TabId, React.ReactNode> = {
    appearance: (
      <>
        <Section title="Theme">
          <div className="grid grid-cols-3 gap-2">
            {BUILT_IN_THEMES.map((t) => (
              <ThemeCard
                key={t.name}
                name={t.name}
                label={t.label}
                active={theme === t.name}
                custom={customTheme}
                onSelect={() => setTheme(t.name)}
              />
            ))}
          </div>
        </Section>

        <Section title="Page">
          <Row
            label="Page colours"
            description="A theme restyles the app; this carries it through to the document."
          >
            <Segmented
              label="Page colours"
              value={layout.pageColors}
              options={[
                { value: "normal", label: "Normal" },
                { value: "auto", label: "Auto" },
                { value: "inverted", label: "Dark" },
              ]}
              onChange={(v) => updateLayout({ pageColors: v })}
            />
          </Row>
          <Hint>Auto follows the theme, so a dark theme gets dark pages.</Hint>
        </Section>

        {theme === "custom" ? (
          <Section title="Custom colours">
            <div className="flex flex-col">
              {CUSTOM_FIELDS.map((f) => (
                <label
                  key={f.key}
                  className="hover-tint flex cursor-pointer items-center justify-between gap-4 rounded-lg px-2 py-2"
                >
                  <span className="text-sm text-text">{f.label}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs uppercase tabular-nums text-muted">
                      {customTheme[f.key]}
                    </span>
                    <input
                      type="color"
                      value={customTheme[f.key]}
                      onChange={(e) => setCustomThemeVar(f.key, e.target.value)}
                      className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
                    />
                  </span>
                </label>
              ))}
            </div>
          </Section>
        ) : (
          <Hint>Pick Custom above to set each colour yourself.</Hint>
        )}
      </>
    ),

    reading: (
      <Section title="Pages">
        <ToggleRow
          label="Continuous scrolling"
          description="Scroll straight through the document instead of turning one page at a time."
          checked={layout.continuous}
          onChange={(v) => updateLayout({ continuous: v })}
        />
        <Row label="Page gap" description="Space between pages.">
          <Slider
            label="Page gap"
            value={layout.pageGap}
            min={0}
            max={48}
            onChange={(v) => updateLayout({ pageGap: v })}
            format={(v) => `${v}px`}
          />
        </Row>
        {layout.continuous && (
          <Hint>
            Arrow keys scroll the page; left and right turn it once there is nothing left to pan to.
          </Hint>
        )}
      </Section>
    ),

    interface: (
      <>
        <Section title="Chrome">
          <Row label="Sidebar" description="Which side thumbnails and the outline open on.">
            <Segmented
              label="Sidebar side"
              value={layout.sidebarSide}
              options={[
                { value: "left", label: "Left" },
                { value: "right", label: "Right" },
              ]}
              onChange={(v) => updateLayout({ sidebarSide: v })}
            />
          </Row>
          <Row label="Tools bar" description="Which edge the annotation tools dock to.">
            <EdgePicker
              value={layout.toolsSide}
              onChange={(v: Edge) => updateLayout({ toolsSide: v })}
            />
          </Row>
        </Section>
        <ToolbarCustomizer />
      </>
    ),

    privacy: (
      <>
        <Section title="Document password">
          {isEncrypted ? (
            <>
              <ToggleRow
                label="Remove password when saving"
                description="Lets Save write an unlocked copy of this protected PDF."
                checked={layout.removePasswordOnSave}
                onChange={(v) => updateLayout({ removePasswordOnSave: v })}
              />
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void exportUnlocked();
                }}
                className="glass glass-cta mx-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
              >
                Save unlocked copy…
              </button>
            </>
          ) : (
            <EmptyNote>Open a password-protected PDF to see its options here.</EmptyNote>
          )}
        </Section>

        <Section title="Recent files">
          <Row label="Remembered documents" description="Shown on the start screen and in search.">
            <span className="flex items-center gap-1">
              <span className="text-xs tabular-nums text-muted">{recents.length}</span>
              {recents.length > 0 && <QuietButton onClick={clearRecents}>Clear</QuietButton>}
            </span>
          </Row>
        </Section>
      </>
    ),

    shortcuts: (
      <>
        {SHORTCUTS.map((g) => (
          <Section key={g.group} title={g.group}>
            <ul className="flex flex-col">
              {g.items.map(([action, keys]) => (
                <li key={action} className="flex items-center justify-between gap-4 px-2 py-1.5">
                  <span className="text-sm text-text">{action}</span>
                  <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                    {keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </Section>
        ))}
      </>
    ),
  };

  return (
    <div className="below-caption fixed inset-x-0 bottom-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="glass glass-sheer drawer-inset animate-fade-in flex h-full w-[560px] max-w-full bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The rail stays icon-width so the drawer still fits a phone once max-w-full clamps it. */}
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings categories"
          className="flex w-[76px] shrink-0 flex-col gap-1 border-r border-border p-2"
        >
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`no-press flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-[10px] transition-colors ${
                tab === id ? "tint-accent text-accent" : "hover-tint text-muted hover:text-text"
              }`}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold text-text">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="hover-tint rounded-md p-1 text-muted hover:text-text"
            >
              <IconClose />
            </button>
          </header>

          <div
            role="tabpanel"
            // Keyed so switching category resets the scroll position and replays the entrance;
            // without it a long Shortcuts scroll carries over into a two-row pane.
            key={tab}
            className="animate-fade-in flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-3 py-4"
          >
            {panes[tab]}
          </div>
        </div>
      </div>
    </div>
  );
}
