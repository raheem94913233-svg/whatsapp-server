import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
const buildNoticeSvg = function buildNoticeSvg(d) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c), rl = (s) => "\u200F" + s + "\u200F", wrap = (text, width, size) => {
    const max = Math.max(8, Math.floor(width / (size * 0.46))), out = [];
    let cur = "";
    for (const w of String(text || "").split(/\s+/).filter(Boolean))
      if (cur && (cur + " " + w).length > max) {
        out.push(cur);
        cur = w;
      } else
        cur = cur ? cur + " " + w : w;
    if (cur)
      out.push(cur);
    return out.length ? out : [""];
  }, t = (x, y, s, size, o) => '<text x="' + x + '" y="' + y + '" font-family="IBM Plex Sans Arabic" font-size="' + size + '" font-weight="' + (o && o.weight || (o && o.bold ? 700 : 400)) + '" fill="' + (o && o.color || "#1a2433") + '" text-anchor="' + (o && o.anchor || "end") + '">' + esc(rl(s)) + "</text>", kv = (x, y, k, v, size) => '<text x="' + x + '" y="' + y + '" font-family="IBM Plex Sans Arabic" font-size="' + size + '" fill="#1a2433" text-anchor="end">' + esc("\u200F") + '<tspan font-weight="700">' + esc(k) + "</tspan> " + esc(v) + esc("\u200F") + "</text>", f = d.facts, lateTxt = f.lateMin ? f.lateMin + " \u062F\u0642\u064A\u0642\u0629 \u2014 \u0648\u0642\u062A \u0627\u0644\u0628\u0635\u0645\u0629 " + f.inClock + "\u060C \u0648\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0627\u0644\u0628\u0635\u0645 \u0642\u0628\u0644 \u0627\u0644\u0633\u0627\u0639\u0629 " + f.inLimitClock + (f.excuseIn ? " (\u0645\u0633\u062A\u0623\u0630\u0646)" : "") : f.missingIn ? "\u2014" : "\u0644\u0627 \u064A\u0648\u062C\u062F \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 " + f.inClock, inTxt = f.missingIn ? "\u0644\u0645 \u062A\u064F\u0633\u062C\u064E\u0651\u0644 \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 (\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0642\u0628\u0644 \u0627\u0644\u0633\u0627\u0639\u0629 " + f.inLimitClock + ")" + (f.excuseIn ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : "\u0644\u0627 \u064A\u0648\u062C\u062F", outTxt = f.missingOut ? "\u0644\u0645 \u062A\u064F\u0633\u062C\u064E\u0651\u0644 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 (\u0627\u0644\u0645\u0641\u062A\u0631\u0636 \u0628\u0639\u062F \u0627\u0644\u0633\u0627\u0639\u0629 " + f.outTimeClock + ")" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : f.earlyMin ? "\u0627\u0646\u0635\u0631\u0627\u0641 \u0645\u0628\u0643\u0631 \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 " + f.outClock + " \u0642\u0628\u0644 \u0627\u0644\u0645\u0648\u0639\u062F (" + f.outTimeClock + ") \u0628\u0640 " + f.earlyMin + " \u062F\u0642\u064A\u0642\u0629" + (f.excuseOut ? " \u2014 \u0645\u0633\u062A\u0623\u0630\u0646" : "") : "\u0644\u0627 \u064A\u0648\u062C\u062F \u2014 \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 " + f.outClock, rows = [
    ["\u062A\u0623\u062E\u0631\u0643\u0645", lateTxt, f.lateMin > 0 && !f.excuseIn],
    ["\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631", inTxt, f.missingIn && !f.excuseIn],
    ["\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 / \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0627\u0644\u0645\u0628\u0643\u0631", outTxt, (f.missingOut || f.earlyMin > 0) && !f.excuseOut]
  ];
  if (f.leaveText)
    rows.push(["\u0627\u0644\u0627\u0633\u062A\u0626\u0630\u0627\u0646", f.leaveText, !1]);
  let y = 70, s = "";
  if (d.logo) {
    s += '<image href="' + esc(d.logo) + '" x="400" y="' + y + '" width="440" height="160" preserveAspectRatio="xMidYMid meet"/>';
    y += 175;
  }
  if (d.schoolName) {
    y += 30;
    s += t(620, y, d.schoolName, 28, { bold: !0, anchor: "middle" });
    y += 12;
  }
  y += 14;
  s += '<line x1="110" y1="' + y + '" x2="1130" y2="' + y + '" stroke="#1f5f8b" stroke-width="2"/><line x1="110" y1="' + (y + 6) + '" x2="1130" y2="' + (y + 6) + '" stroke="#1f5f8b" stroke-width="2"/>';
  y += 90;
  s += t(620, y, "\u0625\u0641\u0627\u062F\u0629", 58, { bold: !0, color: "#1f5f8b", anchor: "middle" });
  y += 80;
  s += kv(1130, y, "\u0627\u0644\u0623\u0633\u062A\u0627\u0630 :", (d.name || "") + " \u0627\u0644\u0645\u062D\u062A\u0631\u0645", 30);
  y += 52;
  s += kv(1130, y, "\u0631\u0642\u0645 \u0627\u0644\u0645\u0648\u0638\u0641 :", d.empNo || "\u2014", 30);
  y += 52;
  s += kv(1130, y, "\u0627\u0644\u0645\u0633\u0645\u0649 \u0627\u0644\u0648\u0638\u064A\u0641\u064A :", d.spec || "\u2014", 30);
  y += 40;
  for (const line of wrap("\u0646\u0641\u064A\u062F\u0643\u0645 \u0628\u0623\u0646\u0647 \u0623\u062B\u0646\u0627\u0621 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629 \u0627\u0644\u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A\u0629 \u0645\u0646 \u062E\u0644\u0627\u0644 \u0645\u0624\u0634\u0631 \u0627\u0644\u0627\u0646\u0636\u0628\u0627\u0637 \u0627\u0644\u0645\u062F\u0631\u0633\u064A \u0644\u0648\u062D\u0638:", 1020, 28)) {
    y += 46;
    s += t(1130, y, line, 28);
  }
  y += 26;
  const thW = Math.round(346.8), pad = 20, lh = 40;
  for (const [k, v, bad] of rows) {
    const kl = wrap(k, thW - pad * 2, 26), vl = wrap(v, 1020 - thW - pad * 2, 26), h = Math.max(kl.length, vl.length) * lh + 26;
    s += '<rect x="' + (1130 - thW) + '" y="' + y + '" width="' + thW + '" height="' + h + '" fill="#eef3f8" stroke="#c9d3df" stroke-width="2"/>';
    s += '<rect x="110" y="' + y + '" width="' + (1020 - thW) + '" height="' + h + '" fill="#ffffff" stroke="#c9d3df" stroke-width="2"/>';
    kl.forEach((line, i) => {
      s += t(1130 - pad, y + 44 + i * lh, line, 26, { bold: !0 });
    });
    vl.forEach((line, i) => {
      s += t(1130 - thW - pad, y + 44 + i * lh, line, 26, bad ? { color: "#a61b1b", weight: 600 } : void 0);
    });
    y += h;
  }
  y += 70;
  s += kv(1130, y, "\u0627\u0644\u064A\u0648\u0645 :", d.day, 28) + kv(710, y, "\u0627\u0644\u062A\u0627\u0631\u064A\u062E :", "\u202A" + d.date + "\u202C", 28);
  y += 120;
  s += t(310, y, d.principalName || "\u0646\u0627\u0635\u0631 \u063A\u0631\u064A\u0628 \u0627\u0644\u0628\u0644\u0648\u0634\u064A", 30, { bold: !0, anchor: "middle" });
  s += t(310, y + 46, d.principalTitle || "\u0645\u062F\u064A\u0631 \u0627\u0644\u0645\u062F\u0631\u0633\u0629", 27, { anchor: "middle" });
  const H = Math.max(1754, y + 200);
  s += t(620, H - 70, "\u0645\u0648\u0639\u062F \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631 \u0642\u0628\u0644 " + f.inLimitClock + " \u2014 \u0645\u0648\u0639\u062F \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0628\u0639\u062F " + f.outTimeClock, 22, { color: "#6b7785", anchor: "middle" });
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1240" height="' + H + '" viewBox="0 0 1240 ' + H + '"><rect width="100%" height="100%" fill="#ffffff"/>' + s + "</svg>";
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

/* ---------------- PDF / image (no browser needed) ----------------
 * The notice is an SVG drawn by the web app's builder, rendered to PNG with resvg (bundled Arabic font),
 * then placed on an A4 PDF page. If the PDF step fails the PNG is sent as an image; the text always goes out. */
const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "node_modules", "@expo-google-fonts", "ibm-plex-sans-arabic");
const FONT_FILES = ["400Regular/IBMPlexSansArabic_400Regular.ttf", "600SemiBold/IBMPlexSansArabic_600SemiBold.ttf", "700Bold/IBMPlexSansArabic_700Bold.ttf"];
const FONT_URLS = ["Regular", "SemiBold", "Bold"].map((w) => "https://github.com/google/fonts/raw/main/ofl/ibmplexsansarabic/IBMPlexSansArabic-" + w + ".ttf");
let fontsCache = null, pdfError = "";
async function fonts() {
  if (fontsCache) return fontsCache;
  const local = FONT_FILES.map((f) => join(FONT_DIR, f));
  if (local.every((f) => existsSync(f))) return (fontsCache = local);
  await mkdir(join(HERE, "fonts"), { recursive: true });
  const out = [];
  for (const [i, u] of FONT_URLS.entries()) {
    const f = join(HERE, "fonts", i + ".ttf");
    if (!existsSync(f)) { const r = await fetch(u); if (!r.ok) throw new Error("font download " + r.status); await writeFile(f, Buffer.from(await r.arrayBuffer())); }
    out.push(f);
  }
  return (fontsCache = out);
}
async function svgToPng(svg) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: 1240 }, font: { fontFiles: await fonts(), loadSystemFonts: false, defaultFontFamily: "IBM Plex Sans Arabic" } });
  return Buffer.from(r.render().asPng());
}
async function pngToPdf(png) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const w = 595.28, h = (img.height / img.width) * w;
  doc.addPage([w, Math.max(h, 841.89)]).drawImage(img, { x: 0, y: Math.max(h, 841.89) - h, width: w, height: h });
  return Buffer.from(await doc.save());
}
// Sends the message, then the notice as a PDF (or as an image if the PDF cannot be built).
async function sendPdf(to, message, svg, fileName) {
  if (!sock || !connected) throw new Error("whatsapp not connected");
  let png = null, pdf = null;
  try { png = await svgToPng(svg); } catch (e) { pdfError = "render: " + (e?.message || e); console.error(pdfError); }
  if (png) { try { pdf = await pngToPdf(png); pdfError = ""; } catch (e) { pdfError = "pdf: " + (e?.message || e); console.error(pdfError); } }
  if (message) await sock.sendMessage(jidOf(to), { text: String(message) });
  if (pdf) await sock.sendMessage(jidOf(to), { document: pdf, mimetype: "application/pdf", fileName: fileName || "\u0625\u0641\u0627\u062F\u0629.pdf" });
  else if (png) await sock.sendMessage(jidOf(to), { image: png, caption: (fileName || "\u0625\u0641\u0627\u062F\u0629").replace(/\.pdf$/i, "") });
  return { pdf: !!pdf, image: !pdf && !!png, pdfError: pdf ? undefined : pdfError };
}
fonts().then(() => svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text x="20" y="30">\u0627\u062E\u062A\u0628\u0627\u0631</text></svg>')).then(() => console.log("pdf renderer ready")).catch((e) => { pdfError = e?.message || String(e); console.error("pdf renderer", pdfError); });

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
      const svg = buildNoticeSvg({ logo: logo || "", schoolName: settings || "", name: u.name || uid, empNo: u.empNo, spec: (u.title || u.specialization || "").trim(), date, day, facts, principalName: cfg.principalName, principalTitle: cfg.principalTitle });
      const r = await sendPdf(to, fillTemplate(cfg.template || DEFAULT_NOTICE_TEMPLATE, vars), svg, "\u0625\u0641\u0627\u062F\u0629 - " + (u.name || uid) + " - " + date + ".pdf");
      items[uid] = r.pdf ? { ok: true, name: u.name || uid } : { ok: true, name: u.name || uid, err: r.image ? "\u0623\u064F\u0631\u0633\u0644\u062A \u0627\u0644\u0625\u0641\u0627\u062F\u0629 \u0643\u0635\u0648\u0631\u0629" : "\u0623\u064F\u0631\u0633\u0644\u062A \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0628\u062F\u0648\u0646 \u0627\u0644\u0625\u0641\u0627\u062F\u0629: " + r.pdfError }; sent++;
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
app.get("/status", auth, (_q, res) => res.json({ ok: !startupError, connected, status: startupError ? "error" : connected ? "connected" : starting ? "starting" : "waiting", error: startupError || undefined, qr: lastQr || undefined, persistentAuth: AUTH_DIR.startsWith("/data/"), pdf: !pdfError, renderer: "resvg", pdfError: pdfError || undefined }));
app.get("/qr", auth, (_q, res) => res.json({ qr: lastQr || null, connected }));
app.post("/send", auth, async (req, res) => {
  try { const { to, message } = req.body || {}; if (!to || !message) return res.status(400).json({ error: "to & message required" }); await sendText(to, message); res.json({ ok: true }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/send-pdf", auth, async (req, res) => {
  try { const { to, message, svg, doc, fileName } = req.body || {}; const pic = svg || (doc ? buildNoticeSvg(doc) : ""); if (!to || !pic) return res.status(400).json({ error: "to & svg required" }); const r = await sendPdf(to, message, pic, fileName); await log({ kind: "test", to, ok: true, pdf: r.pdf, err: r.pdfError }); res.json({ ok: true, ...r }); }
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
