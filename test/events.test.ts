import { describe, expect, it } from "vitest";

import { expiryForEvent, isEventKind, parseRoutes, seatsRemaining } from "../src/domain/events";

describe("event domain", () => {
  it("recognizes only fixed event kinds", () => {
    expect(isEventKind("live")).toBe(true);
    expect(isEventKind("conference")).toBe(false);
  });

  it("normalizes route lines", () => {
    expect(parseRoutes("出演者A\n\n 出演者B ")).toEqual(["出演者A", "出演者B"]);
  });

  it("handles finite and unlimited capacity", () => {
    expect(seatsRemaining(20, 7)).toBe(13);
    expect(seatsRemaining(5, 8)).toBe(0);
    expect(seatsRemaining(0, 8)).toBeNull();
  });

  it("deletes event data seven days after the event", () => {
    expect(expiryForEvent(1_000)).toBe(1_000 + 7 * 86400);
  });
});
