// Model "thinking depth" tiers — mirrors backend/core/pricing.py.
// Keep the two in sync when you add or reprice a model.

export const TIER_META = {
  deep:     { label: "Deep-thinking", color: "#e05a5a", bg: "rgba(224,90,90,.14)",
              note: "heavy model — high token cost" },
  standard: { label: "Standard",      color: "#e0a33e", bg: "rgba(224,163,62,.14)",
              note: "mid model — moderate cost" },
  light:    { label: "Light / free",  color: "#3aa981", bg: "rgba(58,169,129,.14)",
              note: "cheap or free model" },
};

// short display name for a model id, e.g. "claude-haiku-4-5-20251001" -> "Haiku"
export function shortModel(model = "") {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("gemini") || m.includes("flash")) return "Gemini Flash";
  if (m.includes("gpt")) return "GPT-5";
  return model || "—";
}

// model id -> tier. Tolerates dated suffixes like "-20251001".
export function tierOf(model = "") {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "deep";
  if (m.includes("sonnet") || m.includes("gpt5") || m.includes("gpt-5")) return "standard";
  if (m.includes("haiku") || m.includes("gemini") || m.includes("flash")) return "light";
  return "standard";
}
