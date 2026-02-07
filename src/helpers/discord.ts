/**
 * Discord webhook helpers for sending messages outside the bot context.
 * Used by cron jobs to send notifications.
 */

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const MAX_MESSAGE_LENGTH = 1900; // Discord limit is 2000, leave buffer

/**
 * Send a message via Discord webhook (for use outside discord.js Client context).
 */
export async function sendDiscord(message: string): Promise<boolean> {
  if (!WEBHOOK_URL) {
    console.error("Missing DISCORD_WEBHOOK_URL");
    return false;
  }

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.substring(0, 2000) }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Discord webhook error: ${response.status} ${err}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Discord send error:", error);
    return false;
  }
}

/**
 * Send a long message, splitting into chunks at natural boundaries.
 */
export async function sendDiscordChunked(message: string): Promise<boolean> {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return sendDiscord(message);
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
    const ok = await sendDiscord(chunk);
    if (!ok) allOk = false;
    // Small delay between chunks to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  return allOk;
}
