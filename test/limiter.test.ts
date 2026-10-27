import { describe, expect, it } from "vitest";
import { Limiter } from "../src/utils/limiter.js";

describe("Limiter", () => {
  it("starts waiting tasks by priority, FIFO among equals", async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    let release!: () => void;
    const first = limiter.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
      0,
    );
    const task = (name: string, priority: number) =>
      limiter.run(async () => {
        order.push(name);
      }, priority);
    const rest = [task("c", 3), task("a1", 1), task("b", 2), task("a2", 1)];
    release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["a1", "a2", "b", "c"]);
  });

  it("never runs more than its limit", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
        }, i % 3),
      ),
    );
    expect(peak).toBe(2);
  });
});
