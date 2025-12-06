// index.js — require bot role + unique from.id to avoid echoing user messages
const { Telegraf } = require("telegraf");
const fetch = require("node-fetch"); // v2
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_ENDPOINT = process.env.TOKEN_ENDPOINT;
const DIRECTLINE_BASE = "https://directline.botframework.com/v3/directline";
const QUEUE_FILE = path.join(__dirname, "queued_messages.jsonl");

if (!TELEGRAM_BOT_TOKEN || !TOKEN_ENDPOINT) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TOKEN_ENDPOINT in .env");
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const sessions = {};

/* ---------- Direct Line helpers (token, conversation) ---------- */
async function ensureToken(sessionKey) {
    const now = Math.floor(Date.now() / 1000);
    const s = sessions[sessionKey] || {};
    if (s.token && s.expiresAt && now < s.expiresAt - 10) return s;

    const res = await fetch(TOKEN_ENDPOINT, { method: "GET" });
    if (!res.ok) throw new Error(`Token endpoint failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    if (!j.token) throw new Error("Token endpoint returned no token");

    s.token = j.token;
    s.expiresAt = now + (j.expires_in || 3600);
    s.conversationId = null;
    s.watermark = null;
    sessions[sessionKey] = s;
    return s;
}

async function ensureConversation(sessionKey, forceNew = false) {
    const s = await ensureToken(sessionKey);
    if (s.conversationId && !forceNew) return s;

    const res = await fetch(`${DIRECTLINE_BASE}/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.token}` },
    });
    if (!res.ok) throw new Error(`Create conversation failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    s.conversationId = data.conversationId;
    s.watermark = null;
    sessions[sessionKey] = s;
    return s;
}

/* ---------- Post activity: use unique from.id to avoid collisions ---------- */
async function postActivity(s, uniqueFromId, text) {
    const postUrl = `${DIRECTLINE_BASE}/conversations/${s.conversationId}/activities`;
    const activity = { type: "message", from: { id: String(uniqueFromId) }, text };
    const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
        body: JSON.stringify(activity),
    });
    if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Post activity failed: ${res.status} ${body}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return await res.json();
}

/* ---------- Get activities (updates watermark) ---------- */
async function getActivities(s) {
    const base = `${DIRECTLINE_BASE}/conversations/${s.conversationId}/activities`;
    const url = s.watermark ? `${base}?watermark=${s.watermark}` : base;
    const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${s.token}` } });
    if (!res.ok) throw new Error(`Get activities failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    if (j.watermark) s.watermark = j.watermark;
    return j;
}

/* ---------- Extract reply safely ---------- */
function extractReplyFromActivity(act) {
    if (!act) return null;
    if (act.text) return act.text;
    if (act.speak) return act.speak;
    if (Array.isArray(act.attachments) && act.attachments.length > 0) {
        for (const a of act.attachments) {
            if (a.content) {
                const c = a.content;
                if (c.text) return c.text;
                if (c.title && c.text) return `${c.title}\n\n${c.text}`;
                if (c.title) return c.title;
            }
            if (a.text) return a.text;
        }
    }
    if (act.channelData) return JSON.stringify(act.channelData);
    return JSON.stringify(act);
}

/* ---------- Simple file queue helpers ---------- */
function enqueueMessage(entry) {
    const line = JSON.stringify(entry);
    fs.appendFileSync(QUEUE_FILE, line + "\n", { encoding: "utf8" });
}
function readQueueFile() {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const content = fs.readFileSync(QUEUE_FILE, "utf8").trim();
    if (!content) return [];
    return content.split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}
function overwriteQueue(lines) {
    const toWrite = lines.map(e => JSON.stringify(e)).join("\n") + (lines.length ? "\n" : "");
    fs.writeFileSync(QUEUE_FILE, toWrite, { encoding: "utf8" });
}

/* ---------- Queue background worker (same as before) ---------- */
let processing = false;
async function processQueueOnce() {
    if (processing) return;
    processing = true;
    try {
        let queued = readQueueFile();
        if (!queued.length) { processing = false; return; }
        const remaining = [];
        for (const item of queued) {
            const { chatId, userText } = item;
            const sessionKey = `tg_${chatId}`;
            try {
                const s = await ensureConversation(sessionKey);
                try { await postActivity(s, `tg_${chatId}_${Date.now()}`, userText); } catch (postErr) {
                    if (postErr.status === 404) { const s2 = await ensureConversation(sessionKey, true); await postActivity(s2, `tg_${chatId}_${Date.now()}`, userText); }
                    else throw postErr;
                }
                // poll briefly
                const start = Date.now(); let reply = null;
                while (Date.now() - start < 8000) {
                    const acts = await getActivities(s);
                    // accept only messages whose from.role === 'bot'
                    const botMsgs = (acts.activities || []).filter(a => a && a.type === "message" && a.from && a.from.role && a.from.role.toLowerCase() === "bot");
                    if (botMsgs.length > 0) { reply = extractReplyFromActivity(botMsgs[botMsgs.length - 1]); break; }
                    await new Promise(r => setTimeout(r, 600));
                }
                if (reply) {
                    await bot.telegram.sendMessage(chatId, reply).catch(e => console.warn("sendMessage failed:", e.message));
                } else { remaining.push(item); }
            } catch (err) {
                remaining.push(item);
            }
        }
        overwriteQueue(remaining);
    } catch (err) {
        console.error("Queue error:", err);
    } finally { processing = false; }
}
setInterval(processQueueOnce, 60 * 1000);
setTimeout(processQueueOnce, 5000);

/* ---------- Usage-limit detection ---------- */
function isUsageLimitReply(text) {
    if (!text) return false;
    const s = text.toLowerCase();
    const phrases = ["reached its usage limit", "usage limit", "agent is currently unavailable", "currently unavailable", "temporarily unavailable", "quota", "exceeded", "try again later", "out of capacity"];
    for (const p of phrases) if (s.includes(p)) return true;
    return false;
}

/* ---------- sendAndReceive: post with unique from id, accept only bot role replies ---------- */
async function sendAndReceive(sessionKey, userText, chatId, timeoutMs = 15000) {
    let s = await ensureConversation(sessionKey);
    const uniqueFromId = `tg_${chatId}_${Date.now()}`; // ensures we won't match our own post
    try {
        await postActivity(s, uniqueFromId, userText);
    } catch (err) {
        if (err.status === 404) {
            s = await ensureConversation(sessionKey, true);
            await postActivity(s, uniqueFromId, userText);
        } else {
            throw err;
        }
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const acts = await getActivities(s);
        const activities = acts.activities || [];
        // only consider replies where from.role === 'bot'
        const botMsgs = activities.filter(a => a && a.type === "message" && a.from && a.from.role && a.from.role.toLowerCase() === "bot");
        if (botMsgs.length > 0) {
            const last = botMsgs[botMsgs.length - 1];
            return extractReplyFromActivity(last);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

/* ---------- Telegram handler ---------- */
bot.on("text", async (ctx) => {
    const chatId = ctx.chat.id;
    const sessionKey = `tg_${chatId}`;
    const userText = ctx.message.text;

    try {
        ctx.sendChatAction("typing");
        const reply = await sendAndReceive(sessionKey, userText, chatId, 12000);

        if (reply) {
            if (isUsageLimitReply(reply)) {
                await ctx.reply("Sorry — the agent is temporarily unavailable due to usage limits. I've queued your message and will retry shortly.");
                enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
                return;
            }
            await ctx.reply(reply);
            return;
        }

        await ctx.reply("The agent didn't respond in time. I've queued your message and will retry shortly.");
        enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
    } catch (err) {
        console.error("Relay error:", err);
        await ctx.reply("Error contacting agent. Your message has been queued and will be retried.");
        enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
    }
});

bot.start((ctx) => ctx.reply("Hello — send a message to test the agent."));

(async () => {
    console.log("Starting Telegram bot...");
    await bot.launch();
    console.log("Telegram bot launched.");
})();
