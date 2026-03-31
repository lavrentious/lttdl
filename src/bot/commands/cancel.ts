import { type CallbackQueryContext, type Context } from "grammy";
import {
  cancelTrackedOperation,
  parseCancelCallbackData,
} from "src/bot/operation-registry";

export async function cancelCallbackQuery(ctx: CallbackQueryContext<Context>) {
  const operationId = parseCancelCallbackData(ctx.callbackQuery.data);
  if (!operationId || !ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  const result = cancelTrackedOperation(operationId, ctx.from.id);
  switch (result.status) {
    case "cancelled":
      await ctx.answerCallbackQuery({ text: "cancelling..." }).catch();
      if (result.operation.message) {
        await ctx.api
          .editMessageText(
            result.operation.message.chatId,
            result.operation.message.messageId,
            "operation cancelled",
            {
              reply_markup: undefined,
            },
          )
          .catch();
      }
      return;
    case "forbidden":
      await ctx.answerCallbackQuery({
        text: "this operation belongs to another user",
        show_alert: true,
      });
      return;
    case "already_cancelled":
      await ctx.answerCallbackQuery({ text: "already cancelling" });
      return;
    case "already_completed":
      await ctx.answerCallbackQuery({ text: "operation already finished" });
      return;
    case "not_found":
    default:
      await ctx.answerCallbackQuery({ text: "operation is no longer active" });
      return;
  }
}
