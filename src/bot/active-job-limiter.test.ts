import { beforeEach, describe, expect, test } from "bun:test";
import {
  finishUserJob,
  getActiveUserJobCount,
  tryStartUserJob,
} from "./active-job-limiter";

describe("active job limiter", () => {
  beforeEach(() => {
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
  });

  test("allows jobs until the per-user limit is reached", () => {
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(false);
    expect(getActiveUserJobCount(1)).toBe(4);
  });

  test("releases active jobs back to zero", () => {
    expect(tryStartUserJob(1, 2)).toBe(true);
    expect(tryStartUserJob(1, 2)).toBe(true);

    finishUserJob(1);
    expect(getActiveUserJobCount(1)).toBe(1);

    finishUserJob(1);
    expect(getActiveUserJobCount(1)).toBe(0);
  });
});
