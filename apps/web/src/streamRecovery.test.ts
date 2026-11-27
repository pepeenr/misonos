import { describe, expect, it } from "vitest";
import { MAX_RESUMES, planResume, type ResumeState } from "./streamRecovery.js";

describe("a song whose stream fails on this device", () => {
  it("is opened again from where it was, waiting a little longer each time, a few times", () => {
    let state: ResumeState | null = null;
    const delays: number[] = [];
    for (let i = 0; i < MAX_RESUMES; i++) {
      const plan = planResume(state, "navidrome\nsong", 95.2, 2);
      expect(plan).not.toBeNull();
      state = plan!.state;
      delays.push(plan!.delayMs);
    }
    expect(delays).toEqual([1000, 2000, 3000, 4000]);
    expect(planResume(state, "navidrome\nsong", 95.2, 2)).toBeNull();
  });

  it("starts counting again for the next song", () => {
    const worn: ResumeState = { key: "navidrome\nsong", count: MAX_RESUMES };
    expect(planResume(worn, "navidrome\nnext", 10, 2)?.state).toEqual({ key: "navidrome\nnext", count: 1 });
  });

  it("is skipped when it never played or the browser can't play it", () => {
    expect(planResume(null, "navidrome\nsong", 0, 2)).toBeNull();
    expect(planResume(null, "navidrome\nsong", 40, 4)).toBeNull();
  });
});
