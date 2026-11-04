/** Liveness check for Render. Deliberately does not touch the database. */
export function GET() {
  return Response.json({ ok: true });
}
