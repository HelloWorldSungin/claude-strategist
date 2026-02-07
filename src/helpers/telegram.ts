/**
 * Telegram API helpers for sending messages outside the bot context.
 * Used by cron jobs to send notifications.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

const MAX_MESSAGE_LENGTH = 4000; // Telegram limit is 4096, leave buffer

/**
 * Send a message via Telegram Bot API (for use outside grammyJS context).
 */
export async function sendTelegram(
  message: string,
  options?: { parseMode?: "Markdown" | "HTML" }
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: options?.parseMode || "Markdown",
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(`Telegram API error: ${response.status} ${err}`);
      // Retry without parse_mode if markdown failed
      if (options?.parseMode) {
        return sendTelegram(message);
      }
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram send error:", error);
    return false;
  }
}

/**
 * Send a long message, splitting into chunks at natural boundaries.
 */
export async function sendTelegramChunked(message: string): Promise<boolean> {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return sendTelegram(message);
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitIndex === -1)
      splitIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitIndex === -1)
      splitIndex = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_MESSAGE_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  let allOk = true;
  for (const chunk of chunks) {
    const ok = await sendTelegram(chunk);
    if (!ok) allOk = false;
    // Small delay between chunks to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  return allOk;
}
