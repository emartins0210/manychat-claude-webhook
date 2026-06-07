import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "300", 10);
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "20", 10);

if (!ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required"); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(__dirname, "..", "LARA_PROMPT.md"), "utf-8");
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = new Map();
const STALE_MS = 6 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [id, conv] of conversations) { if (now - conv.updatedAt > STALE_MS) conversations.delete(id); } }, 30 * 60 * 1000);

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok", model: MODEL, uptime: process.uptime() }));

app.post("/webhook", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const token = req.headers["x-webhook-secret"] || req.query.secret;
      if (token !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    }

    // Accept both custom format AND ManyChat Full Contact Data format
    const body = req.body;
    const subscriber_id = body.subscriber_id || body.id || body.key || "unknown";
    const user_message = body.user_message || body.last_input_text || "";
    const first_name = body.first_name || body.name || "";
    const last_name = body.last_name || "";
    const phone = body.phone || "";

    if (!user_message) return res.status(400).json({ error: "No message found" });

    let conv = conversations.get(String(subscriber_id));
    if (!conv) { conv = { messages: [], updatedAt: Date.now() }; conversations.set(String(subscriber_id), conv); }

    let messageContent = user_message;
    if (conv.messages.length === 0 && first_name) {
      messageContent = "[Lead: " + first_name + " " + last_name + (phone ? " | Tel: " + phone : "") + "]\n\n" + user_message;
    }

    conv.messages.push({ role: "user", content: messageContent });
    if (conv.messages.length > MAX_HISTORY) conv.messages = conv.messages.slice(-MAX_HISTORY);

    const response = await anthropic.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: conv.messages });
    const assistantMessage = response.content[0]?.text || "Desculpe, tive um problema. Pode repetir?";
    conv.messages.push({ role: "assistant", content: assistantMessage });
    conv.updatedAt = Date.now();

    console.log("[" + first_name + "] " + user_message.substring(0, 50) + " -> " + assistantMessage.substring(0, 50));

    res.json({ version: "v2", content: { messages: [{ type: "text", text: assistantMessage }] } });
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.json({ version: "v2", content: { messages: [{ type: "text", text: "Opa, estou com uma instabilidade. Pode mandar de novo em alguns segundos?" }] } });
  }
});

app.post("/reset", (req, res) => { const { subscriber_id } = req.body; if (subscriber_id) { conversations.delete(subscriber_id); return res.json({ status: "reset" }); } res.status(400).json({ error: "Missing subscriber_id" }); });
app.get("/stats", (req, res) => { if (WEBHOOK_SECRET) { const token = req.headers["x-webhook-secret"] || req.query.secret; if (token !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" }); } res.json({ active_conversations: conversations.size, uptime_seconds: Math.floor(process.uptime()), model: MODEL }); });
app.listen(PORT, () => console.log("LARA webhook running on port " + PORT));
