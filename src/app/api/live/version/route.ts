/**
 * Fingerprint of the Live page's data (newest signal + engine's last check). The page polls
 * this every few seconds and re-renders only when it changes, so new trades show up as soon
 * as the engine records them. Read-only and contains no trade details.
 */
import { connection } from "next/server";

import { getLiveVersion } from "@/lib/queries";

export async function GET() {
  await connection();
  try {
    return Response.json(
      { v: await getLiveVersion() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ v: null }, { status: 503 });
  }
}
