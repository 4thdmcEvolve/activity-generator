// Activity Generator auth endpoint — validates individual subscriber code via Upstash Redis
// © 2026 4THDMC | EVOLVE LLC. All Rights Reserved.
//
// SETUP IN VERCEL (Settings → Environment Variables):
//   KV_REST_API_URL   = from Upstash dashboard
//   KV_REST_API_TOKEN = from Upstash dashboard
//
// REDIS KEY STRUCTURE (set manually in Upstash Data Browser):
//   Key:   subscriber:<code>          (all lowercase, e.g. subscriber:actbeta001)
//   Value: {"limit":10,"used":0,"resetAt":1234567890000}
//   resetAt is a Unix timestamp in milliseconds — 30 days from provisioning date
//
// TO PROVISION A NEW BETA TESTER (manual, Upstash Data Browser):
//   1. Go to Upstash → Data Browser → New Key
//   2. Key: subscriber:<theircode>  (your choice, e.g. subscriber:actbeta001)
//   3. Value: {"limit":10,"used":0,"resetAt":<timestamp 30 days from now>}
//      Quick timestamp: open browser console → Date.now() + 30*24*60*60*1000
//   4. Type: String
//   5. Email them their code

import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: 'Access code required.' });
  }

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: 'Server configuration error. Contact brandon@4thdmc.com.' });
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });

  try {
    const key = 'subscriber:' + password.trim().toLowerCase();
    const raw = await redis.get(key);

    if (raw === null || raw === undefined) {
      return res.status(401).json({ error: 'Invalid access code.' });
    }

    let record;
    if (typeof raw === 'string') {
      try { record = JSON.parse(raw); } catch (e) { record = null; }
    } else {
      record = raw;
    }

    if (!record || typeof record.limit === 'undefined') {
      return res.status(500).json({ error: 'Account data error. Contact brandon@4thdmc.com.' });
    }

    // Reset usage if the monthly window has passed
    const now = Date.now();
    if (now > record.resetAt) {
      record.used = 0;
      record.resetAt = now + 30 * 24 * 60 * 60 * 1000;
      await redis.set(key, JSON.stringify(record));
    }

    const remaining = record.limit - record.used;

    return res.status(200).json({
      ok: true,
      remaining,
      limit: record.limit,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
