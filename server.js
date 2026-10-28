import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import puppeteer from "puppeteer-core";
import { mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
if (SERVICE_TOKEN === "change-me") { console.error("SERVICE_TOKEN must be configured"); process.exit(1); }

/* ---------------- shared notice builders (generated from the web app) ---------------- */
const noticeFacts = function noticeFacts(punch, leave, cfg) {
  const toSec = (hm) => {
    const [h, m] = String(hm || "").split(":").map(Number);
    return (h || 0) * 3600 + (m || 0) * 60;
  }, om = (ms) => ((Math.floor(ms / 1000) + 14400) % 86400 + 86400) % 86400, clock = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "\u0635\u0628\u0627\u062D\u064B\u0627" : "\u0645\u0633\u0627\u0621\u064B");
  }, inLim = toSec(cfg && cfg.inLimit || "07:10"), outT = toSec(cfg && cfg.outTime || "13:40"), p = punch || {}, inS = p.in ? om(p.in) : null, outS = p.out ? om(p.out) : null, lateMin = inS !== null && inS > inLim ? Math.ceil((inS - inLim) / 60) : 0, earlyMin = outS !== null && outS < outT ? Math.ceil((outT - outS) / 60) : 0, kind = leave ? leave.kind || "full" : "", excuseIn = kind === "full" || kind === "late", excuseOut = kind === "full" || kind === "early", leaveText = leave ? "\u0645\u0633\u062A\u0623\u0630\u0646" + (leave.from || leave.to ? " (" + [leave.from, leave.to].filter(Boolean).join(" - ") + ")" : "") + (leave.reason ? " \u2014 " + leave.reason : "") : "", badIn = (lateMin > 0 || inS === null) && !excuseIn, badOut = (earlyMin > 0 || outS === null) && !excuseOut;
  return {
    inClock: inS !== null ? clock(inS) : "",
    outClock: outS !== null ? clock(outS) : "",
    inLimitClock: clock(inLim),
    outTimeClock: clock(outT),
    lateMin,
    earlyMin,
    missingIn: inS === null,
    missingOut: outS === null,
    excuseIn,
    excuseOut,
    leaveText,
    violation: badIn || badOut
  };
};
const dayNameAr = function dayNameAr(date) {
  return ["\u0627\u0644\u0623\u062D\u062F", "\u0627\u0644\u0627\u062B\u0646\u064A\u0646", "\u0627\u0644\u062B\u0644\u0627\u062B\u0627\u0621", "\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621", "\u0627\u0644\u062E\u0645\u064A\u0633", "\u0627\u0644\u062C\u0645\u0639\u0629", "\u0627\u0644\u0633\u0628\u062A"][new Date(date + "T12:00:00Z").getUTCDay()] || "";
};
const fillTemplate = function fillTemplate(tpl, v) {
  let out = String(tpl || "");
  const keys = ["name", "date", "day", "empNo", "spec", "school", "late", "status"];
  for (const k of keys)
    out = out.split("{" + k + "}").join(String(v[k] || ""));
  return out;
};
const factsLine = function factsLine(f) {
  const parts = [];
  if (f.lateMin)
    parts.push("\u062A\u0623\u062E\u0631 " + f.lateMin + " \u062F\u0642\u064A\u0642\u0629 (\u0628\u0635\u0645 " + f.inClock + ")" + (f.excuseIn ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : ""));
  if (f.missingIn)
    parts.push("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631" + (f.excuseIn ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : ""));
  if (f.missingOut)
    parts.push("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : ""));
  if (f.earlyMin)
    parts.push("\u0627\u0646\u0635\u0631\u0627\u0641 \u0645\u0628\u0643\u0631 " + f.earlyMin + " \u062F\u0642\u064A\u0642\u0629 (\u0628\u0635\u0645 " + f.outClock + ")" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : ""));
  return parts.length ? parts.join("\u060C ") : "\u0645\u0646\u0636\u0628\u0637";
};
const buildNoticeHtml = function buildNoticeHtml(d) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c), f = d.facts, lateTxt = f.lateMin ? f.lateMin + " \u062F\u0642\u064A\u0642\u0629 \u2014 \u0648\u0642\u062A \u0627\u0644\u0628\u0635\u0645\u0629 " + f.inClock + "\u060C \u0648\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0627\u0644\u0628\u0635\u0645 \u0642\u0628\u0644 \u0627\u0644\u0633\u0627\u0639\u0629 " + f.inLimitClock + (f.excuseIn ? " (\u0645\u0633\u062A\u0623\u0630\u0646)" : "") : f.missingIn ? "\u2014" : "\u0644\u0627 \u064A\u0648\u062C\u062F \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 " + f.inClock, inTxt = f.missingIn ? "\u0644\u0645 \u062A\u064F\u0633\u062C\u064E\u0651\u0644 \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 (\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0642\u0628\u0644 \u0627\u0644\u0633\u0627\u0639\u0629 " + f.inLimitClock + ")" + (f.excuseIn ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : "\u0644\u0627 \u064A\u0648\u062C\u062F", outTxt = f.missingOut ? "\u0644\u0645 \u062A\u064F\u0633\u062C\u064E\u0651\u0644 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 (\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0628\u0639\u062F \u0627\u0644\u0633\u0627\u0639\u0629 " + f.outTimeClock + ")" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : f.earlyMin ? "\u0627\u0646\u0635\u0631\u0627\u0641 \u0645\u0628\u0643\u0631 \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 " + f.outClock + " \u0642\u0628\u0644 \u0627\u0644\u0645\u0648\u0639\u062F (" + f.outTimeClock + ") \u0628\u0640 " + f.earlyMin + " \u062F\u0642\u064A\u0642\u0629" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : "\u0644\u0627 \u064A\u0648\u062C\u062F \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 " + f.outClock, row = (k, v, bad) => "<tr><th>" + esc(k) + '</th><td class="' + (bad ? "bad" : "") + '">' + esc(v) + "</td></tr>";
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>\u0625\u0641\u0627\u062F\u0629</title>' + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap"><style>@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font-family:"IBM Plex Sans Arabic","Noto Naskh Arabic","KacstOne",Tahoma,sans-serif;color:#1a2433;margin:0;font-size:15px;line-height:1.9}.head{text-align:center;border-bottom:3px double #1f5f8b;padding-bottom:10px;margin-bottom:18px}.head img{height:110px;object-fit:contain}.head .s{font-weight:700;font-size:16px;margin-top:4px}h1{text-align:center;font-size:30px;margin:6px 0 18px;letter-spacing:2px;color:#1f5f8b}.who{font-size:17px;margin:0 0 4px}.who b{display:inline-block;min-width:110px}p.lead{margin:18px 0 10px;font-size:16px}table{width:100%;border-collapse:collapse;margin:6px 0 18px}th,td{border:1px solid #c9d3df;padding:10px 12px;text-align:right;vertical-align:top}th{width:34%;background:#eef3f8;font-weight:700}td.bad{color:#a61b1b;font-weight:600}.when{display:flex;gap:40px;font-size:16px;margin-top:6px}.sign{margin-top:46px;display:flex;justify-content:flex-end}.sign div{text-align:center;min-width:220px}.sign b{display:block;font-size:17px}.note{margin-top:30px;font-size:12px;color:#6b7785;text-align:center}</style></head><body><div class="head">' + (d.logo ? '<img src="' + esc(d.logo) + '" alt="">' : "") + (d.schoolName ? '<div class="s">' + esc(d.schoolName) + "</div>" : "") + "</div>" + "<h1>\u0625\u0641\u0627\u062F\u0629</h1>" + '<div class="who"><b>\u0627\u0644\u0623\u0633\u062A\u0627\u0630 :</b> ' + esc(d.name) + " \u0627\u0644\u0645\u062D\u062A\u0631\u0645</div>" + '<div class="who"><b>\u0631\u0642\u0645 \u0627\u0644\u0645\u0648\u0638\u0641 :</b> ' + esc(d.empNo || "\u2014") + "</div>" + '<div class="who"><b>\u0627\u0644\u0645\u0633\u0645\u0649 \u0627\u0644\u0648\u0638\u064A\u0641\u064A :</b> ' + esc(d.spec || "\u2014") + "</div>" + '<p class="lead">\u0646\u0641\u064A\u062F\u0643\u0645 \u0628\u0623\u0646\u0647 \u0623\u062B\u0646\u0627\u0621 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629 \u0627\u0644\u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A\u0629 \u0645\u0646 \u062E\u0644\u0627\u0644 \u0645\u0624\u0634\u0631 \u0627\u0644\u0627\u0646\u0636\u0628\u0627\u0637 \u0627\u0644\u0645\u062F\u0631\u0633\u064A \u0644\u0648\u062D\u0638:</p>' + "<table>" + row("\u062A\u0623\u062E\u0631\u0643\u0645", lateTxt, f.lateMin > 0 && !f.excuseIn) + row("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631", inTxt, f.missingIn && !f.excuseIn) + row("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 / \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0627\u0644\u0645\u0628\u0643\u0631", outTxt, (f.missingOut || f.earlyMin > 0) && !f.excuseOut) + (f.leaveText ? row("\u0627\u0644\u0627\u0633\u062A\u0626\u0630\u0627\u0646", f.leaveText, !1) : "") + "</table>" + '<div class="when"><div><b>\u0627\u0644\u064A\u0648\u0645 :</b> ' + esc(d.day) + "</div><div><b>\u0627\u0644\u062A\u0627\u0631\u064A\u062E :</b> " + esc(d.date) + '</div></div><div class="sign" dir="ltr"><div dir="rtl"><b>' + esc(d.principalName || "\u0646\u0627\u0635\u0631 \u063A\u0631\u064A\u0628 \u0627\u0644\u0628\u0644\u0648\u0634\u064A") + "</b>" + esc(d.principalTitle || "\u0645\u062F\u064A\u0631 \u0627\u0644\u0645\u062F\u0631\u0633\u0629") + "</div></div>" + '<div class="note">\u0645\u0648\u0639\u062F \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 \u0642\u0628\u0644 ' + esc(f.inLimitClock) + " \u2014 \u0645\u0648\u0639\u062F \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0628\u0639\u062F " + esc(f.outTimeClock) + "</div></body></html>";
};
const buildManagerSummary = function buildManagerSummary(rows, date, day, extra) {
  const late = rows.filter((r) => r.facts.lateMin > 0), noIn = rows.filter((r) => r.facts.missingIn), noOut = rows.filter((r) => r.facts.missingOut), early = rows.filter((r) => r.facts.earlyMin > 0), leave = rows.filter((r) => r.facts.leaveText), list = (arr, fn) => arr.length ? arr.map((r, i) => "  " + (i + 1) + ". " + fn(r)).join(`
`) : "  \u0644\u0627 \u064A\u0648\u062C\u062F";
  return `\uD83D\uDCCA *\u0625\u062D\u0635\u0627\u0626\u064A\u0629 \u0627\u0644\u0627\u0646\u0636\u0628\u0627\u0637 \u0627\u0644\u064A\u0648\u0645\u064A\u0629*
` + day + " " + date + `
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
` + "\u23F0 *\u0627\u0644\u0645\u062A\u0623\u062E\u0631\u0648\u0646 (" + late.length + `):*
` + list(late, (r) => r.name + " \u2014 " + r.facts.lateMin + " \u062F\u0642\u064A\u0642\u0629 (" + r.facts.inClock + ")" + (r.facts.excuseIn ? " \u0645\u0633\u062A\u0623\u0630\u0646" : "")) + `

` + "\uD83D\uDEAB *\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0627\u0644\u062D\u0636\u0648\u0631 (" + noIn.length + `):*
` + list(noIn, (r) => r.name + (r.facts.excuseIn ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "")) + `

` + "\uD83D\uDEAA *\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 (" + noOut.length + `):*
` + list(noOut, (r) => r.name + (r.facts.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "")) + `

` + "\uD83C\uDFC3 *\u0627\u0646\u0635\u0631\u0627\u0641 \u0645\u0628\u0643\u0631 (" + early.length + `):*
` + list(early, (r) => r.name + " \u2014 " + r.facts.earlyMin + " \u062F\u0642\u064A\u0642\u0629 (" + r.facts.outClock + ")" + (r.facts.excuseOut ? " \u0645\u0633\u062A\u0623\u0630\u0646" : "")) + `

` + "\uD83D\uDCDD *\u0627\u0644\u0645\u0633\u062A\u0623\u0630\u0646\u0648\u0646 (" + leave.length + `):*
` + list(leave, (r) => r.name + " \u2014 " + r.facts.leaveText) + (extra ? `
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\uD83D\uDCE8 \u0623\u064F\u0631\u0633\u0644\u062A \u0627\u0644\u0625\u0641\u0627\u062F\u0627\u062A: ` + (extra.sent || 0) + (extra.failed ? " \xB7 \u0641\u0634\u0644: " + extra.failed : "") : "");
};
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

/* ---------------- PDF ----------------
 * Works on both Render setups: Docker (system Chromium from the Dockerfile) and the plain Node runtime
 * (Chrome downloaded by the "puppeteer" package into ./.cache/puppeteer during npm install). */
let browser = null, pdfError = "", chromeFound = "";
async function findChrome() {
  const paths = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].filter(Boolean);
  for (const p of paths) if (existsSync(p)) return p;
  try { const full = await import("puppeteer"); const p = (full.default || full).executablePath(); if (p && existsSync(p)) return p; } catch {}
  throw new Error("Chromium \u063A\u064A\u0631 \u0645\u0648\u062C\u0648\u062F \u0639\u0644\u0649 \u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u2014 \u062D\u062F\u0651\u062B \u0645\u0644\u0641\u0627\u062A \u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u062B\u0645 \u0623\u0639\u062F \u0627\u0644\u0646\u0634\u0631");
}
async function htmlToPdf(html) {
  if (!browser || !browser.connected) {
    chromeFound = await findChrome();
    browser = await puppeteer.launch({ executablePath: chromeFound, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--font-render-hinting=none"] });
  }
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => page.setContent(html, { waitUntil: "load" }));
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const pdf = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
    pdfError = "";
    return pdf;
  } finally { await page.close().catch(() => {}); }
}
// The text notice is always delivered; if the PDF cannot be produced the message still goes out and the reason is reported.
async function sendPdf(to, message, html, fileName) {
  if (!sock || !connected) throw new Error("whatsapp not connected");
  let pdf = null;
  try { pdf = await htmlToPdf(html); } catch (e) { pdfError = e?.message || String(e); browser = null; console.error("pdf", pdfError); }
  if (message) await sock.sendMessage(jidOf(to), { text: String(message) });
  if (pdf) await sock.sendMessage(jidOf(to), { document: pdf, mimetype: "application/pdf", fileName: fileName || "\u0625\u0641\u0627\u062F\u0629.pdf" });
  return { pdf: !!pdf, pdfError: pdf ? undefined : pdfError };
}
findChrome().then((p) => { chromeFound = p; console.log("chromium:", p); }).catch((e) => { pdfError = e.message; console.error(e.message); });

/* ---------------- helpers ---------------- */
const toEn = (s) => String(s || "").replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 1632)).replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 1776));
function waNumber(phone, country = "+968") {
  const p = toEn(phone).replace(/[\s()-]/g, ""), c = toEn(country).replace(/^\+/, "");
  if (!p) return "";
  const full = p.startsWith("+") ? p.slice(1) : p.startsWith("00") ? p.slice(2) : (p.length > 8 && p.startsWith(c) ? p : c + p.replace(/^0/, ""));
  return /^[1-9]\d{6,14}$/.test(full) ? full : "";
}
const managerNumbers = (cfg) => String(cfg.managerNumber || "").split(/[,\u060C\s]+/).map((n) => waNumber(n)).filter(Boolean);
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
    if (!to) { items[uid] = { ok: false, err: "\u0644\u0627 \u064A\u0648\u062C\u062F \u0631\u0642\u0645 \u0648\u0627\u062A\u0633\u0627\u0628", name: u.name || uid }; failed++; continue; }
    const vars = { name: u.name, date, day, empNo: u.empNo, spec: (u.title || u.specialization || "").trim(), school: settings || "", late: facts.lateMin ? facts.lateMin + " \u062F\u0642\u064A\u0642\u0629" : "", status: factsLine(facts) };
    try {
      const html = buildNoticeHtml({ logo: logo || "", schoolName: settings || "", name: u.name || uid, empNo: u.empNo, spec: (u.title || u.specialization || "").trim(), date, day, facts, principalName: cfg.principalName, principalTitle: cfg.principalTitle });
      const r = await sendPdf(to, fillTemplate(cfg.template || DEFAULT_NOTICE_TEMPLATE, vars), html, "\u0625\u0641\u0627\u062F\u0629 - " + (u.name || uid) + " - " + date + ".pdf");
      items[uid] = r.pdf ? { ok: true, name: u.name || uid } : { ok: true, name: u.name || uid, err: "\u0623\u064F\u0631\u0633\u0644\u062A \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0628\u062F\u0648\u0646 PDF: " + r.pdfError }; sent++;
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
    let ok = targets.length > 0, err = targets.length ? "" : "\u0644\u0627 \u064A\u0648\u062C\u062F \u0631\u0642\u0645";
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
    if (!has) return; // the fingerprint report is not uploaded yet \u2014 try again next tick
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
app.get("/status", auth, (_q, res) => res.json({ ok: !startupError, connected, status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting", error: startupError || undefined, qr: lastQr || undefined, persistentAuth: AUTH_DIR.startsWith("/data/"), pdf: !pdfError && !!chromeFound, pdfError: pdfError || undefined }));
app.get("/qr", auth, (_q, res) => res.json({ qr: lastQr || null, connected }));
app.post("/send", auth, async (req, res) => {
  try { const { to, message } = req.body || {}; if (!to || !message) return res.status(400).json({ error: "to & message required" }); await sendText(to, message); res.json({ ok: true }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/send-pdf", auth, async (req, res) => {
  try { const { to, message, html, fileName } = req.body || {}; if (!to || !html) return res.status(400).json({ error: "to & html required" }); const r = await sendPdf(to, message, html, fileName); await log({ kind: "test", to, ok: true, pdf: r.pdf, err: r.pdfError }); res.json({ ok: true, ...r }); }
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
