/*
 * Every open portal for the document on screen.
 *
 * Lives beside the annotation bar in App rather than inside the viewer, because a portal is
 * pinned to the *window*: scrolling the document, or scrolling the page it came from out of the
 * virtualization window entirely, must not move it or throw it away. That independence is the
 * whole point of having pinned it.
 */
import { useViewer } from "../store/viewerStore";
import { useSettings } from "../settings/useSettings";
import PortalPane from "./PortalPane";
import { usePortals, type Portal } from "./usePortals";

/*
 * One shared empty array, not a fresh one per call.
 *
 * A zustand selector's result is compared with Object.is, so returning a new `[]` for a document
 * with no portals yet makes every render look like a state change and schedules another —
 * "getSnapshot should be cached", then the update-depth limit. It has to be the same reference
 * every time.
 */
const NONE: Portal[] = [];

export default function PortalLayer() {
  const doc = useViewer((s) => s.doc);
  const filePath = useViewer((s) => s.filePath);
  const manifest = useViewer((s) => s.pages);
  const goToPage = useViewer((s) => s.goToPage);
  const docKey = useSettings((s) => (filePath ? s.docKey(filePath) : null));
  const portals = usePortals((s) => (docKey ? (s.byDoc[docKey] ?? NONE) : NONE));

  if (!doc || !docKey || portals.length === 0) return null;

  // The raise counter is unbounded, so the *order* it describes is turned into a position here
  // and PortalPane maps that into a fixed band. Sorted rather than passed raw for the same reason.
  const stacked = [...portals].sort((a, b) => a.z - b.z);

  return (
    <>
      {stacked.map((p, i) => (
        <PortalPane
          key={p.id}
          portal={p}
          stack={i}
          doc={doc}
          docKey={docKey}
          // Pages can be reordered or deleted after a portal is opened, so the source page is
          // looked up through the manifest every render rather than captured at pin time.
          srcPage={manifest[p.pageIndex]?.srcPage ?? p.pageIndex + 1}
          onJump={() => goToPage(p.pageIndex + 1)}
        />
      ))}
    </>
  );
}
