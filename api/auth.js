// Activity Generator auth endpoint — validates toolkit password
// © 2026 4THDMC | EVOLVE LLC. All Rights Reserved.
//
// SETUP IN VERCEL (Settings → Environment Variables):
//   TOOLKIT_PASSWORD = this tool's assigned password

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { password } = req.body || {};
  const expected = process.env.TOOLKIT_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: "Server configuration error" });
  }
  if (!password || password !== expected) {
    return res.status(401).json({ error: "Invalid password" });
  }
  return res.status(200).json({ ok: true });
}
