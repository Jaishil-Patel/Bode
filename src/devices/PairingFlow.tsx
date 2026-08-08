import { useEffect, useRef, useState } from "react";
import { useDevices } from "./useDevices";
import { Button, Hint } from "./ui";
import { IconLaptop, IconPhone, IconCheck } from "../components/icons";

/*
 * Pairing, as one sequence rather than four unrelated screens.
 *
 * The old version showed a code, then a spinner, then a fingerprint, each as a full takeover with
 * no indication of where you were or how much was left — so the confirmation step, which is the
 * entire security model, arrived looking like just another panel.
 *
 * The step rail is the fix. It costs a row of pixels and turns three disconnected states into one
 * thing with a beginning and an end.
 */

const STEPS = ["Connect", "Code", "Confirm"] as const;

function StepRail({ active }: { active: number }) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-3">
      {STEPS.map((label, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                done
                  ? "bg-accent text-accent-fg"
                  : current
                    ? "border border-accent text-accent"
                    : "border border-border text-muted"
              }`}
            >
              {done ? <IconCheck className="h-3 w-3" /> : i + 1}
            </span>
            <span
              className={`text-xs transition-colors ${current ? "text-text" : "text-muted"}`}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

/** The canonical dialog shell: header rail, padded body, bordered footer. */
function Shell({
  step,
  title,
  children,
  footer,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-border bg-surface">
      <StepRail active={step} />
      <div className="border-t border-border px-4 py-4">
        <h3 className="text-sm font-medium text-text">{title}</h3>
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        {footer}
      </div>
    </div>
  );
}

/**
 * Six characters, rendered as six boxes.
 *
 * The value is meant to be read aloud or compared across a desk, and a run of characters in one
 * long field is exactly the shape people miscount.
 */
function CodeDisplay({ value, accent }: { value: string; accent?: boolean }) {
  return (
    <div className="flex justify-center gap-1.5">
      {value.split("").map((char, i) => (
        <span
          key={i}
          className={`flex h-11 w-9 items-center justify-center rounded-lg border font-mono text-xl ${
            accent ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-surface-2 text-text"
          }`}
        >
          {char}
        </span>
      ))}
    </div>
  );
}

/** The confirm step's picture: two devices showing one value, which is the whole claim. */
function Handshake({ fingerprint, peerName }: { fingerprint: string; peerName: string }) {
  return (
    <div className="flex flex-col gap-3">
      <CodeDisplay value={fingerprint} accent />
      <div className="flex items-center justify-center gap-3 text-muted">
        <span className="flex flex-col items-center gap-1">
          <IconLaptop className="h-5 w-5" />
          <span className="text-[11px]">This device</span>
        </span>
        <svg viewBox="0 0 60 12" className="h-3 w-16 text-accent" aria-hidden>
          <path
            d="M2 6h56"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray="4 4"
            className="animate-dash-flow"
          />
        </svg>
        <span className="flex flex-col items-center gap-1">
          <IconPhone className="h-5 w-5" />
          <span className="max-w-[7rem] truncate text-[11px]">{peerName}</span>
        </span>
      </div>
    </div>
  );
}

export function PairingFlow() {
  const { pairing, submitCode, cancelPairing, dismissConfirmation, error, status } = useDevices();
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Focus follows the step, not the mount: the flow stays mounted across all three.
  useEffect(() => {
    if (pairing.kind === "joining") input.current?.focus();
  }, [pairing.kind]);

  if (pairing.kind === "idle") return null;

  if (pairing.kind === "hosting") {
    return (
      <Shell
        step={1}
        title="Enter this code on your other device"
        footer={
          <Button variant="quiet" onClick={() => void cancelPairing()}>
            Cancel
          </Button>
        }
      >
        <CodeDisplay value={pairing.code} />
        <Hint>Expires in three minutes, and works once for one device.</Hint>
        {/* So the other device can be pointed here by hand when multicast is blocked. */}
        {status?.port && <Hint>Not showing up there? Enter this device's IP with port {status.port}.</Hint>}
      </Shell>
    );
  }

  if (pairing.kind === "working") {
    return (
      <Shell step={1} title="Connecting…" footer={null}>
        <Hint>Checking the code and exchanging keys.</Hint>
      </Shell>
    );
  }

  if (pairing.kind === "confirm") {
    return (
      <Shell
        step={2}
        title="Do both screens show this?"
        footer={
          <Button variant="primary" onClick={dismissConfirmation}>
            <IconCheck className="h-4 w-4" /> They match
          </Button>
        }
      >
        <Handshake fingerprint={pairing.fingerprint} peerName={pairing.name} />
        <Hint>
          {pairing.name} should be showing the same six characters. If it isn't, something is
          intercepting the connection — unpair immediately and try again on a network you trust.
        </Hint>
        {/* The value is derived from BOTH certificates, so a device in the middle — holding a
            different key to each side — cannot make the two screens agree. */}
        <Hint>
          Both devices work this out independently from each other's keys. They can only match if
          nothing is in between.
        </Hint>
      </Shell>
    );
  }

  return (
    <Shell
      step={1}
      title={`Pair with ${pairing.target.name}`}
      footer={
        <>
          <Button variant="quiet" onClick={() => void cancelPairing()}>
            Cancel
          </Button>
          <Button variant="primary" disabled={code.length !== 6} onClick={() => void submitCode(code)}>
            Pair
          </Button>
        </>
      }
    >
      <Hint>Enter the six digits shown on that device.</Hint>
      {/* One real input behind six drawn boxes: native numeric keyboards, paste and autofill all
          keep working, which per-box inputs quietly break on Android. */}
      <div className="relative">
        <input
          ref={input}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Pairing code"
          className="absolute inset-0 w-full cursor-text opacity-0"
        />
        <div className="pointer-events-none flex justify-center gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`flex h-11 w-9 items-center justify-center rounded-lg border font-mono text-xl transition-colors ${
                i === code.length
                  ? "border-accent bg-surface-2 text-text"
                  : "border-border bg-surface-2 text-text"
              }`}
            >
              {code[i] ?? ""}
            </span>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Shell>
  );
}
