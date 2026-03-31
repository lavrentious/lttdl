import { describe, expect, test } from "bun:test";
import {
  cancelTrackedOperation,
  completeTrackedOperation,
  createTrackedOperation,
  parseCancelCallbackData,
} from "./operation-registry";

describe("operation registry", () => {
  test("parses cancel callback payloads", () => {
    expect(parseCancelCallbackData("cancel:op-123")).toBe("op-123");
    expect(parseCancelCallbackData("music:pick:1:2:3")).toBeNull();
  });

  test("cancels operations for the owner and aborts the controller", () => {
    const operation = createTrackedOperation(42);

    const result = cancelTrackedOperation(operation.id, 42);
    expect(result.status).toBe("cancelled");
    expect(operation.controller.signal.aborted).toBe(true);
  });

  test("rejects cancellation from another user", () => {
    const operation = createTrackedOperation(42);

    expect(cancelTrackedOperation(operation.id, 7)).toEqual({ status: "forbidden" });
  });

  test("treats completed operations as finished", () => {
    const operation = createTrackedOperation(42);
    completeTrackedOperation(operation.id);

    expect(cancelTrackedOperation(operation.id, 42)).toEqual({ status: "not_found" });
  });
});
