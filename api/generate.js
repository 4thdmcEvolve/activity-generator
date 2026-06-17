// Activity Generator API proxy — universal classify, then verify, then generate
// © 2026 4THDMC | EVOLVE LLC. All Rights Reserved.
//
// SETUP IN VERCEL (Settings → Environment Variables):
//   ANTHROPIC_API_KEY = your rotated Anthropic API key
//   TOOLKIT_PASSWORD  = ActivityBeta26 (or this tool's assigned password)
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
// This makes 3 to 4 sequential Anthropic calls for content with computational
// claims (classify, solve, re-derive, generate), vs. 2 for purely factual
// content, vs. 1 for purely skills-based content with nothing to verify.
// Frontend still makes ONE request and waits once — all of this happens
// inside this single endpoint.

const rateLimitStore = new Map();
const MAX_REQUESTS_PER_WINDOW = 40;
const WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(key) {
  const now = Date.now();
  const record = rateLimitStore.get(key);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, resetAt: record.resetAt };
  }
  record.count += 1;
  return { allowed: true };
}

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

  const expected = process.env.TOOLKIT_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: { message: "Server configuration error: TOOLKIT_PASSWORD not set" } });
  }
  if (!toolkitPassword || toolkitPassword !== expected) {
    return res.status(401).json({ error: { message: "Invalid or missing access password.", code: "AUTH_REQUIRED" } });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "Server configuration error: ANTHROPIC_API_KEY not set" } });
  }

  const limit = checkRateLimit(toolkitPassword);
  if (!limit.allowed) {
    const minutes = Math.ceil((limit.resetAt - Date.now()) / 60000);
    return res.status(429).json({ error: { message: `Rate limit reached. Try again in about ${minutes} minute(s).` } });
  }

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
      const solvePrompt = `Solve the following computational claims/problems from this lesson context, showing full step-by-step work for each. Use the most direct method appropriate to each problem.

COMPUTATIONAL CLAIMS:
${classification}

LESSON CONTEXT:
${lessonOrFields}

For each problem, output EXACTLY these four lines, in this order, with no line ever left blank:
Problem: [restate it]
Method used: [name the method, e.g. "reverse FOIL" or "compound interest formula"]
Worked solution: [full steps]
Answer: [the final numeric/algebraic answer — this line is REQUIRED and must always contain the actual answer value, never left blank or cut short]

CRITICAL: Before moving to the next problem, confirm the Answer line for the current problem is complete and contains an actual value. Never end a problem's entry without a filled-in Answer line.`;

      const passA = await callAnthropic({
        model: "claude-sonnet-4-6",
        maxTokens: 1000,
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
        maxTokens: 1000,
        prompt: verifyPrompt,
      });

      const passBText = passB.ok ? passB.text : "";

      // If the independent verification pass found anything INCORRECT,
      // do not pass the unverified content forward. Flag it instead of
      // silently using potentially wrong numbers.
      computationalPassed = !/INCORRECT/i.test(passBText) && passA.ok && passB.ok;

      computationalNotes = computationalPassed
        ? `${passAText}\n\n--- Independently re-verified using a different method: ---\n${passBText}`
        : `Verification found a discrepancy and could not confirm all problems independently. Original work:\n${passAText}\n\nVerification attempt:\n${passBText}`;
    }

    // ── STEP 3: GENERATE ───────────────────────────────────────────────
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
      maxTokens: 1200,
      prompt: genPrompt,
    });

    if (!genResult.ok) {
      return res.status(500).json({ error: { message: genResult.raw?.error?.message || "Generation failed." } });
    }

    if (!genResult.text) {
      return res.status(500).json({ error: { message: "Nothing was generated. Please try again." } });
    }

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
      verificationNotes: verificationBlock,
    });
  } catch (error) {
    return res.status(500).json({ error: { message: "Proxy error: " + error.message } });
  }
}
