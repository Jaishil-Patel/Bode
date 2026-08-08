import { isAndroid } from "../platform/files";
import { Hint } from "./ui";

/*
 * What you see before anything is paired.
 *
 * This replaces four lines of grey prose that tried to explain the feature, the network
 * requirements and the failure modes at once — so the first thing a new user met was a paragraph
 * about guest Wi-Fi. The model is now shown rather than described, the three steps are numbered,
 * and every caveat is demoted behind "Nothing showing up?" where it belongs: unread until it is
 * needed, and complete when it is.
 */

/** Two devices with a link forming between them. The whole idea, in about forty pixels. */
function Illustration() {
  return (
    <svg
      viewBox="0 0 160 56"
      className="h-14 w-full text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* Laptop */}
      <rect x="14" y="16" width="40" height="26" rx="2.5" />
      <path d="M8 46h52" />
      {/* Phone */}
      <rect x="112" y="12" width="22" height="34" rx="3" />
      <path d="M120 41.5h6" />
      {/* The link. Dashes travel from one to the other, which is the only motion here. */}
      <path
        d="M62 29h44"
        strokeDasharray="4 5"
        className="animate-dash-flow text-accent"
        stroke="currentColor"
      />
      <circle cx="84" cy="29" r="4.5" className="text-accent" stroke="currentColor" />
      <path d="M84 26.5v5M81.5 29h5" className="text-accent" stroke="currentColor" />
    </svg>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted">
        {n}
      </span>
      <span className="text-sm leading-snug text-text">{children}</span>
    </li>
  );
}

export function FirstRun({ sharing }: { sharing: boolean }) {
  const android = isAndroid();

  return (
    <div className="animate-fade-in flex flex-col gap-4 rounded-xl border border-border bg-surface-2/40 p-4">
      <Illustration />
      <div>
        <h3 className="text-sm font-medium text-text">Read your desktop's documents here</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Pair two devices once and they'll find each other on your Wi-Fi. Nothing goes through an
          account or a server — the files never leave your network.
        </p>
      </div>

      {/* Direction-agnostic on purpose. Either device can show the code and either can type it, so
          describing only one direction is what left someone stuck when the other was the one in
          their hand. Sharing a folder is a separate, desktop-only job, and it comes first there
          because it is what gives the phone anything to read. */}
      <ol className="flex flex-col gap-2.5">
        {!android && !sharing && (
          <Step n={1}>
            Tap <b className="font-medium">Share a folder</b> below, so there's something to read.
          </Step>
        )}
        <Step n={android || sharing ? 1 : 2}>Open Bode on your other device.</Step>
        <Step n={android || sharing ? 2 : 3}>
          Tap <b className="font-medium">Add a device</b> on either one for a six-digit code, and
          type it on the other.
        </Step>
        <Step n={android || sharing ? 3 : 4}>
          Check the same six characters show on both screens.
        </Step>
      </ol>

      <details className="group">
        <summary className="cursor-pointer list-none text-xs text-muted transition-colors marker:content-none hover:text-text">
          Nothing showing up?
        </summary>
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          <Hint>
            Both devices have to be on the <b>same Wi-Fi</b>. Guest and hotel networks usually stop
            devices from seeing each other, and a VPN on either end will too.
          </Hint>
          <Hint>
            If they're definitely on the same network, use <b>Connect by address</b> at the bottom —
            it works on networks that block discovery but still carry a direct connection.
          </Hint>
        </div>
      </details>
    </div>
  );
}
