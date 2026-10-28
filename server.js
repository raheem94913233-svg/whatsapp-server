import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import puppeteer from "puppeteer-core";
import { mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import baileysModule from "@whiskeysockets/baileys";

const baileys = baileysModule?.makeWASocket ? baileysModule : baileysModule?.default || baileysModule;
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
if (typeof makeWASocket !== "function") throw new TypeError("Baileys socket export could not be loaded");

const PORT = process.env.PORT || 3000;
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "change-me";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "https://ghiabi-default-rtdb.firebaseio.com").replace(/\/+$/, "");
const ROOT = FIREBASE_DB_URL + "/ghiabi";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
if (SERVICE_TOKEN === "change-me") { console.error("SERVICE_TOKEN must be configured"); process.exit(1); }

/* ---------------- shared notice builders (generated from the web app) ---------------- */
const noticeFacts = function $6(e,t,n){let r=e=>{let[t,n]=String(e||``).split(`:`).map(Number);return(t||0)*3600+(n||0)*60},i=e=>((Math.floor(e/1e3)+14400)%86400+86400)%86400,a=e=>{let t=Math.floor(e/3600),n=Math.floor(e%3600/60);return(t%12||12)+`:`+String(n).padStart(2,`0`)+` `+(t<12?`صباحًا`:`مساءً`)},o=r(n&&n.inLimit||`07:10`),s=r(n&&n.outTime||`13:40`),c=e||{},l=c.in?i(c.in):null,u=c.out?i(c.out):null,d=l!==null&&l>o?Math.ceil((l-o)/60):0,f=u!==null&&u<s?Math.ceil((s-u)/60):0,p=t?t.kind||`full`:``,m=p===`full`||p===`late`,h=p===`full`||p===`early`,g=t?`مستأذن`+(t.from||t.to?` (`+[t.from,t.to].filter(Boolean).join(` - `)+`)`:``)+(t.reason?` — `+t.reason:``):``,_=(d>0||l===null)&&!m,v=(f>0||u===null)&&!h;return{inClock:l===null?``:a(l),outClock:u===null?``:a(u),inLimitClock:a(o),outTimeClock:a(s),lateMin:d,earlyMin:f,missingIn:l===null,missingOut:u===null,excuseIn:m,excuseOut:h,leaveText:g,violation:_||v}};
const dayNameAr = function e8(e){return[`الأحد`,`الاثنين`,`الثلاثاء`,`الأربعاء`,`الخميس`,`الجمعة`,`السبت`][new Date(e+`T12:00:00Z`).getUTCDay()]||``};
const fillTemplate = function t8(e,t){let n=String(e||``);for(let e of[`name`,`date`,`day`,`empNo`,`spec`,`school`,`late`,`status`])n=n.split(`{`+e+`}`).join(String(t[e]||``));return n};
const factsLine = function n8(e){let t=[];return e.lateMin&&t.push(`تأخر `+e.lateMin+` دقيقة (بصم `+e.inClock+`)`+(e.excuseIn?` — مستأذن`:``)),e.missingIn&&t.push(`عدم إثبات بصمة الحضور`+(e.excuseIn?` — مستأذن`:``)),e.missingOut&&t.push(`عدم إثبات بصمة الانصراف`+(e.excuseOut?` — مستأذن`:``)),e.earlyMin&&t.push(`انصراف مبكر `+e.earlyMin+` دقيقة (بصم `+e.outClock+`)`+(e.excuseOut?` — مستأذن`:``)),t.length?t.join(`، `):`منضبط`};
const buildNoticeHtml = function r8(e){let t=e=>String(e??``).replace(/[&<>"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`})[e]||e),n=e.facts,r=n.lateMin?n.lateMin+` دقيقة — وقت البصمة `+n.inClock+`، والمفترض البصم قبل الساعة `+n.inLimitClock+(n.excuseIn?` (مستأذن)`:``):n.missingIn?`—`:`لا يوجد — بصمة الحضور `+n.inClock,i=n.missingIn?`لم تُسجَّل بصمة الحضور (المفترض قبل الساعة `+n.inLimitClock+`)`+(n.excuseIn?` — مستأذن`:``):`لا يوجد`,a=n.missingOut?`لم تُسجَّل بصمة الانصراف (المفترض بعد الساعة `+n.outTimeClock+`)`+(n.excuseOut?` — مستأذن`:``):n.earlyMin?`انصراف مبكر — بصمة الانصراف `+n.outClock+` قبل الموعد (`+n.outTimeClock+`) بـ `+n.earlyMin+` دقيقة`+(n.excuseOut?` — مستأذن`:``):`لا يوجد — بصمة الانصراف `+n.outClock,o=(e,n,r)=>`<tr><th>`+t(e)+`</th><td class="`+(r?`bad`:``)+`">`+t(n)+`</td></tr>`;return`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إفادة</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap"><style>@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:"IBM Plex Sans Arabic","Noto Naskh Arabic","KacstOne",Tahoma,sans-serif;color:#1a2433;margin:0;font-size:15px;line-height:1.9}.head{text-align:center;border-bottom:3px double #1f5f8b;padding-bottom:10px;margin-bottom:18px}.head img{height:110px;object-fit:contain}.head .s{font-weight:700;font-size:16px;margin-top:4px}h1{text-align:center;font-size:30px;margin:6px 0 18px;letter-spacing:2px;color:#1f5f8b}.who{font-size:17px;margin:0 0 4px}.who b{display:inline-block;min-width:110px}p.lead{margin:18px 0 10px;font-size:16px}table{width:100%;border-collapse:collapse;margin:6px 0 18px}th,td{border:1px solid #c9d3df;padding:10px 12px;text-align:right;vertical-align:top}th{width:34%;background:#eef3f8;font-weight:700}td.bad{color:#a61b1b;font-weight:600}.when{display:flex;gap:40px;font-size:16px;margin-top:6px}.sign{margin-top:46px;display:flex;justify-content:flex-end}.sign div{text-align:center;min-width:220px}.sign b{display:block;font-size:17px}.note{margin-top:30px;font-size:12px;color:#6b7785;text-align:center}</style></head><body><div class="head">`+(e.logo?`<img src="`+t(e.logo)+`" alt="">`:``)+(e.schoolName?`<div class="s">`+t(e.schoolName)+`</div>`:``)+`</div><h1>إفادة</h1><div class="who"><b>الأستاذ :</b> `+t(e.name)+` المحترم</div><div class="who"><b>رقم الموظف :</b> `+t(e.empNo||`—`)+`</div><div class="who"><b>المسمى الوظيفي :</b> `+t(e.spec||`—`)+`</div><p class="lead">نفيدكم بأنه أثناء المتابعة الإلكترونية من خلال مؤشر الانضباط المدرسي لوحظ:</p><table>`+o(`تأخركم`,r,n.lateMin>0&&!n.excuseIn)+o(`عدم إثبات بصمة الحضور`,i,n.missingIn&&!n.excuseIn)+o(`عدم إثبات بصمة الانصراف / الانصراف المبكر`,a,(n.missingOut||n.earlyMin>0)&&!n.excuseOut)+(n.leaveText?o(`الاستئذان`,n.leaveText,!1):``)+`</table><div class="when"><div><b>اليوم :</b> `+t(e.day)+`</div><div><b>التاريخ :</b> `+t(e.date)+`</div></div><div class="sign" dir="ltr"><div dir="rtl"><b>`+t(e.principalName||`ناصر غريب البلوشي`)+`</b>`+t(e.principalTitle||`مدير المدرسة`)+`</div></div><div class="note">موعد بصمة الحضور قبل `+t(n.inLimitClock)+` — موعد بصمة الانصراف بعد `+t(n.outTimeClock)+`</div></body></html>`};
const buildManagerSummary = function i8(e,t,n,r){let i=e.filter(e=>e.facts.lateMin>0),a=e.filter(e=>e.facts.missingIn),o=e.filter(e=>e.facts.missingOut),s=e.filter(e=>e.facts.earlyMin>0),c=e.filter(e=>e.facts.leaveText),l=(e,t)=>e.length?e.map((e,n)=>`  `+(n+1)+`. `+t(e)).join(`
`):`  لا يوجد`;return`📊 *إحصائية الانضباط اليومية*
`+n+` `+t+`
━━━━━━━━━━━━━━
⏰ *المتأخرون (`+i.length+`):*
`+l(i,e=>e.name+` — `+e.facts.lateMin+` دقيقة (`+e.facts.inClock+`)`+(e.facts.excuseIn?` مستأذن`:``))+`

🚫 *عدم إثبات الحضور (`+a.length+`):*
`+l(a,e=>e.name+(e.facts.excuseIn?` — مستأذن`:``))+`

🚪 *عدم إثبات الانصراف (`+o.length+`):*
`+l(o,e=>e.name+(e.facts.excuseOut?` — مستأذن`:``))+`

🏃 *انصراف مبكر (`+s.length+`):*
`+l(s,e=>e.name+` — `+e.facts.earlyMin+` دقيقة (`+e.facts.outClock+`)`+(e.facts.excuseOut?` مستأذن`:``))+`

📝 *المستأذنون (`+c.length+`):*
`+l(c,e=>e.name+` — `+e.facts.leaveText)+(r?`
━━━━━━━━━━━━━━
📨 أُرسلت الإفادات: `+(r.sent||0)+(r.failed?` · فشل: `+r.failed:``):``)};
const DEFAULT_NOTICE_TEMPLATE = "السلام عليكم ورحمة الله\nالأستاذ {name} المحترم\nمرفق لكم إفادة متابعة الانضباط المدرسي ليوم {day} {date}.\n{status}\n\nإدارة المدرسة";

/* ---------------- Firebase REST ---------------- */
async function fb(path, init, query = "") {
  const r = await fetch(ROOT + "/" + path + ".json" + query, { ...init, headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw new Error("firebase " + r.status);
  return r.json();
}
const fbPut = (p, v) => fb(p, { method: "PUT", body: JSON.stringify(v) });
const fbPost = (p, v) => fb(p, { method: "POST", body: JSON.stringify(v) });
const fbDel = (p) => fb(p, { method: "DELETE" });

/* ---------------- WhatsApp session kept in Firebase (survives Render restarts/redeploys without a disk) ---------------- */
const SESSION = "whatsapp/session/" + createHash("sha256").update(SERVICE_TOKEN).digest("hex").slice(0, 20);
const enc = (n) => Buffer.from(n).toString("base64url"), dec = (k) => Buffer.from(k, "base64url").toString();
async function restoreSession() {
  await mkdir(AUTH_DIR, { recursive: true });
  try {
    if ((await readdir(AUTH_DIR)).length) return;
    const saved = await fb(SESSION);
    if (saved && typeof saved === "object") for (const [k, v] of Object.entries(saved)) await writeFile(AUTH_DIR + "/" + dec(k), String(v));
    if (saved) console.log("session restored from Firebase");
  } catch (e) { console.error("restore session", e?.message || e); }
}
let backupTimer = null;
function backupSession() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      const out = {};
      for (const f of await readdir(AUTH_DIR)) out[enc(f)] = await readFile(AUTH_DIR + "/" + f, "utf8");
      await fbPut(SESSION, out);
    } catch (e) { console.error("backup session", e?.message || e); }
  }, 4000);
}

/* ---------------- WhatsApp (Baileys) ---------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));
let sock = null, connected = false, lastQr = "", starting = null, reconnectTimer = null, generation = 0, startupError = "";

async function stopSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = sock; sock = null;
  if (!current) return;
  try { current.ev.removeAllListeners(); } catch {}
  try { current.ws?.close(); } catch {}
  try { current.end?.(new Error("reinitialize")); } catch {}
}
async function start() {
  if (starting) return starting;
  const myGeneration = ++generation;
  startupError = "";
  starting = (async () => {
    await restoreSession();
    await stopSocket();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const s = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: "silent" }), browser: ["School Attendance", "Chrome", "1.0"], markOnlineOnConnect: false, syncFullHistory: false });
    sock = s;
    s.ev.on("creds.update", async () => { await saveCreds(); backupSession(); });
    s.ev.on("connection.update", async (u) => {
      if (myGeneration !== generation) return;
      const { connection, lastDisconnect, qr } = u;
      if (qr) { lastQr = await qrcode.toDataURL(qr); connected = false; }
      if (connection === "open") { backupSession(); connected = true; lastQr = ""; startupError = ""; console.log("WhatsApp connected"); }
      if (connection === "close") {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(() => start().catch(console.error), 5000);
      }
    });
  })();
  try { await starting; } catch (e) { startupError = e?.message || String(e); connected = false; throw e; } finally { starting = null; }
}
start().catch((e) => console.error("start failed", e));

const jidOf = (to) => String(to).replace(/\D/g, "") + "@s.whatsapp.net";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendText(to, message) {
  if (!sock || !connected) throw new Error("whatsapp not connected");
  await sock.sendMessage(jidOf(to), { text: String(message) });
}

/* ---------------- PDF ---------------- */
let browser = null;
async function htmlToPdf(html) {
  if (!browser || !browser.connected) browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"] });
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => page.setContent(html, { waitUntil: "load" }));
    await page.evaluate(() => document.fonts && document.fonts.ready);
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
  } finally { await page.close().catch(() => {}); }
}
async function sendPdf(to, message, html, fileName) {
  if (!sock || !connected) throw new Error("whatsapp not connected");
  const pdf = await htmlToPdf(html);
  if (message) await sock.sendMessage(jidOf(to), { text: String(message) });
  await sock.sendMessage(jidOf(to), { document: pdf, mimetype: "application/pdf", fileName: fileName || "إفادة.pdf" });
}

/* ---------------- helpers ---------------- */
const toEn = (s) => String(s || "").replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776));
function waNumber(phone, country = "+968") {
  const p = toEn(phone).replace(/[\s()-]/g, ""), c = toEn(country).replace(/^\+/, "");
  if (!p) return "";
  const full = p.startsWith("+") ? p.slice(1) : p.startsWith("00") ? p.slice(2) : (p.length > 8 && p.startsWith(c) ? p : c + p.replace(/^0/, ""));
  return /^[1-9]\d{6,14}$/.test(full) ? full : "";
}
const managerNumbers = (cfg) => String(cfg.managerNumber || "").split(/[,،\s]+/).map((n) => waNumber(n)).filter(Boolean);
function omanNow() {
  const d = new Date(Date.now() + 4 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
const toMin = (hm) => { const [h, m] = String(hm || "14:00").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
async function isActive(cfg) { const s = cfg?.servers?.[cfg?.activeServer]; return !!s && s.token === SERVICE_TOKEN; }
async function log(entry) { try { await fbPost("whatsapp/log", { ...entry, at: Date.now() }); } catch {} }

/* ---------------- daily notices ---------------- */
async function runDaily(date, opts = {}) {
  const cfg = (await fb("whatsapp/config")) || {};
  const [users, att, leaves, logo, settings] = await Promise.all([fb("users"), fb("staffAttendance/" + date), fb("leaves"), fb("whatsapp/logo"), fb("settings/schoolName")]);
  if (!att && !opts.force) return { skipped: "no-report", sent: 0, failed: 0 };
  const day = dayNameAr(date), rows = [], items = {};
  const leaveOf = {};
  for (const l of Object.values(leaves || {})) if (l && l.status === "approved" && l.date === date && l.uid) leaveOf[l.uid] = l;
  let sent = 0, failed = 0;
  for (const [uid, u] of Object.entries(users || {})) {
    if (!u || u.role === "admin" || u.role === "developer" || u.whatsappOptOut) continue;
    if (!(att && att[uid]) && !u.empNo) continue;
    const facts = noticeFacts(att ? att[uid] : null, leaveOf[uid] || null, cfg);
    rows.push({ name: u.name || uid, facts });
    if (cfg.onlyViolations !== false && !facts.violation) continue;
    const to = waNumber(u.whatsapp, u.countryCode || "+968");
    if (!to) { items[uid] = { ok: false, err: "لا يوجد رقم واتساب", name: u.name || uid }; failed++; continue; }
    const vars = { name: u.name, date, day, empNo: u.empNo, spec: (u.title || u.specialization || "").trim(), school: settings || "", late: facts.lateMin ? facts.lateMin + " دقيقة" : "", status: factsLine(facts) };
    try {
      const html = buildNoticeHtml({ logo: logo || "", schoolName: settings || "", name: u.name || uid, empNo: u.empNo, spec: (u.title || u.specialization || "").trim(), date, day, facts, principalName: cfg.principalName, principalTitle: cfg.principalTitle });
      await sendPdf(to, fillTemplate(cfg.template || DEFAULT_NOTICE_TEMPLATE, vars), html, "إفادة - " + (u.name || uid) + " - " + date + ".pdf");
      items[uid] = { ok: true, name: u.name || uid }; sent++;
    } catch (e) { items[uid] = { ok: false, err: e?.message || "send failed", name: u.name || uid }; failed++; }
    await sleep(2500 + Math.random() * 2500);
  }
  if (cfg.summaryEnabled !== false) {
    const summary = buildManagerSummary(rows, date, day, { sent, failed });
    for (const n of managerNumbers(cfg)) { try { await sendText(n, summary); } catch (e) { failed++; } }
  }
  return { sent, failed, items, by: opts.by || "auto" };
}

/* ---------------- outbox (leave requests, decisions) ---------------- */
async function processQueue(cfg) {
  const q = await fb("whatsapp/queue");
  if (!q) return;
  for (const [id, m] of Object.entries(q)) {
    const targets = m.to === "manager" ? managerNumbers(cfg) : [waNumber(m.to)].filter(Boolean);
    let ok = targets.length > 0, err = targets.length ? "" : "لا يوجد رقم";
    for (const t of targets) { try { await sendText(t, m.message); } catch (e) { ok = false; err = e?.message || "send failed"; } }
    if (ok || (m.tries || 0) >= 4) { await fbDel("whatsapp/queue/" + id); await log({ kind: m.kind || "queue", to: m.to, ok, err }); }
    else await fbPut("whatsapp/queue/" + id + "/tries", (m.tries || 0) + 1);
  }
}

let busy = false;
async function tick() {
  if (busy || !connected) return;
  busy = true;
  try {
    const cfg = await fb("whatsapp/config");
    if (!cfg || !(await isActive(cfg))) return;
    await processQueue(cfg);
    if (cfg.enabled === false) return;
    const now = omanNow(), t = toMin(cfg.time);
    if (!(cfg.workDays || [0, 1, 2, 3, 4]).includes(now.dow) || now.min < t || now.min > t + 240) return;
    if (await fb("whatsapp/runs/" + now.date + "/status")) return;
    const has = await fb("staffAttendance/" + now.date, undefined, "?shallow=true");
    if (!has) return; // the fingerprint report is not uploaded yet — try again next tick
    await fbPut("whatsapp/runs/" + now.date, { status: "running", at: Date.now() });
    const res = await runDaily(now.date);
    await fbPut("whatsapp/runs/" + now.date, { ...res, status: "done", at: Date.now() });
  } catch (e) { console.error("tick", e); } finally { busy = false; }
}
setInterval(tick, 30000);

/* ---------------- HTTP ---------------- */
function auth(req, res, next) {
  if ((req.headers.authorization || "") !== "Bearer " + SERVICE_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}
app.get("/", (_q, res) => res.json({ ok: true, service: "school-whatsapp" }));
app.get("/status", auth, (_q, res) => res.json({ ok: !startupError, connected, status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting", error: startupError || undefined, qr: lastQr || undefined, persistentAuth: AUTH_DIR.startsWith("/data/") }));
app.get("/qr", auth, (_q, res) => res.json({ qr: lastQr || null, connected }));
app.post("/send", auth, async (req, res) => {
  try { const { to, message } = req.body || {}; if (!to || !message) return res.status(400).json({ error: "to & message required" }); await sendText(to, message); res.json({ ok: true }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/send-pdf", auth, async (req, res) => {
  try { const { to, message, html, fileName } = req.body || {}; if (!to || !html) return res.status(400).json({ error: "to & html required" }); await sendPdf(to, message, html, fileName); await log({ kind: "test", to, ok: true }); res.json({ ok: true }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/run-daily", auth, async (req, res) => {
  try { const date = req.body?.date || omanNow().date; const r = await runDaily(date, { force: !!req.body?.force, by: req.body?.by || "manual" }); await fbPut("whatsapp/runs/" + date, { ...r, status: "done", at: Date.now() }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e?.message || "run failed" }); }
});
app.post("/logout", auth, async (_q, res) => {
  try { await sock?.logout(); } catch {}
  generation++; await stopSocket(); await rm(AUTH_DIR, { recursive: true, force: true }); await fbDel(SESSION).catch(() => {});
  connected = false; lastQr = ""; await start();
  res.json({ ok: true });
});
app.post("/restart", auth, async (_q, res) => { connected = false; lastQr = ""; await start(); res.json({ ok: true }); });
app.listen(PORT, () => console.log("listening on " + PORT));
// Render free services sleep after 15 idle minutes; pinging our own public URL keeps the daily schedule running.
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "").replace(/\/+$/, "");
if (SELF_URL) setInterval(() => fetch(SELF_URL + "/").catch(() => {}), 10 * 60 * 1000);
