// POST { messages: [{role, content}, ...] } -> { reply }
// Proxies to the Claude API so the API key never touches the browser —
// same reasoning as the Paystack secret key. Needs ANTHROPIC_API_KEY set
// in Vercel's environment variables.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { messages } = JSON.parse(await readBody(req));
    if (!Array.isArray(messages) || messages.length === 0) { res.status(400).json({ error: "messages array required" }); return; }

    const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
    const trimmed = messages.slice(-20).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    }));

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 600,
        system:
          "You are Medris Assistant, a friendly helper embedded in a medical equipment rental/sale marketplace for Lagos, Nigeria. Help buyers figure out what equipment they need, explain how renting/buying/requesting works on Medris, and point them to the right action (Browse, Request Equipment, a specific category). Keep answers short (2-4 sentences) and practical, in plain conversational English. You cannot see the user's account, orders, or private data — if asked about a specific order, tell them to check 'My Orders'. You are not a medical professional — for clinical/diagnostic questions, tell them to consult a licensed healthcare provider.",
        messages: trimmed,
      }),
    });
    const apiJson = await apiRes.json();
    if (!apiRes.ok) { res.status(400).json({ error: apiJson.error?.message || "AI service error" }); return; }

    const reply = apiJson.content?.[0]?.text || "Sorry, I couldn't come up with a reply just now.";
    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
