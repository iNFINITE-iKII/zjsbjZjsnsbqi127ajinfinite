import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { logger } from "../../lib/logger.js";

type DeferrableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

/**
 * Safely calls deferReply and returns true on success.
 *
 * Returns false (without throwing) for two known-safe Discord errors:
 *
 * - 10062 "Unknown Interaction": the 3-second acknowledgement window has
 *   passed (server cold-start or overload). No reply is possible.
 *
 * - 40060 "Interaction has already been acknowledged": another instance of
 *   the bot (e.g. Railway + Replit running simultaneously) already handled
 *   this interaction. Skip silently to avoid double-processing.
 *
 * Any other error is re-thrown so the caller's catch block can log it.
 *
 * Usage:
 *   if (!await safeDefer(interaction)) return;
 */
export async function safeDefer(
  interaction: DeferrableInteraction,
  options: { ephemeral?: boolean } = { ephemeral: true }
): Promise<boolean> {
  try {
    await interaction.deferReply(options);
    return true;
  } catch (err) {
    const code = (err as { code?: number })?.code;

    if (code === 10062) {
      logger.warn(
        { interactionId: interaction.id },
        "safeDefer: interaction expired (10062) — skipping handler"
      );
      return false;
    }

    if (code === 40060) {
      logger.warn(
        { interactionId: interaction.id },
        "safeDefer: interaction already acknowledged (40060) — likely duplicate bot instance, skipping"
      );
      return false;
    }

    throw err;
  }
}
