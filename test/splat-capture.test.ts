import { describe, expect, it } from "vitest";
import { resolveCaptureSize } from "../src/export/splat-capture.js";

describe("resolveCaptureSize", () => {
  it("puts maxDim on the long side and preserves aspect", () => {
    expect(resolveCaptureSize(800, 600, 1920, 8192)).toEqual({
      width: 1920,
      height: 1440,
    });
    expect(resolveCaptureSize(600, 800, 1920, 8192)).toEqual({
      width: 1440,
      height: 1920,
    });
  });

  it("clamps to the GPU texture limit", () => {
    expect(resolveCaptureSize(16, 9, 8192, 2048)).toEqual({
      width: 2048,
      height: 1152,
    });
  });
});
