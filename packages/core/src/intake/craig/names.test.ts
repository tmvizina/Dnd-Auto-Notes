import { describe, expect, it } from "vitest";
import { isTrackFile, parseCraigName, stemOf, TRACK_EXTENSIONS } from "./names.js";

describe("parseCraigName", () => {
  it("parses Craig's convention", () => {
    expect(parseCraigName("1-ashcodes.flac")).toEqual({
      index: 1,
      username: "ashcodes",
      discriminator: null,
      stem: "1-ashcodes",
      warning: null,
    });
  });

  it("splits off a legacy discriminator", () => {
    const parsed = parseCraigName("12-blybird_0417.aac");
    expect(parsed.index).toBe(12);
    expect(parsed.username).toBe("blybird");
    expect(parsed.discriminator).toBe("0417");
    expect(parsed.warning).toBeNull();
  });

  it("keeps an underscore that is part of the username", () => {
    // The whole reason the discriminator rule is digits-only: "cyd_h" is one
    // Discord handle, and splitting it would unbind a real player's track.
    const parsed = parseCraigName("3-cyd_h.wav");
    expect(parsed.username).toBe("cyd_h");
    expect(parsed.discriminator).toBeNull();
  });

  it("keeps unicode display names intact", () => {
    const parsed = parseCraigName("4-Séraphine Ω.ogg");
    expect(parsed.index).toBe(4);
    expect(parsed.username).toBe("Séraphine Ω");
    expect(parsed.warning).toBeNull();
  });

  describe("malformed names never throw", () => {
    it("falls back to the stem when there is no index", () => {
      const parsed = parseCraigName("ashcodes.flac");
      expect(parsed.index).toBeNull();
      expect(parsed.username).toBe("ashcodes");
      expect(parsed.warning).toBe("no leading track index");
    });

    it("falls back to the stem when there is no username", () => {
      const parsed = parseCraigName("7-.mp3");
      expect(parsed.index).toBe(7);
      // Better a track called "7-" that a human can find than a nameless one.
      expect(parsed.username).toBe("7-");
      expect(parsed.warning).toBe("no username after the track index");
    });

    it("handles a stem that is only a discriminator", () => {
      const parsed = parseCraigName("2-_0417.m4a");
      expect(parsed.index).toBe(2);
      expect(parsed.discriminator).toBe("0417");
      expect(parsed.username).toBe("2-_0417");
    });

    it("handles an empty stem", () => {
      const parsed = parseCraigName(".wav");
      expect(parsed.index).toBeNull();
      expect(parsed.username).toBe("");
      expect(parsed.stem).toBe("");
    });

    it("tolerates an underscore or a space as the separator", () => {
      expect(parseCraigName("5_wren_dm.flac").username).toBe("wren_dm");
      expect(parseCraigName("6 wren.flac").username).toBe("wren");
    });
  });
});

describe("isTrackFile", () => {
  it("accepts every extension Craig emits", () => {
    for (const extension of TRACK_EXTENSIONS) {
      expect(isTrackFile(`1-ash${extension}`)).toBe(true);
    }
  });

  it("is case insensitive", () => {
    expect(isTrackFile("1-ash.FLAC")).toBe(true);
  });

  it("rejects the sidecar files in the same folder", () => {
    expect(isTrackFile("info.txt")).toBe(false);
    expect(isTrackFile("raw.dat")).toBe(false);
    expect(isTrackFile("craig-download.zip")).toBe(false);
  });
});

describe("stemOf", () => {
  it("strips only a known extension", () => {
    expect(stemOf("1-ash.flac")).toBe("1-ash");
    expect(stemOf("1-ash.v2.flac")).toBe("1-ash.v2");
    expect(stemOf("notes.txt")).toBe("notes.txt");
  });
});
