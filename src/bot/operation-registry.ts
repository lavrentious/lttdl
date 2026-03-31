import { randomUUIDv7 } from "bun";
import { InlineKeyboard } from "grammy";
import { OperationCancelledError } from "src/errors/download-error";

export const CANCEL_CALLBACK_PREFIX = "cancel";

type OperationMessageRef = {
  chatId: number;
  messageId: number;
};

type TrackedOperation = {
  id: string;
  ownerId: number;
  controller: AbortController;
  cancelled: boolean;
  completed: boolean;
  message?: OperationMessageRef;
};

type CancelResult =
  | { status: "cancelled"; operation: TrackedOperation }
  | { status: "forbidden" }
  | { status: "not_found" }
  | { status: "already_cancelled" }
  | { status: "already_completed" };

const operations = new Map<string, TrackedOperation>();

export function createTrackedOperation(ownerId: number): TrackedOperation {
  const operation: TrackedOperation = {
    id: randomUUIDv7(),
    ownerId,
    controller: new AbortController(),
    cancelled: false,
    completed: false,
  };
  operations.set(operation.id, operation);
  return operation;
}

export function attachOperationMessage(
  operationId: string,
  message: OperationMessageRef,
) {
  const operation = operations.get(operationId);
  if (!operation) {
    return;
  }
  operation.message = message;
}

export function getCancelKeyboard(operationId: string) {
  return new InlineKeyboard().text(
    "cancel",
    `${CANCEL_CALLBACK_PREFIX}:${operationId}`,
  );
}

export function parseCancelCallbackData(data: string): string | null {
  const [prefix, operationId] = data.split(":", 2);
  if (prefix !== CANCEL_CALLBACK_PREFIX || !operationId) {
    return null;
  }
  return operationId;
}

export function cancelTrackedOperation(
  operationId: string,
  requesterId: number,
): CancelResult {
  const operation = operations.get(operationId);
  if (!operation) {
    return { status: "not_found" };
  }
  if (operation.ownerId !== requesterId) {
    return { status: "forbidden" };
  }
  if (operation.completed) {
    return { status: "already_completed" };
  }
  if (operation.cancelled) {
    return { status: "already_cancelled" };
  }

  operation.cancelled = true;
  operation.controller.abort(new OperationCancelledError("operation cancelled"));
  return { status: "cancelled", operation };
}

export function completeTrackedOperation(operationId: string) {
  const operation = operations.get(operationId);
  if (!operation) {
    return;
  }
  operation.completed = true;
  operations.delete(operationId);
}

export function isTrackedOperationCancelled(operationId: string): boolean {
  return operations.get(operationId)?.cancelled ?? false;
}
