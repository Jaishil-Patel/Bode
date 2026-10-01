import { useViewer } from "../store/viewerStore";
import type { MenuItem } from "./ContextMenu";
import {
  IconChevronUp,
  IconChevronDown,
  IconDuplicate,
  IconRotateCw,
  IconRotateCcw,
  IconTrash,
  IconPages,
} from "./icons";

/**
 * Quick page actions for one page — the few edits worth making without switching into the
 * organizer. Shown for a thumbnail in the navigation rail (right-click, or a long-press on touch),
 * and for a page in the document itself without the moves, which only make sense in a list.
 */
export function pageMenuItems(pageId: string, opts: { moves?: boolean } = {}): MenuItem[] {
  const { pages, movePagesBy, duplicatePages, rotatePages, removePages, setOrganizeOpen } =
    useViewer.getState();
  const index = pages.findIndex((p) => p.id === pageId);
  if (index < 0) return [];
  return [
    ...(opts.moves !== false
      ? ([
          {
            label: "Move up",
            icon: <IconChevronUp />,
            run: () => movePagesBy([pageId], -1),
            disabled: index === 0,
          },
          {
            label: "Move down",
            icon: <IconChevronDown />,
            run: () => movePagesBy([pageId], 1),
            disabled: index === pages.length - 1,
          },
        ] satisfies MenuItem[])
      : []),
    { label: "Rotate right", icon: <IconRotateCw />, run: () => rotatePages([pageId], 90) },
    { label: "Rotate left", icon: <IconRotateCcw />, run: () => rotatePages([pageId], -90) },
    { label: "Duplicate page", icon: <IconDuplicate />, run: () => duplicatePages([pageId]) },
    {
      label: "Delete page",
      icon: <IconTrash />,
      run: () => removePages([pageId]),
      disabled: pages.length <= 1,
      danger: true,
    },
    { kind: "separator" },
    { label: "Organize pages…", icon: <IconPages />, run: () => setOrganizeOpen(true) },
  ];
}
