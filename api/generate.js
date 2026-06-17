// Activity Generator API proxy — verify-then-generate, single endpoint
// © 2026 4THDMC | EVOLVE LLC. All Rights Reserved.
//
// SETUP IN VERCEL (Settings → Environment Variables):
//   ANTHROPIC_API_KEY = your rotated Anthropic API key
//   TOOLKIT_PASSWORD  = ToolkitEvolve2026 (or this tool's assigned password)
//
// This endpoint differs from the universal generate.js used by other tools:
// it makes TWO sequential calls to Anthropic (verify, then generate) and
// returns a single combined result. Frontend makes one request, waits once.

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
  const contextBlob = `${lessonContent || ""} ${topic || ""} ${extra || ""}`;
  const needsFactCheck = /\b(book|novel|play|author|wrote|historical|war|president|invented|discovered|scientist|year \d{4}|century)\b/i.test(contextBlob);
  const needsMathCheck = /\b(factor|equation|polynomial|solve for|algebra|trinomial|quadratic|fraction|decimal|percent|geometry|theorem|derivative|integral)\b/i.test(contextBlob)
    || /\d+\s*[a-z]?\s*(\^|squared|cubed)/i.test(contextBlob);
  const needsCheck = needsFactCheck || needsMathCheck;

  try {
    let verificationNotes = "No verification was run for this request.";

    if (needsFactCheck) {
      const checkPrompt = `You are about to help build a classroom ${safeMode} based on this lesson context. Before generating anything, identify ONLY the specific factual claims worth double-checking (real book titles, real authors, real historical facts, real dates). List up to 4 claims as short bullet items. If there is nothing factual to verify (purely skills-based content like grammar or math procedures), say "No factual claims requiring verification."

LESSON CONTEXT:
${lessonContent || `${subject || ""} / ${grade || ""} / ${topic}`}`;

      const checkResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [{ role: "user", content: checkPrompt }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      });
      const checkData = await checkResponse.json();
      if (!checkData.error) {
        verificationNotes = (checkData.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || verificationNotes;
      }
    } else if (needsMathCheck) {
      // Math content cannot be verified by web search — it requires computation,
      // not lookup. This pass asks the model to generate candidate numeric
      // examples FIRST and show its work checking each one, before the main
      // generation step is allowed to use them. This is a self-consistency
      // check, not a guarantee of correctness, but it catches the most common
      // failure mode (arithmetic slips) by forcing the work to be shown.
      const mathCheckPrompt = `You are preparing numeric/algebraic examples for a classroom ${safeMode} on this topic. Before anything is built, generate 3-4 example problems appropriate to this lesson (matching its specific topic and difficulty level) and SHOW THE FULL WORKED SOLUTION for each one, step by step. Then verify each solution by checking it a second way (e.g., expanding a factored answer back out, or plugging a solved value back into the original equation). If any example fails its own check, discard it and replace it with a corrected one. Only output examples that have passed verification.

LESSON CONTEXT:
${lessonContent || `${subject || ""} / ${grade || ""} / ${topic}`}

Output format: for each example, show "Problem:", "Worked solution:", and "Verification check:" on separate lines.`;

      const checkResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 700,
          messages: [{ role: "user", content: mathCheckPrompt }],
        }),
      });
      const checkData = await checkResponse.json();
      if (!checkData.error) {
        verificationNotes = (checkData.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || verificationNotes;
      }
    }

    const modeInstructions = safeMode === "activity"
      ? `Build a CLASSROOM ACTIVITY students will DO during class. This means a structured task with clear steps, materials, timing, and student instructions. Not a worksheet of questions — an actual activity (game, station rotation, partner task, simulation, sorting exercise, etc.) that fits the lesson topic.`
      : `Build an ASSIGNMENT students will complete independently. This means specific tasks/questions/prompts with clear instructions.`;

    const verificationInstruction = needsFactCheck
      ? `CRITICAL RULES:
- Use PLAIN TEXT only. No markdown, no asterisks, no hashtags.
- Reference ONLY facts confirmed in the verification notes below. Do not state any specific factual claim (book plot details, historical facts, dates) that was not verified. If unsure, write generically rather than inventing specifics.
- Ground this specifically in the lesson content provided — do not write a generic activity that could apply to any topic. Reference the actual objectives, skills, or content from the lesson.
- Be concise but complete.`
      : needsMathCheck
      ? `CRITICAL RULES:
- Use PLAIN TEXT only. No markdown, no asterisks, no hashtags.
- The verification notes below contain pre-checked, verified problems with worked solutions. USE THESE EXACT PROBLEMS AND NUMBERS rather than inventing new ones — they have already been computed and double-checked. Do not introduce any new numeric example that was not part of the verification pass.
- Ground this specifically in the lesson content provided — do not write a generic activity that could apply to any topic. Reference the actual objectives, skills, or content from the lesson.
- Be concise but complete.`
      : `CRITICAL RULES:
- Use PLAIN TEXT only. No markdown, no asterisks, no hashtags.
- Ground this specifically in the lesson content provided — do not write a generic activity that could apply to any topic. Reference the actual objectives, skills, or content from the lesson.
- Be concise but complete.`;

    const genPrompt = `You are an expert teacher creating classroom materials. ${modeInstructions}

${verificationInstruction}

LESSON CONTEXT THE TEACHER PROVIDED:
${lessonContent || "None pasted — using manual fields below."}

MANUAL FIELDS:
Subject: ${subject || "Not specified"}
Grade: ${grade || "Not specified"}
Topic: ${topic}
Extra direction from teacher: ${extra || "None"}

VERIFICATION NOTES (${needsMathCheck ? "pre-checked worked problems — use these exact numbers" : "facts confirmed or flagged — only use confirmed facts, avoid unconfirmed specifics"}):
${verificationNotes}

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

    const genResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{ role: "user", content: genPrompt }],
      }),
    });
    const genData = await genResponse.json();

    if (genData.error) {
      return res.status(500).json({ error: { message: genData.error.message || "Generation failed." } });
    }

    const text = (genData.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return res.status(200).json({
      text,
      verificationRan: needsCheck,
      verificationType: needsFactCheck ? "facts" : needsMathCheck ? "math" : null,
      verificationNotes: needsCheck ? verificationNotes : null,
    });
  } catch (error) {
    return res.status(500).json({ error: { message: "Proxy error: " + error.message } });
  }
}
