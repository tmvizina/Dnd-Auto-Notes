import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClipPlayer, ClipUrlRegistry } from "./ClipPlayer.js";

describe("ClipPlayer", () => {
  it("does not attach an audio source before play", () => {
    const html = renderToStaticMarkup(
      <ClipPlayer label="test clip" load={async () => new Blob(["audio"])} />,
    );
    expect(html).toContain("<audio");
    expect(html).not.toContain(" src=");
  });

  it("keeps one active URL and revokes replaced URLs", () => {
    const revoked: string[] = [];
    const registry = new ClipUrlRegistry({ revokeObjectURL: (url) => revoked.push(url) });
    const first = { removeAttribute: () => undefined } as unknown as HTMLAudioElement;
    const second = { removeAttribute: () => undefined } as unknown as HTMLAudioElement;
    registry.activate(first, "blob:first");
    registry.activate(second, "blob:second");
    expect(registry.activeUrl).toBe("blob:second");
    registry.release(second);
    expect(revoked).toEqual(["blob:first", "blob:second"]);
  });

  it("revokes 100 sequential URLs without retaining them", () => {
    const revoked: string[] = [];
    const registry = new ClipUrlRegistry({ revokeObjectURL: (url) => revoked.push(url) });
    const element = { removeAttribute: () => undefined } as unknown as HTMLAudioElement;
    for (let index = 0; index < 100; index += 1) registry.activate(element, `blob:${index}`);
    registry.release();
    expect(revoked).toHaveLength(100);
    expect(registry.activeUrl).toBeNull();
  });

  it("ignores a delayed load after its player lifecycle is released", () => {
    const revoked: string[] = [];
    const registry = new ClipUrlRegistry({ revokeObjectURL: (url) => revoked.push(url) });
    const element = { removeAttribute: () => undefined } as unknown as HTMLAudioElement;
    registry.activate(element, "blob:stale");
    registry.release(element);
    // A completion arriving after unmount cannot become the active URL.
    expect(registry.activeUrl).toBeNull();
    expect(revoked).toEqual(["blob:stale"]);
  });
});
