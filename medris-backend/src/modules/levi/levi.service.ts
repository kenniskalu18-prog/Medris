import { requireEnv } from "../../config/env.js";
import { getDataContext } from "../../database/index.js";
import { LeviRepository } from "../../database/repositories/levi.repository.js";
import { identityFromAccessToken } from "../auth/caller.js";
import { GEMINI_MODEL, callGemini, transcribeWav, type GeminiContent, type GeminiPart } from "../../integrations/gemini.js";
import type { ServiceResult } from "../../shared/types/service.js";
import { TOOL_DECLARATIONS } from "./levi.declarations.js";
import { leviSystemPrompt } from "./levi.prompt.js";
import { appendClientDirectives, cleanText, jsonSafe, stripOldUiDirectives, stripUnsafeTechnicalFallback } from "./levi.text.js";
import { executeTool, getMyVendor, type LeviContext } from "./levi.tools.js";

/**
 * Levi, the in-app assistant (ported from api/chat.js). The browser sends the
 * signed-in user's access token; this server verifies it and lets Gemini use
 * a fixed set of tools that each authorise themselves. Gemini never gets
 * arbitrary SQL or a key.
 */

const DAILY_MESSAGE_LIMIT = 200;
const MAX_TOOL_ROUNDS = 5;
const TOOLS = [{ functionDeclarations: TOOL_DECLARATIONS }];

export interface LeviRequest {
  messages?: { role?: string; content?: string }[];
  accessToken?: string;
  lat?: unknown;
  lng?: unknown;
  currentView?: string;
  currentViewParams?: unknown;
  lastRenderError?: string;
  mode?: string;
  audio?: unknown;
}

/** POST /api/chat: `mode: "transcribe"` turns audio into text; anything else is a chat turn. */
export function handleLeviRequest(body: LeviRequest): Promise<ServiceResult> {
  return body?.mode === "transcribe" ? transcribe(body) : chat(body);
}

/** Speech-to-text for the Android mic buttons (short WAV clips). */
export async function transcribe(body: LeviRequest): Promise<ServiceResult> {
  const { accessToken, audio } = body || {};
  if (!accessToken) return { status: 401, body: { error: "Please log in." } };
  if (typeof audio !== "string" || !audio || audio.length > 3_000_000) return { status: 400, body: { error: "audio required" } };
  const geminiKey = requireEnv("GEMINI_API_KEY");
  const me = await identityFromAccessToken(accessToken).catch(() => null);
  if (!me) return { status: 401, body: { error: "Session expired." } };
  const text = await transcribeWav(geminiKey, audio);
  return text === null ? { status: 502, body: { error: "Couldn't transcribe that." } } : { status: 200, body: { text } };
}

export async function chat(body: LeviRequest): Promise<ServiceResult> {
  const { messages, accessToken, lat, lng, currentView, currentViewParams, lastRenderError, mode } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) return { status: 400, body: { error: "messages array required" } };
  if (!accessToken) return { status: 401, body: { error: "Please log in to use Levi." } };

  const geminiKey = requireEnv("GEMINI_API_KEY");

  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 401, body: { error: "Your session expired. Please log in again." } };
  const data = getDataContext();

  if (mode !== "message_suggestions") {
    // Counted for the verified caller only (their own id), with elevated rights as the function had.
    let withinLimit: unknown;
    try {
      withinLimit = await data.onBehalfOf(me, (tx) => new LeviRepository(tx).incrementChatUsage(me.userId, DAILY_MESSAGE_LIMIT));
    } catch {
      return { status: 500, body: { error: "Levi could not check chat usage." } };
    }
    if (withinLimit !== true) return { status: 429, body: { error: `You've hit today's Levi message limit (${DAILY_MESSAGE_LIMIT}).` } };
  }

  const latest = [...messages].reverse().find((m) => m?.role === "user")?.content || "";
  const ctx: LeviContext = {
    data,
    identity: me,
    userId: me.userId,
    lat: typeof lat === "number" ? lat : null,
    lng: typeof lng === "number" ? lng : null,
  };

  // Compose suggestions: same live data, never sends a message or performs an action.
  if (mode === "message_suggestions") {
    const prompt = `Return exactly 3 short reply suggestions for the user's current vendor/buyer conversation. Each suggestion must be 3-14 words, natural Nigerian English, and directly useful. Do not number them and do not add quotes. Last incoming message: ${cleanText(latest, 500)}`;
    const suggestionRes = await callGemini(geminiKey, GEMINI_MODEL, [{ role: "user", parts: [{ text: prompt }] }], leviSystemPrompt());
    const text = extractText(suggestionRes?.candidates?.[0]?.content) || "";
    const suggestions = text
      .split(/\n+/)
      .map((x) => x.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    return { status: 200, body: { suggestions } };
  }

  const vendor = await getMyVendor(ctx).catch(() => null);
  const userContext = [
    `CURRENT SCREEN: ${cleanText(currentView || "unknown", 100)}${currentViewParams ? ` ${cleanText(JSON.stringify(currentViewParams), 250)}` : ""}`,
    ctx.lat != null && ctx.lng != null
      ? `BUYER LOCATION IS AVAILABLE TO LEVI: ${ctx.lat}, ${ctx.lng}. Use it only for distance calculations.`
      : "BUYER LOCATION IS NOT AVAILABLE. Never invent distances.",
    vendor
      ? `SIGNED-IN USER IS ALSO A VERIFIED/REGISTERED VENDOR: ${vendor.business_name || "their shop"} (vendor id ${vendor.id}). Private vendor analytics can be fetched with get_my_vendor_analytics.`
      : "SIGNED-IN USER IS NOT A VENDOR (or no vendor record was found).",
    "IMPORTANT: Treat the current conversation messages and the latest user request as authoritative. Do not let an older conversation, previous search result, previous product, previous vendor, or prior navigation destination override the user's current request. Only use an older detail when the user explicitly refers back to it (for example, 'the one you showed me earlier').",
    lastRenderError ? `LAST RENDER ERROR (only if the user asks why the current screen failed): ${cleanText(lastRenderError, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const recentConversation: GeminiContent[] = messages
    .slice(-16)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: stripOldUiDirectives(String(m.content || "")).slice(0, 5000) }] }))
    .filter((m) => m.parts[0]?.text);
  let currentContents: GeminiContent[] = [
    { role: "user", parts: [{ text: `LEVROMART SESSION CONTEXT:\n${userContext}` }] },
    ...recentConversation,
    { role: "user", parts: [{ text: `CURRENT USER REQUEST — THIS TURN IS AUTHORITATIVE:\n${stripOldUiDirectives(latest).slice(0, 5000)}` }] },
  ];

  let finalText = "";
  const toolResults: unknown[] = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const apiRes = await callGemini(geminiKey, GEMINI_MODEL, currentContents, leviSystemPrompt(), TOOLS);
    const candidate = apiRes?.candidates?.[0];
    const calls = (candidate?.content?.parts || []).map((part) => part?.functionCall).filter((call): call is NonNullable<GeminiPart["functionCall"]> => !!call);
    if (!calls.length) {
      finalText = extractText(candidate?.content);
      break;
    }
    // Keep the model's full content (thought/function-call metadata), then answer every call in one batch.
    currentContents = [...currentContents, candidate?.content as GeminiContent];
    const roundResults = await Promise.all(
      calls.map(async (call) => {
        let args: Record<string, unknown> = {};
        try {
          args = (typeof call.args === "string" ? JSON.parse(call.args) : call.args || {}) as Record<string, unknown>;
        } catch {
          /* keep empty args */
        }
        try {
          const result = await executeTool(call.name, args, ctx);
          return { call, result: jsonSafe(result) || { ok: false, message: "No result." } };
        } catch {
          return { call, result: { ok: false, message: "That lookup did not return a usable result." } };
        }
      }),
    );
    toolResults.push(...roundResults.map((r) => r.result));
    currentContents.push({
      role: "user",
      parts: roundResults.map((row) => ({ functionResponse: { name: row.call.name, response: { result: row.result }, id: row.call.id } })),
    });
  }

  if (!finalText) finalText = "I checked the live Levromart data. Tell me the product, vendor, sector, order or action you want and I’ll take the next step.";
  finalText = stripUnsafeTechnicalFallback(finalText);
  finalText = appendClientDirectives(finalText, toolResults);
  if (!finalText) finalText = "Tell me what you want to find or do on Levromart and I’ll handle it.";
  return { status: 200, body: { reply: finalText } };
}

function extractText(content: GeminiContent | undefined): string {
  return (content?.parts || [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}
