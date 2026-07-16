import { describe, expect, it } from "vitest";

import { GuardFailedError, IllegalTransitionError, StateMachine } from "../src/state-machine/fsm.js";

type S = "A" | "B" | "C";
type E = "GO" | "BACK";

describe("StateMachine", () => {
  it("fires a legal transition", async () => {
    const fsm = new StateMachine<S, E, void>([{ from: "A", event: "GO", to: "B" }]);
    const result = await fsm.fire("A", "GO", undefined);
    expect(result).toEqual({ from: "A", to: "B" });
  });

  it("throws IllegalTransitionError for an unregistered transition", async () => {
    const fsm = new StateMachine<S, E, void>([{ from: "A", event: "GO", to: "B" }]);
    await expect(fsm.fire("B", "GO", undefined)).rejects.toThrow(IllegalTransitionError);
  });

  it("throws GuardFailedError when the guard rejects", async () => {
    const fsm = new StateMachine<S, E, { allowed: boolean }>([
      { from: "A", event: "GO", to: "B", guard: (ctx) => ctx.allowed },
    ]);
    await expect(fsm.fire("A", "GO", { allowed: false })).rejects.toThrow(GuardFailedError);
    await expect(fsm.fire("A", "GO", { allowed: true })).resolves.toEqual({ from: "A", to: "B" });
  });

  it("supports multiple from-states for one event", async () => {
    const fsm = new StateMachine<S, E, void>([{ from: ["A", "B"], event: "GO", to: "C" }]);
    expect(fsm.canTransition("A", "GO")).toBe(true);
    expect(fsm.canTransition("B", "GO")).toBe(true);
    expect(fsm.canTransition("C", "GO")).toBe(false);
  });

  it("lists available events from a state", () => {
    const fsm = new StateMachine<S, E, void>([
      { from: "A", event: "GO", to: "B" },
      { from: "A", event: "BACK", to: "A" },
    ]);
    expect(fsm.availableEvents("A").sort()).toEqual(["BACK", "GO"]);
  });
});
