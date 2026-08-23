import { describe, expect, it } from "vitest";

import { addMonthsClamped, computeTermSchedule, isValidTermMonths, proformaDueDate, termEndDate } from "../src/pricing/term-schedule.js";

describe("addMonthsClamped", () => {
  it("adds whole months keeping the day-of-month", () => {
    expect(addMonthsClamped(new Date(2026, 7, 1), 1)).toEqual(new Date(2026, 8, 1));
    expect(addMonthsClamped(new Date(2026, 7, 16), 3)).toEqual(new Date(2026, 10, 16));
  });

  it("clamps to the last day of a short target month instead of overflowing", () => {
    expect(addMonthsClamped(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28));
    expect(addMonthsClamped(new Date(2028, 0, 31), 1)).toEqual(new Date(2028, 1, 29)); // leap year
    expect(addMonthsClamped(new Date(2026, 2, 31), 1)).toEqual(new Date(2026, 3, 30));
  });

  it("rolls over the year boundary", () => {
    expect(addMonthsClamped(new Date(2026, 10, 15), 3)).toEqual(new Date(2027, 1, 15));
    expect(addMonthsClamped(new Date(2026, 11, 1), 12)).toEqual(new Date(2027, 11, 1));
  });
});

describe("termEndDate / isValidTermMonths", () => {
  it("1 Aug + 1 month ends (exclusive) on 1 Sep — the owner's worked example", () => {
    expect(termEndDate(new Date(2026, 7, 1), 1)).toEqual(new Date(2026, 8, 1));
  });
  it("only accepts the four offered terms", () => {
    expect([1, 3, 6, 12].every(isValidTermMonths)).toBe(true);
    expect([0, 2, 4, 24, -1, 1.5, "3"].some(isValidTermMonths)).toBe(false);
  });
});

describe("proformaDueDate", () => {
  const issued = new Date(2026, 7, 10);
  it("is issue + 7 days when move-in is further out than that", () => {
    expect(proformaDueDate(issued, new Date(2026, 8, 1))).toEqual(new Date(2026, 7, 17));
  });
  it("is the move-in day when move-in is sooner than 7 days (payment before move-in)", () => {
    expect(proformaDueDate(issued, new Date(2026, 7, 13))).toEqual(new Date(2026, 7, 13));
  });
  it("never lands before the issue day even for a back-dated move-in", () => {
    expect(proformaDueDate(issued, new Date(2026, 7, 1))).toEqual(issued);
  });
});

describe("computeTermSchedule", () => {
  const issuedOn = new Date(2026, 7, 5);

  it("produces N full-month periods with inclusive period ends", () => {
    const schedule = computeTermSchedule(new Date(2026, 7, 16), 3, { issuedOn });
    expect(schedule).toHaveLength(3);
    expect(schedule.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(schedule[0]!.periodStart).toEqual(new Date(2026, 7, 16));
    expect(schedule[0]!.periodEnd).toEqual(new Date(2026, 8, 15));
    expect(schedule[1]!.periodStart).toEqual(new Date(2026, 8, 16));
    expect(schedule[1]!.periodEnd).toEqual(new Date(2026, 9, 15));
    expect(schedule[2]!.periodStart).toEqual(new Date(2026, 9, 16));
    expect(schedule[2]!.periodEnd).toEqual(new Date(2026, 10, 15));
    expect(schedule[2]!.nextPeriodStart).toEqual(termEndDate(new Date(2026, 7, 16), 3));
  });

  it("cycle invoices are due on the period start and issued leadDays earlier", () => {
    const [, second] = computeTermSchedule(new Date(2026, 7, 16), 3, { issuedOn, leadDays: 7 });
    expect(second!.dueDate).toEqual(new Date(2026, 8, 16));
    expect(second!.issueDate).toEqual(new Date(2026, 8, 9));
  });

  it("the proforma (index 0) is issued on the generation day and due before move-in", () => {
    const [first] = computeTermSchedule(new Date(2026, 8, 1), 6, { issuedOn });
    expect(first!.issueDate).toEqual(issuedOn);
    expect(first!.dueDate).toEqual(new Date(2026, 7, 12)); // issue + 7, well before 1 Sep
  });

  it("never schedules a cycle issue date before the generation day (move-in within lead time)", () => {
    const [, second] = computeTermSchedule(new Date(2026, 7, 7), 3, { issuedOn, leadDays: 7 });
    expect(second!.dueDate).toEqual(new Date(2026, 8, 7));
    expect(second!.issueDate).toEqual(new Date(2026, 7, 31));
    const [, tight] = computeTermSchedule(new Date(2026, 7, 6), 3, { issuedOn, leadDays: 40 });
    expect(tight!.issueDate).toEqual(issuedOn);
  });

  it("month-end move-ins clamp every period start consistently", () => {
    const schedule = computeTermSchedule(new Date(2026, 0, 31), 3, { issuedOn: new Date(2026, 0, 20) });
    expect(schedule.map((p) => p.periodStart)).toEqual([new Date(2026, 0, 31), new Date(2026, 1, 28), new Date(2026, 2, 31)]);
    expect(schedule[1]!.periodEnd).toEqual(new Date(2026, 2, 30));
  });

  it("rejects a non-positive term", () => {
    expect(() => computeTermSchedule(new Date(2026, 7, 1), 0)).toThrow();
  });
});
