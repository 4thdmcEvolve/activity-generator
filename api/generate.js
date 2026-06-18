// Activity Generator API proxy — universal classify, then verify, then generate
// © 2026 4THDMC | EVOLVE LLC. All Rights Reserved.
//
// SETUP IN VERCEL (Settings → Environment Variables):
//   ANTHROPIC_API_KEY = your rotated Anthropic API key
//   KV_REST_API_URL   = from Upstash dashboard
//   KV_REST_API_TOKEN = from Upstash dashboard
//
// NOTE: TOOLKIT_PASSWORD env var is no longer used. Remove it from Vercel.
//
// ARCHITECTURE — replaces subject-keyword regex with a universal pre-pass:
//
// 1. CLASSIFY: one call asks the model to read the lesson content and identify
//    every checkable claim, tagging each as "factual" (needs web lookup) or
//    "computational" (needs math verification). Works across any subject —
//    no keyword list to maintain, no subject ever falls through a gap.
//
// 2. VERIFY:
//    - Factual claims -> single web-search pass (same rigor as before).
//    - Computational claims -> TWO METHOD-DIVERSE passes. Pass A solves and
//      shows work. Pass B independently re-derives the SAME answer using a
//      genuinely different method (e.g. expand vs. factor, substitute vs.
//      solve, a second formula vs. the first). Only problems where both
//      passes agree are passed forward. This catches the case a single
//      self-check misses: a model being consistently wrong with itself.
//
// 3. GENERATE: builds the final activity/assignment, instructed to use only
//    the pre-verified content and never introduce a new unverified claim.
//
// 4. CROSS-CHECK: mechanical numeric comparison between verified answers
//    and generated content — catches number/scenario mismatches.
//
// This makes 3 to 5 sequential Anthropic calls depending on content type.
// Frontend still makes ONE request and waits once.

import { Redis } from '@upstash/redis';

async function callAnthropic({ model, maxTokens, prompt, useWebSearch }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) return { ok: false, text: "", raw: data };
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { ok: true, text, raw: data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const { toolkitPassword, mode, lessonContent, subject, grade, topic, extra } = req.body || {};

  // ── SUBSCRIBER VALIDATION VIA REDIS ───────────────────────────────────
  if (!toolkitPassword) {
    return res.status(401).json({ error: { message: "Access code required.", code: "AUTH_REQUIRED" } });
  }

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: { message: "Server configuration error." } });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "Server configuration error: ANTHROPIC_API_KEY not set." } });
  }

  const redis = new Redis({ url: redisUrl, token: redisToken });
  const key = 'subscriber:' + toolkitPassword.trim().toLowerCase();

  let record;
  try {
    const raw = await redis.get(key);

    if (raw === null || raw === undefined) {
      return res.status(401).json({ error: { message: "Invalid or expired access code.", code: "AUTH_REQUIRED" } });
    }

    if (typeof raw === 'string') {
      try { record = JSON.parse(raw); } catch (e) { record = null; }
    } else {
      record = raw;
    }

    if (!record || typeof record.limit === 'undefined') {
      return res.status(500).json({ error: { message: "Account data error. Contact brandon@4thdmc.com." } });
    }

    // Reset usage if the monthly window has passed
    const now = Date.now();
    if (now > record.resetAt) {
      record.used = 0;
      record.resetAt = now + 30 * 24 * 60 * 60 * 1000;
      await redis.set(key, JSON.stringify(record));
    }

    // Check limit
    if (record.used >= record.limit) {
      return res.status(429).json({
        error: {
          message: `You've used all ${record.limit} generations for this month. Your limit resets on ${new Date(record.resetAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`,
          code: "LIMIT_REACHED",
        }
      });
    }

  } catch (err) {
    return res.status(500).json({ error: { message: "Server error during validation. Please try again." } });
  }

  // ── INPUT VALIDATION ──────────────────────────────────────────────────
  if (!topic || !topic.trim()) {
    return res.status(400).json({ error: { message: "Topic is required." } });
  }

  const safeMode = mode === "assignment" ? "assignment" : "activity";
  const lessonOrFields = lessonContent || `${subject || ""} / ${grade || ""} / ${topic}`;

  try {
    // ── STEP 1: UNIVERSAL CLASSIFICATION ──────────────────────────────────
    const classifyPrompt = `Read the lesson context below and identify every specific claim that could be checked for accuracy — regardless of subject area. This applies to ANY subject: literature, history, science, math, business, economics, civics, health, culinary arts, anything.

For each claim found, classify it as exactly one of:
- FACTUAL: a real-world claim that could be looked up (a historical event, a scientific fact, a named person, a business/economic principle, a civics fact, a statistic)
- COMPUTATIONAL: a claim that requires a calculation or formula to verify (math, a financial calculation, a scientific formula, a measurement conversion, statistics)

If there is nothing checkable (purely skills-based content like grammar rules, brainstorming, or open-ended discussion with no factual or numeric claims), say "NOTHING TO VERIFY."

LESSON CONTEXT:
${lessonOrFields}

Output format, one line per claim:
FACTUAL: [claim]
or
COMPUTATIONAL: [claim]
or just: NOTHING TO VERIFY`;

    const classifyResult = await callAnthropic({
      model: "claude-sonnet-4-6",
      maxTokens: 600,
      prompt: classifyPrompt,
    });

    const classification = classifyResult.ok ? classifyResult.text : "NOTHING TO VERIFY";
    const hasFactual = /FACTUAL:/i.test(classification);
    const hasComputational = /COMPUTATIONAL:/i.test(classification);

    let factualNotes = "";
    let computationalNotes = "";
    let computationalPassed = true;

    // ── STEP 2a: FACTUAL VERIFICATION (web search) ────────────────────────
    if (hasFactual) {
      const factCheckPrompt = `The following claims were identified in a lesson and need verification via web search.

Check EVERY claim, but report concisely: do NOT explain or describe claims that are simply confirmed accurate. Only give detail on claims that are INCORRECT or that need an important NUANCE a teacher should know before presenting it to students (e.g. "true for adults but not larvae", "true generally but this specific example is an exception").

CLAIMS TO VERIFY:
${classification}

LESSON CONTEXT (for reference):
${lessonOrFields}

OUTPUT FORMAT — exactly this structure:
SUMMARY: [X] of [Y] claims confirmed accurate with no issues.

[Only include the section below if there is at least one flagged claim. If everything passed clean, end after the SUMMARY line and write nothing else.]

FLAGGED CLAIMS:
- [claim]: [INCORRECT or NUANCE] — [brief explanation and correction if needed]`;

      const factResult = await callAnthropic({
        model: "claude-sonnet-4-6",
        maxTokens: 800,
        prompt: factCheckPrompt,
        useWebSearch: true,
      });
      factualNotes = factResult.ok ? factResult.text : "Fact verification could not be completed.";
    }

    // ── STEP 2b: COMPUTATIONAL VERIFICATION (two method-diverse passes) ───
    if (hasComputational) {
      const solvePrompt = `Solve the computational content in this lesson, showing full step-by-step work for each.

CRITICAL: Do not work from a vague restatement of the topic. Go back to the LESSON CONTEXT below and find every SPECIFIC numeric scenario actually written in it (every dollar amount, rate, time period, and any derived/follow-on scenario like "what if it stops at year X and continues to year Y"). Solve each one using its EXACT original numbers. If the lesson contains multiple related scenarios (e.g. a comparison between two paths, or a multi-step scenario), solve every step of every scenario individually — do not skip or summarize any of them.

COMPUTATIONAL CLAIMS IDENTIFIED:
${classification}

LESSON CONTEXT (the authoritative source for exact numbers — re-read it for every scenario, do not rely only on the claims list above):
${lessonOrFields}

For each individual numeric scenario, output EXACTLY these four lines, in this order, with no line ever left blank:
Problem: [restate it with its EXACT original numbers from the lesson]
Method used: [name the method]
Worked solution: [full steps]
Answer: [the final numeric/algebraic answer — this line is REQUIRED and must always contain the actual answer value, never left blank or cut short]

CRITICAL: Before moving to the next problem, confirm the Answer line for the current problem is complete and contains an actual value. If the lesson has 5 distinct numeric scenarios, you must output 5 separate Problem/Answer entries, not a condensed summary of fewer.`;

      const passA = await callAnthropic({
        model: "claude-sonnet-4-6",
        maxTokens: 1600,
        prompt: solvePrompt,
      });

      const passAText = passA.ok ? passA.text : "";

      const verifyPrompt = `Below are solved problems with their answers. Independently verify each answer using a DIFFERENT method than was likely used to solve it originally — for example, if it looks like factoring was used, verify by expanding; if substitution was used to solve, verify by solving directly; if one formula was used, verify with an alternate formula or by working backward from the answer.

Do not just re-check the same way — use a genuinely different verification approach for each problem. State clearly whether each answer is CONFIRMED or INCORRECT, and if incorrect, give the correct answer.

SOLVED PROBLEMS TO VERIFY:
${passAText}

For each problem, output:
Problem: [restate it]
Verification method used: [different from original method]
Verification work: [show it]
Result: CONFIRMED or INCORRECT (if incorrect, state the correct answer)`;

      const passB = await callAnthropic({
        model: "claude-sonnet-4-6",
        maxTokens: 1600,
        prompt: verifyPrompt,
      });

      const passBText = passB.ok ? passB.text : "";

      computationalPassed = !/INCORRECT/i.test(passBText) && passA.ok && passB.ok;

      computationalNotes = computationalPassed
        ? `${passAText}\n\n--- Independently re-verified using a different method: ---\n${passBText}`
        : `Verification found a discrepancy and could not confirm all problems independently. Original work:\n${passAText}\n\nVerification attempt:\n${passBText}`;
    }

    // ── STEP 3: GENERATE ───────────────────────────────────────────────────
    const modeInstructions = safeMode === "activity"
      ? `Build a CLASSROOM ACTIVITY students will DO during class. This means a structured task with clear steps, materials, timing, and student instructions. Not a worksheet of questions — an actual activity (game, station rotation, partner task, simulation, sorting exercise, etc.) that fits the lesson topic.`
      : `Build an ASSIGNMENT students will complete independently. This means specific tasks/questions/prompts with clear instructions.`;

    let verificationBlock = "No specific claims requiring verification were detected in this content.";
    let usageRule = "Ground this specifically in the lesson content provided.";

    if (hasFactual && hasComputational) {
      verificationBlock = `FACTUAL CLAIMS — VERIFIED:\n${factualNotes}\n\nCOMPUTATIONAL CLAIMS — ${computationalPassed ? "VERIFIED (two independent methods agree)" : "COULD NOT BE FULLY VERIFIED"}:\n${computationalNotes}`;
      usageRule = computationalPassed
        ? "Use ONLY the facts confirmed above and the EXACT verified numbers/problems below — do not invent new factual claims or new numeric examples."
        : "Use ONLY the facts confirmed above. The computational examples below could not be fully verified — use simpler, more conservative numeric examples than what was attempted, or omit numeric specifics and describe the process generically instead.";
    } else if (hasFactual) {
      verificationBlock = factualNotes;
      usageRule = "Use ONLY facts confirmed above. Do not state any specific factual claim that was not verified — write generically instead if unsure.";
    } else if (hasComputational) {
      verificationBlock = computationalNotes;
      usageRule = computationalPassed
        ? "The verification notes contain pre-checked problems confirmed correct by two independent methods. USE THESE EXACT NUMBERS — do not invent new numeric examples."
        : "Verification could not confirm the attempted examples. Use simpler, well-known numeric examples instead, or describe the process without specific unverified numbers.";
    }

    const genPrompt = `You are an expert teacher creating classroom materials. ${modeInstructions}

CRITICAL RULES:
- Use PLAIN TEXT only. No markdown, no asterisks, no hashtags.
- ${usageRule}
- Ground this specifically in the lesson content provided — do not write a generic activity that could apply to any topic. Reference the actual objectives, skills, or content from the lesson.
- Be concise but complete.

LESSON CONTEXT THE TEACHER PROVIDED:
${lessonContent || "None pasted — using manual fields below."}

MANUAL FIELDS:
Subject: ${subject || "Not specified"}
Grade: ${grade || "Not specified"}
Topic: ${topic}
Extra direction from teacher: ${extra || "None"}

VERIFICATION RESULTS:
${verificationBlock}

OUTPUT FORMAT — exactly these sections:

TITLE
One line title for this activity.

OVERVIEW
2-3 sentences: what this is, how long it takes, what students will do.

MATERIALS NEEDED
Short list.

INSTRUCTIONS
Numbered step-by-step instructions a teacher could hand to students or read aloud.

HOW TO KNOW IT WORKED
1-2 sentences: what successful completion looks like, tied to the lesson objectives.`;

    const genResult = await callAnthropic({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1800,
      prompt: genPrompt,
    });

    if (!genResult.ok) {
      return res.status(500).json({ error: { message: genResult.raw?.error?.message || "Generation failed." } });
    }

    if (!genResult.text) {
      return res.status(500).json({ error: { message: "Nothing was generated. Please try again." } });
    }

    // ── STEP 4: CROSS-CHECK ────────────────────────────────────────────────
    let crossCheckFlag = null;
    if (hasComputational && computationalPassed) {
      const crossCheckPrompt = `Below is a VERIFIED set of correct numeric answers, and a GENERATED activity that was supposed to use only those exact verified numbers.

Compare every dollar amount, percentage, and numeric result in the GENERATED ACTIVITY against the VERIFIED ANSWERS. Check specifically for: (1) a verified number being attached to the wrong scenario or wrong time period than it was verified for, (2) any number appearing in the generated activity that does not match any verified answer, (3) any internal inconsistency between two numbers in the generated activity that are supposed to relate to each other (e.g. a starting amount, a final amount, and a stated growth rate should all be mutually consistent).

VERIFIED ANSWERS:
${computationalNotes}

GENERATED ACTIVITY:
${genResult.text}

Output format:
If everything matches correctly: just write "ALL NUMBERS MATCH VERIFIED ANSWERS."
If there is a mismatch: write "MISMATCH FOUND:" followed by exactly what doesn't match and what the correct verified number should be.`;

      const crossCheck = await callAnthropic({
        model: "claude-sonnet-4-6",
        maxTokens: 500,
        prompt: crossCheckPrompt,
      });

      if (crossCheck.ok && /MISMATCH FOUND/i.test(crossCheck.text)) {
        crossCheckFlag = crossCheck.text;
      }
    }

    // ── DECREMENT USAGE IN REDIS ───────────────────────────────────────────
    // Only decrement after a successful generation
    try {
      record.used += 1;
      await redis.set(key, JSON.stringify(record));
    } catch (err) {
      // Don't fail the response if the decrement fails — generation succeeded
      console.error("Failed to decrement usage:", err);
    }

    const remaining = record.limit - record.used;

    const verificationType = hasFactual && hasComputational
      ? "both"
      : hasFactual
      ? "facts"
      : hasComputational
      ? "math"
      : "none";

    return res.status(200).json({
      text: genResult.text,
      verificationRan: hasFactual || hasComputational,
      verificationType,
      computationalPassed: hasComputational ? computationalPassed : null,
      crossCheckFlag,
      verificationNotes: verificationBlock,
      remaining,
      limit: record.limit,
    });

  } catch (error) {
    return res.status(500).json({ error: { message: "Proxy error: " + error.message } });
  }
}
