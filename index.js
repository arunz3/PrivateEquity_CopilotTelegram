// index.js — Webhook-ready Telegram -> Direct Line bridge with queue & sign-in handling
const express = require('express');
const { Telegraf } = require('telegraf');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TOKEN_ENDPOINT = process.env.TOKEN_ENDPOINT;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // set in Railway to https://<your-app>.up.railway.app
const PORT = process.env.PORT || 3000;
const DIRECTLINE_BASE = 'https://directline.botframework.com/v3/directline';
const QUEUE_FILE = path.join(__dirname, 'queued_messages.jsonl');

if (!TELEGRAM_BOT_TOKEN || !TOKEN_ENDPOINT || !WEBHOOK_URL) {
    console.error('Missing TELEGRAM_BOT_TOKEN, TOKEN_ENDPOINT or WEBHOOK_URL in env');
    process.exit(1);
}

/* ---------- Express + Telegraf setup ---------- */
const app = express();
app.use(express.json());

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/* ---------- In-memory sessions and helpers ---------- */
const sessions = {}; // sessionKey -> { token, expiresAt, conversationId, watermark }

/* --- Direct Line token (from your TOKEN_ENDPOINT) --- */
async function ensureToken(sessionKey) {
    const now = Math.floor(Date.now() / 1000);
    const s = sessions[sessionKey] || {};
    if (s.token && s.expiresAt && now < s.expiresAt - 10) return s;

    console.log('[DL] Fetching token from token endpoint...');
    const res = await fetch(TOKEN_ENDPOINT, { method: 'GET' });
    if (!res.ok) throw new Error(`Token endpoint failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    if (!j.token) throw new Error('Token endpoint returned no token');

    s.token = j.token;
    s.expiresAt = now + (j.expires_in || 3600);
    s.conversationId = null; // we'll create one on directline
    s.watermark = null;
    sessions[sessionKey] = s;
    return s;
}

/* --- Create Direct Line conversation on standard host --- */
async function ensureConversation(sessionKey, forceNew = false) {
    const s = await ensureToken(sessionKey);
    if (s.conversationId && !forceNew) return s;

    console.log('[DL] Creating conversation...');
    const res = await fetch(`${DIRECTLINE_BASE}/conversations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}` },
    });
    if (!res.ok) throw new Error(`Create conversation failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    s.conversationId = data.conversationId;
    s.watermark = null;
    sessions[sessionKey] = s;
    console.log('[DL] conversationId=', s.conversationId);
    return s;
}

/* --- Post activity with a unique from id --- */
async function postActivity(s, uniqueFromId, text) {
    const postUrl = `${DIRECTLINE_BASE}/conversations/${s.conversationId}/activities`;
    const activity = { type: 'message', from: { id: String(uniqueFromId) }, text };
    const res = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
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

/* --- Get activities and update watermark --- */
async function getActivities(s) {
    const base = `${DIRECTLINE_BASE}/conversations/${s.conversationId}/activities`;
    const url = s.watermark ? `${base}?watermark=${s.watermark}` : base;
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${s.token}` } });
    if (!res.ok) throw new Error(`Get activities failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    if (j.watermark) s.watermark = j.watermark;
    return j;
}

/* --- Extract text or card content from a bot activity --- */
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

/* --- Detect sign-in URL inside activity (if the agent asks to sign in) --- */
function extractSignInUrlFromActivity(act) {
    if (!act) return null;
    if (Array.isArray(act.attachments)) {
        for (const a of act.attachments) {
            const ct = (a.contentType || '').toLowerCase();
            if (ct.includes('oauth') || ct.includes('signin')) {
                if (a.content && a.content.actions && a.content.actions.length) {
                    const v = a.content.actions[0].value;
                    if (typeof v === 'string' && v.startsWith('http')) return v;
                    if (v && v.signinUrl) return v.signinUrl;
                    if (v && v.url) return v.url;
                }
            }
            if (a.content) {
                const json = JSON.stringify(a.content);
                const m = json.match(/https?:\/\/[^\s"']+/);
                if (m) return m[0];
            }
            if (a.text) {
                const m = String(a.text).match(/https?:\/\/[^\s]+/);
                if (m) return m[0];
            }
        }
    }
    if (act.text) {
        const m = act.text.match(/https?:\/\/[^\s]+/);
        if (m) return m[0];
    }
    if (act.channelData) {
        const cd = JSON.stringify(act.channelData);
        const m = cd.match(/https?:\/\/[^\s"']+/);
        if (m) return m[0];
    }
    return null;
}

/* --- Simple file-backed queue helpers (ok for dev/testing) --- */
function enqueueMessage(entry) {
    try {
        const line = JSON.stringify(entry);
        fs.appendFileSync(QUEUE_FILE, line + '\n', { encoding: 'utf8' });
        console.log('[QUEUE] enqueued', entry.chatId);
    } catch (e) {
        console.warn('[QUEUE] enqueue failed', e.message);
    }
}
function readQueueFile() {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const content = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
    if (!content) return [];
    return content.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function overwriteQueue(lines) {
    const txt = lines.map(e => JSON.stringify(e)).join('\n') + (lines.length ? '\n' : '');
    fs.writeFileSync(QUEUE_FILE, txt, { encoding: 'utf8' });
}

/* --- Worker: retry queued messages every minute --- */
let processing = false;
async function processQueueOnce() {
    if (processing) return;
    processing = true;
    try {
        const queued = readQueueFile();
        if (!queued.length) { processing = false; return; }
        console.log('[QUEUE] processing', queued.length);
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
                // poll briefly for reply
                const start = Date.now(); let reply = null;
                while (Date.now() - start < 8000) {
                    const acts = await getActivities(s);
                    const botMsgs = (acts.activities || []).filter(a => a && a.type === 'message' && a.from && a.from.role && a.from.role.toLowerCase() === 'bot');
                    if (botMsgs.length > 0) { reply = extractReplyFromActivity(botMsgs[botMsgs.length - 1]); break; }
                    await new Promise(r => setTimeout(r, 600));
                }
                if (reply) {
                    await bot.telegram.sendMessage(chatId, reply).catch(e => console.warn('[QUEUE] sendMessage failed', e.message));
                    console.log('[QUEUE] delivered to', chatId);
                } else { remaining.push(item); }
            } catch (err) {
                console.warn('[QUEUE] item error for', chatId, err.message);
                remaining.push(item);
            }
        }
        overwriteQueue(remaining);
        console.log('[QUEUE] finished; remaining', remaining.length);
    } catch (err) {
        console.error('[QUEUE] unexpected', err);
    } finally { processing = false; }
}
setInterval(processQueueOnce, 60 * 1000);
setTimeout(processQueueOnce, 5 * 1000);

/* --- Helper: detect usage-limit style replies --- */
function isUsageLimitReply(text) {
    if (!text) return false;
    const s = text.toLowerCase();
    const phrases = ['reached its usage limit', 'usage limit', 'agent is currently unavailable', 'currently unavailable', 'quota', 'exceeded', 'temporarily unavailable', 'try again later', 'out of capacity'];
    return phrases.some(p => s.includes(p)) || (s.includes('usage') && (s.includes('limit') || s.includes('quota') || s.includes('exceed')));
}

/* --- sendAndReceive: post user message and wait for bot role reply --- */
async function sendAndReceive(sessionKey, userText, chatId, timeoutMs = 15000) {
    let s = await ensureConversation(sessionKey);
    const uniqueFromId = `tg_${chatId}_${Date.now()}`;
    try {
        await postActivity(s, uniqueFromId, userText);
    } catch (err) {
        if (err.status === 404) {
            s = await ensureConversation(sessionKey, true);
            await postActivity(s, uniqueFromId, userText);
        } else throw err;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const acts = await getActivities(s);
        const botMsgs = (acts.activities || []).filter(a => a && a.type === 'message' && a.from && a.from.role && a.from.role.toLowerCase() === 'bot');
        if (botMsgs.length > 0) {
            const last = botMsgs[botMsgs.length - 1];
            // if bot asks for signin and provides a signin link, return that specially
            const signInUrl = extractSignInUrlFromActivity(last);
            if (signInUrl) return { type: 'signin', url: signInUrl };
            const reply = extractReplyFromActivity(last);
            return { type: 'reply', text: reply };
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

/* ---------- Telegram webhook handler (uses sendAndReceive) ---------- */
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const sessionKey = `tg_${chatId}`;
    const userText = ctx.message.text;

    try {
        ctx.sendChatAction('typing');
        const res = await sendAndReceive(sessionKey, userText, chatId, 15000);

        if (!res) {
            await ctx.reply("Agent didn't respond in time — I've queued your message and will retry.");
            enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
            return;
        }

        if (res.type === 'signin') {
            // forward sign-in URL to user
            await ctx.reply('To continue, please sign in here:');
            await ctx.reply(res.url);
            // optionally queue the original message so worker will retry after sign-in
            enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
            return;
        }

        if (res.type === 'reply') {
            const reply = res.text;
            if (isUsageLimitReply(reply)) {
                await ctx.reply("Sorry — the agent is temporarily unavailable due to usage limits. I've queued your message and will retry.");
                enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
                return;
            }
            await ctx.reply(reply);
            return;
        }

        // fallback
        await ctx.reply("Unexpected response from agent; I've queued your message for retry.");
        enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
    } catch (err) {
        console.error('Relay error:', err);
        await ctx.reply('Error contacting agent. Your message has been queued and will be retried.');
        enqueueMessage({ chatId, userText, queuedAtIso: new Date().toISOString() });
    }
});

/* Attach Telegraf webhook callback to Express */
app.use(bot.webhookCallback('/webhook'));

/* simple health endpoint */
app.get('/', (req, res) => res.send('OK'));

/* start server and register webhook with Telegram */
app.listen(PORT, async () => {
    console.log(`Server listening on ${PORT}`);
    // set webhook
    const webhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}/webhook`;
    console.log('Setting Telegram webhook to', webhookUrl);
    try {
        const setRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl })
        });
        const j = await setRes.json();
        console.log('setWebhook response:', j);
    } catch (e) {
        console.error('setWebhook failed', e);
    }
});
