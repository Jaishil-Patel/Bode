import { describe, expect, it } from "vitest";
import { docKeyFor, isShareableKey, rekey, type KeyContext } from "./docKey";

/*
 * The property that matters is in `the_same_document_gets_the_same_key_on_both_devices`: everything
 * else about sync is downstream of two devices agreeing on what to call a file.
 */

const desktop: KeyContext = { deviceId: "d7f3a91c", shareRoot: "C:\\Users\\jaish\\Papers" };
const phone: KeyContext = { deviceId: "b21ee004", shareRoot: null };

describe("docKeyFor", () => {
  it("gives the same document the same key on both devices", () => {
    // The desktop knows it by its own path under the folder it shares…
    const onDesktop = docKeyFor("C:\\Users\\jaish\\Papers\\Fluid Mechanics.pdf", desktop);
    // …the phone by the bode:// id it was handed. Same string, or nothing else works.
    const onPhone = docKeyFor("bode://d7f3a91c/Fluid%20Mechanics.pdf", phone);
    expect(onDesktop).toBe("d7f3a91c/Fluid Mechanics.pdf");
    expect(onPhone).toBe(onDesktop);
  });

  it("agrees on nested paths too", () => {
    expect(docKeyFor("C:\\Users\\jaish\\Papers\\2024\\notes.md", desktop)).toBe(
      docKeyFor("bode://d7f3a91c/2024/notes.md", phone),
    );
  });

  it("leaves a document outside the shared folder as a plain path", () => {
    // Nothing else can name it, so inventing a key would only create collisions.
    const path = "C:\\Users\\jaish\\Desktop\\scratch.pdf";
    expect(docKeyFor(path, desktop)).toBe(path);
  });

  it("does not treat a sibling folder with a shared prefix as inside the share", () => {
    // "Papers2" starts with "Papers" — a naive startsWith would wrongly claim it.
    const path = "C:\\Users\\jaish\\Papers2\\other.pdf";
    expect(docKeyFor(path, desktop)).toBe(path);
  });

  it("falls back to the path when this device is not sharing", () => {
    const path = "/storage/emulated/0/Download/a.pdf";
    expect(docKeyFor(path, phone)).toBe(path);
  });

  it("passes an unparseable bode id through rather than inventing a key", () => {
    expect(docKeyFor("bode://", phone)).toBe("bode://");
  });

  it("decodes the remote path, so escapes never reach the key", () => {
    expect(docKeyFor("bode://dev/caf%C3%A9%20notes.md", phone)).toBe("dev/café notes.md");
  });
});

describe("isShareableKey", () => {
  it("accepts a real doc key", () => {
    expect(isShareableKey("d7f3a91c4b2e8a01/Papers/thesis.pdf")).toBe(true);
  });

  it("rejects local paths, which must never leave the device", () => {
    // The whole point: a laxer test would send `/storage/emulated/0/...` to a peer.
    expect(isShareableKey("/storage/emulated/0/Download/a.pdf")).toBe(false);
    expect(isShareableKey("C:\\Users\\jaish\\a.pdf")).toBe(false);
    expect(isShareableKey("content://com.android.providers/doc/1")).toBe(false);
    expect(isShareableKey("bode://d7f3a91c4b2e8a01/a.pdf")).toBe(false);
  });

  it("rejects a device id with nothing after it", () => {
    expect(isShareableKey("d7f3a91c4b2e8a01/")).toBe(false);
    expect(isShareableKey("d7f3a91c4b2e8a01")).toBe(false);
  });
});

describe("rekey", () => {
  it("moves shared documents under their doc key and leaves the rest alone", () => {
    const before = {
      "C:\\Users\\jaish\\Papers\\a.pdf": ["one"],
      "C:\\Users\\jaish\\Desktop\\b.pdf": ["two"],
    };
    const after = rekey(before, desktop, (a, b) => [...a, ...b]);
    expect(after["d7f3a91c/a.pdf"]).toEqual(["one"]);
    expect(after["C:\\Users\\jaish\\Desktop\\b.pdf"]).toEqual(["two"]);
  });

  it("combines rather than drops when two paths collapse to one key", () => {
    // Annotating before sharing and again after leaves two entries for one document. Taking
    // whichever came last in the object would silently lose half the user's work.
    const before = {
      "C:\\Users\\jaish\\Papers\\a.pdf": ["before"],
      "C:/Users/jaish/Papers/a.pdf": ["after"],
    };
    const after = rekey(before, desktop, (a, b) => [...a, ...b]);
    expect(after["d7f3a91c/a.pdf"]).toEqual(["before", "after"]);
    expect(Object.keys(after)).toHaveLength(1);
  });

  it("is a no-op when the device is not sharing", () => {
    const before = { "/a/b.pdf": [1], "/c/d.pdf": [2] };
    expect(rekey(before, phone, (a) => a)).toEqual(before);
  });
});
