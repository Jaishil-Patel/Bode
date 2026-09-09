/*
 * What kind of input and screen we are dealing with.
 *
 * Kept apart from `files.ts`, which is about reading and writing PDF bytes — `isAndroid` lives
 * there for historical reasons and is re-exported through here rather than moved, so nothing
 * that already imports it has to change.
 */
import { isAndroid } from "./files";

/**
 * Whether a finger, rather than a mouse, is the primary way of pointing at things.
 *
 * The highlight tool swaps in its own text selection when this is true. `pointer: coarse` alone
 * is not enough — a touchscreen laptop reports it while still being driven by a trackpad — so it
 * is paired with an actual touch count.
 */
export const isTouchPrimary = (): boolean =>
  isAndroid() ||
  (typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches &&
    navigator.maxTouchPoints > 0);

/**
 * Whether the screen is small enough that a hand covers a meaningful part of it. Used to decide
 * whether the selection loupe is worth showing at all — on a tablet there is room to see around
 * your own thumb, and on a desktop there is no thumb.
 */
export const isPhone = (): boolean => Math.min(window.innerWidth, window.innerHeight) < 600;
