/**
 * Adapter contract only.
 * Implement this using a Rubika-supported API/client and confirm upload limits.
 * Do not add undocumented private endpoints or session/cookie scraping.
 */
export async function publishFile({ filePath, fileName, channelId }) {
  if (!process.env.RUBIKA_ADAPTER || process.env.RUBIKA_ADAPTER === "disabled") {
    return { status: "awaiting_rubika_adapter", message: "No supported Rubika upload adapter configured." };
  }
  throw new Error("Adapter selected but no verified implementation is installed.");
}
