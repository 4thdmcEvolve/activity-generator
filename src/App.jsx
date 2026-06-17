import { useState } from "react";

const NAVY = "#1B3A6B";
const GOLD = "#C9A84C";
const DARK = "#0d1b2a";

const GRADES = ["K", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th", "College"];
const SUBJECTS = ["English / ELA", "Math", "Science", "Social Studies", "Business", "History", "Art", "PE / Health", "Foreign Language", "Special Education", "Other"];

const inp = (extra = {}) => ({
  width: "100%",
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  color: "#fff",
  padding: "12px 14px",
  fontSize: 15,
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
  WebkitAppearance: "none",
  ...extra,
});

const Label = ({ text, required }) => (
  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", marginBottom: 7 }}>
    {text} {required && <span style={{ color: GOLD }}>*</span>}
  </div>
);

const renderResult = (text) =>
  text.split("\n").map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} style={{ height: 8 }} />;
    if (/^[A-Z][A-Z\s/]{3,}$/.test(t) && t.length < 40) {
      return (
        <div key={i} style={{ fontWeight: 900, fontSize: 15, color: NAVY, borderLeft: `4px solid ${GOLD}`, paddingLeft: 12, margin: "18px 0 8px" }}>
          {t}
        </div>
      );
    }
    if (/^\d+\.\s/.test(t)) {
      return (
        <div key={i} style={{ fontWeight: 700, fontSize: 14, color: "#222", margin: "6px 0" }}>
          {t}
        </div>
      );
    }
    if (t.startsWith("-") || t.startsWith("•")) {
      return (
        <div key={i} style={{ display: "flex", gap: 9, margin: "4px 0 4px 10px", fontSize: 14, color: "#333", lineHeight: 1.6 }}>
          <span style={{ color: GOLD, fontWeight: 900, flexShrink: 0 }}>•</span>
          <span>{t.replace(/^[-•]\s*/, "")}</span>
        </div>
      );
    }
    return <div key={i} style={{ fontSize: 14, color: "#444", lineHeight: 1.7, margin: "3px 0" }}>{t}</div>;
  });

export default function App() {
  const [subject, setSubject] = useState("");
  const [grade, setGrade] = useState("");
  const [topic, setTopic] = useState("");
  const [extra, setExtra] = useState("");
  const [lessonContent, setLessonContent] = useState("");
  const [parsedNote, setParsedNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [verificationRan, setVerificationRan] = useState(false);
  const [verificationNotes, setVerificationNotes] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const [unlocked, setUnlocked] = useState(
    typeof window !== "undefined" && localStorage.getItem("toolkit_unlocked") === "yes"
  );
  const [pwInput, setPwInput] = useState("");
  const [authChecking, setAuthChecking] = useState(false);
  const [authError, setAuthError] = useState("");

  const tryUnlock = async () => {
    if (!pwInput.trim() || authChecking) return;
    setAuthChecking(true);
    setAuthError("");
    try {
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput.trim() }),
      });
      if (r.ok) {
        localStorage.setItem("toolkit_password", pwInput.trim());
        localStorage.setItem("toolkit_unlocked", "yes");
        setUnlocked(true);
      } else {
        setAuthError("Incorrect password. Try again.");
      }
    } catch (err) {
      setAuthError("Connection error. Try again.");
    } finally {
      setAuthChecking(false);
    }
  };

  const tryParse = (text) => {
    setLessonContent(text);
    if (!text.trim()) { setParsedNote(""); return; }

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleLine = lines[0] || "";
    const secondLine = lines[1] || "";

    let foundGrade = "", foundSubject = "", foundTopic = "";

    const gradeMatch = secondLine.match(/grade\s*(\d+|k)/i) || text.match(/grade\s*(\d+|k)/i);
    if (gradeMatch) foundGrade = gradeMatch[0];

    const subjectMatch = secondLine.match(/\b(ELA|Math|Science|Social Studies|History|Business|Art|PE|Health)\b/i);
    if (subjectMatch) foundSubject = subjectMatch[0];

    if (titleLine) {
      foundTopic = titleLine.replace(/lesson plan/i, "").trim().split("|")[0].trim();
    }

    if (foundGrade) setGrade(foundGrade);
    if (foundSubject) setSubject(foundSubject);
    if (foundTopic) setTopic(foundTopic);

    if (foundGrade || foundSubject || foundTopic) {
      setParsedNote(
        "Parsed from paste: " +
        (foundTopic ? `Topic: ${foundTopic}. ` : "") +
        (foundGrade ? `Grade: ${foundGrade}. ` : "") +
        (foundSubject ? `Subject: ${foundSubject}.` : "") +
        " Review and correct below if needed."
      );
    } else {
      setParsedNote("Could not auto-detect details. Please fill in Subject, Grade, and Topic manually below.");
    }
  };

  const generate = async () => {
    if (!topic.trim()) { setError("Please provide at least a topic."); return; }
    setError(""); setResult(""); setLoading(true);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "activity",
          lessonContent,
          subject,
          grade,
          topic,
          extra,
          toolkitPassword: localStorage.getItem("toolkit_password") || "",
        }),
      });
      const json = await res.json();
      if (json.error) {
        if (json.error.code === "AUTH_REQUIRED") {
          localStorage.removeItem("toolkit_unlocked");
          localStorage.removeItem("toolkit_password");
          setUnlocked(false);
          setError("That password is no longer valid. Please re-enter.");
          return;
        }
        setError("Error: " + json.error.message);
        return;
      }
      if (!json.text) { setError("Nothing returned. Please try again."); return; }
      setResult(json.text);
      setVerificationRan(json.verificationRan);
      setVerificationNotes(json.verificationNotes || "");
    } catch (e) {
      setError("Request failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setResult("");
    setError("");
    setVerificationRan(false);
    setVerificationNotes("");
  };

  if (!unlocked) {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: `linear-gradient(160deg, ${DARK} 0%, ${NAVY} 100%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Segoe UI', system-ui, sans-serif", padding: 20,
      }}>
        <div style={{
          maxWidth: 380, width: "100%", textAlign: "center",
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(201,168,76,0.25)",
          borderRadius: 12, padding: "40px 32px",
        }}>
          <div style={{
            display: "inline-block", border: `1px solid ${GOLD}`, color: GOLD,
            fontSize: 10, letterSpacing: 4, padding: "4px 14px", marginBottom: 20,
            fontWeight: 700, borderRadius: 2, textTransform: "uppercase",
            fontFamily: "monospace",
          }}>4THDMC | EVOLVE LLC</div>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 900, color: "#fff", marginBottom: 10 }}>
            Activity Generator
          </div>
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, marginBottom: 28, lineHeight: 1.5 }}>
            Enter your access password to continue.
          </div>
          <input
            type="password"
            value={pwInput}
            disabled={authChecking}
            onChange={(e) => { setPwInput(e.target.value); setAuthError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }}
            placeholder="Access password"
            style={{
              width: "100%", boxSizing: "border-box", padding: "13px 16px",
              background: "rgba(255,255,255,0.07)",
              border: `1px solid ${authError ? "rgba(255,80,80,0.5)" : "rgba(255,255,255,0.2)"}`,
              borderRadius: 8, color: "#fff", fontSize: 15, outline: "none",
              marginBottom: authError ? 8 : 16, opacity: authChecking ? 0.6 : 1,
            }}
          />
          {authError && (
            <div style={{ color: "#ff9090", fontSize: 12, marginBottom: 16, textAlign: "left" }}>
              ⚠ {authError}
            </div>
          )}
          <button
            disabled={authChecking || !pwInput.trim()}
            onClick={tryUnlock}
            style={{
              width: "100%", padding: 14,
              background: authChecking ? "rgba(201,168,76,0.5)" : GOLD,
              color: DARK, border: "none", borderRadius: 8, fontWeight: 900,
              fontSize: 14, letterSpacing: 2,
              cursor: authChecking ? "wait" : "pointer", textTransform: "uppercase",
            }}
          >{authChecking ? "Checking..." : "Unlock Tool"}</button>
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, marginTop: 20, lineHeight: 1.5 }}>
            Not a subscriber yet? Visit brrteaching.com to join.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${DARK} 0%, ${NAVY} 100%)`, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "0 0 80px" }}>

      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 900, fontSize: 16, color: "#fff", letterSpacing: 1 }}>
          4THDMC <span style={{ color: GOLD }}>|</span> EVOLVE LLC
        </div>
        <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, letterSpacing: 2, textTransform: "uppercase" }}>Teacher Toolkit</div>
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "32px 18px" }}>

        {!result && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "inline-block", border: `1px solid ${GOLD}`, color: GOLD, fontSize: 10, letterSpacing: 4, padding: "4px 14px", marginBottom: 12, fontWeight: 700, borderRadius: 2, textTransform: "uppercase" }}>
              4THDMC | EVOLVE LLC
            </div>
            <div style={{ fontSize: "clamp(28px, 7vw, 44px)", fontWeight: 900, color: "#fff", lineHeight: 1.1 }}>
              ACTIVITY<br /><span style={{ color: GOLD }}>GENERATOR</span>
            </div>
            <div style={{ width: 40, height: 3, background: GOLD, margin: "12px 0 8px" }} />
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, fontStyle: "italic" }}>
              Real classroom activities, grounded in your actual lesson. No slop.
            </div>
          </div>
        )}

        {!result && (
          <>
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: "22px 18px", marginBottom: 16 }}>
              <div style={{ color: GOLD, fontWeight: 700, fontSize: 11, letterSpacing: 3, textTransform: "uppercase", marginBottom: 6 }}>✦ Paste Your Lesson (Optional)</div>
              <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, marginBottom: 14 }}>Paste from Lesson Plan Generator so the activity is grounded in your real objectives</div>
              <textarea
                value={lessonContent}
                onChange={(e) => tryParse(e.target.value)}
                placeholder="Paste your lesson plan output here..."
                rows={6}
                style={{ ...inp(), resize: "vertical", lineHeight: 1.5 }}
              />
              {parsedNote && (
                <div style={{ background: "rgba(90,180,232,0.08)", border: "1px solid rgba(90,180,232,0.3)", color: "#5ab4e8", borderRadius: 8, padding: "10px 12px", fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                  {parsedNote}
                </div>
              )}
            </div>

            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: "22px 18px", marginBottom: 16 }}>
              <div style={{ color: GOLD, fontWeight: 700, fontSize: 11, letterSpacing: 3, textTransform: "uppercase", marginBottom: 18 }}>✦ Activity Details</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <div>
                  <Label text="Subject" />
                  <select value={subject} onChange={(e) => setSubject(e.target.value)} style={inp({ background: "#162d52", color: subject ? "#fff" : "rgba(255,255,255,0.35)" })}>
                    <option value="">Select...</option>
                    {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <Label text="Grade Level" />
                  <select value={grade} onChange={(e) => setGrade(e.target.value)} style={inp({ background: "#162d52", color: grade ? "#fff" : "rgba(255,255,255,0.35)" })}>
                    <option value="">Select...</option>
                    {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <Label text="Topic" required />
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Thesis Statements" style={inp()} />
              </div>

              <div>
                <Label text="Extra Direction (optional)" />
                <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. 15 minutes, no group work, needs to be quiet" style={inp()} />
              </div>
            </div>

            {error && (
              <div style={{ background: "rgba(255,80,80,0.12)", border: "1px solid rgba(255,80,80,0.3)", color: "#ff9090", padding: "12px 16px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{error}</div>
            )}

            <button onClick={generate} disabled={loading} style={{
              width: "100%", padding: 18, background: loading ? "rgba(201,168,76,0.4)" : GOLD,
              color: DARK, border: "none", borderRadius: 12, fontWeight: 900,
              fontSize: 16, letterSpacing: 3, cursor: loading ? "not-allowed" : "pointer",
              textTransform: "uppercase", boxShadow: loading ? "none" : "0 4px 24px rgba(201,168,76,0.3)",
            }}>
              {loading ? "⏳  Building Your Activity..." : "GENERATE ACTIVITY"}
            </button>
          </>
        )}

        {result && (
          <div>
            <div style={{ background: "#fff", borderRadius: 16, padding: "26px 20px", boxShadow: "0 20px 60px rgba(0,0,0,0.5)", marginBottom: 16 }}>
              <div style={{ marginBottom: 18, paddingBottom: 14, borderBottom: `2px solid ${GOLD}` }}>
                <div style={{ display: "inline-block", background: "rgba(201,168,76,0.12)", border: `1px solid ${GOLD}`, color: GOLD, fontSize: 10, fontWeight: 700, letterSpacing: 2, padding: "4px 10px", borderRadius: 20, marginBottom: 8, textTransform: "uppercase" }}>✓ Ready to Use</div>
                <div style={{ color: "#999", fontSize: 12 }}>{subject || "General"} · {grade || ""} · {topic}</div>
              </div>
              <div>{renderResult(result)}</div>
            </div>

            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "14px 16px", marginBottom: 16, fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.6 }}>
              {verificationRan
                ? <><strong style={{ color: GOLD }}>Fact-check pass run:</strong> {verificationNotes}</>
                : <span>No fact-check needed — this activity was skills-based with no specific factual claims detected.</span>}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button onClick={copy} style={{ padding: 16, background: copied ? "#2a9d5c" : NAVY, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 }}>
                {copied ? "✓ Copied!" : "📋 Copy Activity"}
              </button>
              <button onClick={reset} style={{ padding: 16, background: "transparent", color: "rgba(255,255,255,0.5)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", textTransform: "uppercase" }}>
                ← New Activity
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", color: "rgba(255,255,255,0.18)", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", marginTop: 20, padding: "0 16px 24px" }}>
        <div>© 2026 <span style={{ color: "rgba(201,168,76,0.55)" }}>4THDMC | EVOLVE LLC</span> · All Rights Reserved</div>
        <div style={{ marginTop: 6, fontSize: 9, letterSpacing: 2, color: "rgba(255,255,255,0.12)" }}>Brandon Russell · The Multiplier · Chattanooga, TN</div>
      </div>
    </div>
  );
}
