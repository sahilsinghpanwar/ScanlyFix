/** One-way user attribution — raw id/email KABHI wire par nahi jata. */
export async function hashUserId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 32); // 128-bit truncated — attribution ke liye kaafi, re-identifiable nahi
}