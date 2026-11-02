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
import { zipSync, strToU8 } from "fflate";
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
const renameWording = function renameWording(text) {
  return String(text || "").replace(/\u0627\u0644\u0625\u0641\u0627\u062F\u0627\u062A|\u0627\u0644\u0627\u0641\u0627\u062F\u0627\u062A/g, "\u062E\u0637\u0627\u0628\u0627\u062A \xAB\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631\xBB").replace(/\u0625\u0641\u0627\u062F\u0627\u062A|\u0627\u0641\u0627\u062F\u0627\u062A/g, "\u062E\u0637\u0627\u0628\u0627\u062A \xAB\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631\xBB").replace(/\u0627\u0644\u0625\u0641\u0627\u062F\u0629|\u0627\u0644\u0627\u0641\u0627\u062F\u0629/g, "\u062E\u0637\u0627\u0628 \xAB\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631\xBB").replace(/\u0625\u0641\u0627\u062F\u0629|\u0627\u0641\u0627\u062F\u0629/g, "\u062E\u0637\u0627\u0628 \xAB\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631\xBB");
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
  s += t(620, y, "\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631", 58, { bold: !0, color: "#1f5f8b", anchor: "middle" });
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
\uD83D\uDCE8 \u0623\u064F\u0631\u0633\u0644\u062A \u062E\u0637\u0627\u0628\u0627\u062A \xAB\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631\xBB: ` + (extra.sent || 0) + (extra.failed ? " \xB7 \u0641\u0634\u0644: " + extra.failed : "") : "");
};
const DEFAULT_NOTICE_TEMPLATE = "السلام عليكم ورحمة الله\nالأستاذ {name} المحترم\nمرفق لكم خطاب «لمن يهمه الأمر» بمتابعة الانضباط المدرسي ليوم {day} {date}.\n{status}\n\nإدارة المدرسة";
const fillVars = function fillVars(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? "" : vars[k]) : m);
};
const withOptIn = function withOptIn(message, isFirst, optInText) {
  const extra = String(optInText || "").trim();
  return isFirst && extra ? String(message || "").replace(/\s+$/, "") + `

` + extra : String(message || "");
};
const collectAbsences = function collectAbsences(date, students, attendance, log, meta, schedule) {
  const safe = (s) => String(s || "").replace(/[.#$[\]/]/g, "_"), sched = schedule || [], out = {};
  for (const key of Object.keys(attendance || {})) {
    const parts = key.split("_");
    if (parts[0] !== date || parts[parts.length - 1] !== "regular")
      continue;
    const period = parts.slice(1, -1).join("_"), p = sched.find((x) => x.id === period), marks = (attendance || {})[key] || {};
    for (const sid of Object.keys(marks)) {
      if (marks[sid] !== "absent")
        continue;
      const s = students ? students[sid] : void 0;
      if (!s || !s.name)
        continue;
      const entries = Object.values(log && log[key] && log[key][sid] || {}).filter((e) => e && e.s === "absent").sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))), m = meta && meta[key] ? meta[key][safe(s.classSection)] : void 0, teacher = (entries.length ? entries[entries.length - 1].by : "") || (m ? m.by || m.firstBy : "") || "";
      if (!out[sid])
        out[sid] = { id: sid, name: s.name, classSection: s.classSection || "", phone: s.guardianPhone || "", guardianName: s.guardianName || "", periods: [] };
      out[sid].periods.push({ id: period, label: p ? p.label : period, from: p && p.from ? p.from : "", teacher });
    }
  }
  const idx = (id) => {
    const i = sched.findIndex((x) => x.id === id);
    return i < 0 ? 99 : i;
  };
  return Object.values(out).map((r) => ({ ...r, periods: r.periods.sort((a, b) => idx(a.id) - idx(b.id)) })).sort((a, b) => a.classSection.localeCompare(b.classSection, "ar", { numeric: !0 }) || a.name.localeCompare(b.name, "ar"));
};
const guardianMessage = function guardianMessage(tpl, a, ctx) {
  const periods = a.periods.map((p) => "\u2022 \u0627\u0644\u062D\u0635\u0629 " + p.label + (p.from ? " (" + p.from + ")" : "") + " \u2014 \u0633\u062C\u0651\u0644 \u0627\u0644\u063A\u064A\u0627\u0628: " + (p.teacher ? "\u0623. " + p.teacher : "\u2014")).join(`
`), teachers = Array.from(new Set(a.periods.map((p) => p.teacher).filter(Boolean))).join("\u060C "), vars = { student: a.name, class: a.classSection, day: ctx.day, date: ctx.date, count: a.periods.length, periods, teachers, guardian: a.guardianName || "", school: ctx.school || "" };
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
};
const guardianSummary = function guardianSummary(date, day, total, sent, failed, held, noPhone) {
  return "\uD83D\uDCCA \u0625\u0634\u0639\u0627\u0631\u0627\u062A \u063A\u064A\u0627\u0628 \u0627\u0644\u0637\u0644\u0627\u0628 \u2014 " + day + " " + date + `
\u2022 \u0627\u0644\u0637\u0644\u0627\u0628 \u0627\u0644\u063A\u0627\u0626\u0628\u0648\u0646: ` + total + `
\u2022 \u0623\u064F\u0631\u0633\u0644\u062A: ` + sent + `
\u2022 \u0641\u0634\u0644\u062A: ` + failed + (held ? `
\u2022 \u0645\u0624\u062C\u0644\u0629 (\u062A\u062C\u0627\u0648\u0632 \u0627\u0644\u062D\u062F \u0627\u0644\u064A\u0648\u0645\u064A): ` + held : "") + (noPhone ? `
\u2022 \u0628\u062F\u0648\u0646 \u0631\u0642\u0645 \u0648\u0644\u064A \u0623\u0645\u0631: ` + noPhone : "");
};
const monthStats = function monthStats(month, uid, cfg) {
  const toSec = (hm) => {
    const [h, m] = String(hm || "").split(":").map(Number);
    return (h || 0) * 3600 + (m || 0) * 60;
  }, om = (ms) => ((Math.floor(ms / 1000) + 14400) % 86400 + 86400) % 86400, clock = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " \u0635" : " \u0645");
  }, inLim = toSec(cfg && cfg.inLimit || "07:10"), outT = toSec(cfg && cfg.outTime || "13:40"), r = { days: 0, onTime: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0, missIn: 0, missOut: 0, rows: [] };
  for (const date of Object.keys(month || {}).sort()) {
    const day = (month || {})[date];
    if (!day || !Object.keys(day).length)
      continue;
    const p = day[uid] || {}, inS = p.in ? om(p.in) : null, outS = p.out ? om(p.out) : null, lateMin = inS !== null && inS > inLim ? Math.ceil((inS - inLim) / 60) : 0, earlyMin = outS !== null && outS < outT ? Math.ceil((outT - outS) / 60) : 0;
    r.days++;
    if (lateMin) {
      r.late++;
      r.lateMin += lateMin;
    }
    if (earlyMin) {
      r.early++;
      r.earlyMin += earlyMin;
    }
    if (inS === null)
      r.missIn++;
    if (outS === null)
      r.missOut++;
    if (inS !== null && outS !== null && !lateMin && !earlyMin)
      r.onTime++;
    r.rows.push({ date, inClock: inS !== null ? clock(inS) : "", outClock: outS !== null ? clock(outS) : "", lateMin, earlyMin, missIn: inS === null, missOut: outS === null });
  }
  return r;
};
const monthlyVars = function monthlyVars(name, empNo, year, month, s, school) {
  const dur = (m) => (m >= 60 ? Math.floor(m / 60) + " \u0633\u0627\u0639\u0629 " + (m % 60 ? m % 60 + " \u062F\u0642\u064A\u0642\u0629" : "") : m + " \u062F\u0642\u064A\u0642\u0629").trim();
  return { name, empNo: empNo || "\u2014", month: ["\u064A\u0646\u0627\u064A\u0631", "\u0641\u0628\u0631\u0627\u064A\u0631", "\u0645\u0627\u0631\u0633", "\u0623\u0628\u0631\u064A\u0644", "\u0645\u0627\u064A\u0648", "\u064A\u0648\u0646\u064A\u0648", "\u064A\u0648\u0644\u064A\u0648", "\u0623\u063A\u0633\u0637\u0633", "\u0633\u0628\u062A\u0645\u0628\u0631", "\u0623\u0643\u062A\u0648\u0628\u0631", "\u0646\u0648\u0641\u0645\u0628\u0631", "\u062F\u064A\u0633\u0645\u0628\u0631"][month - 1] || String(month), year, days: s.days, onTime: s.onTime, late: s.late, lateTotal: dur(s.lateMin), early: s.early, missIn: s.missIn, missOut: s.missOut, school: school || "" };
};
const buildMonthlyDocx = function buildMonthlyDocx(d) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c), months = ["\u064A\u0646\u0627\u064A\u0631", "\u0641\u0628\u0631\u0627\u064A\u0631", "\u0645\u0627\u0631\u0633", "\u0623\u0628\u0631\u064A\u0644", "\u0645\u0627\u064A\u0648", "\u064A\u0648\u0646\u064A\u0648", "\u064A\u0648\u0644\u064A\u0648", "\u0623\u063A\u0633\u0637\u0633", "\u0633\u0628\u062A\u0645\u0628\u0631", "\u0623\u0643\u062A\u0648\u0628\u0631", "\u0646\u0648\u0641\u0645\u0628\u0631", "\u062F\u064A\u0633\u0645\u0628\u0631"], run = (t, o = {}) => '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' + (o.b ? "<w:b/><w:bCs/>" : "") + (o.color ? '<w:color w:val="' + o.color + '"/>' : "") + '<w:sz w:val="' + (o.sz || 26) + '"/><w:szCs w:val="' + (o.sz || 26) + '"/><w:rtl/></w:rPr><w:t xml:space="preserve">' + esc(t) + "</w:t></w:r>", para = (runs, o = {}) => '<w:p><w:pPr><w:bidi/><w:spacing w:after="' + (o.after == null ? 120 : o.after) + '"/><w:jc w:val="' + (o.jc || "right") + '"/></w:pPr>' + runs + "</w:p>", cell = (t, o = {}) => '<w:tc><w:tcPr><w:tcW w:w="' + (o.w || 2000) + '" w:type="dxa"/>' + (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : "") + "</w:tcPr>" + para(run(t, { b: o.b, sz: 22, color: o.color }), { jc: "center", after: 0 }) + "</w:tc>", table = (rows) => '<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' + ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => "<w:" + b + ' w:val="single" w:sz="6" w:color="9FB3C8"/>').join("") + "</w:tblBorders></w:tblPr>" + rows.join("") + "</w:tbl>", tr = (cells) => "<w:tr>" + cells + "</w:tr>", s = d.stats, mName = months[d.month - 1] || String(d.month), dur = (m) => (m >= 60 ? Math.floor(m / 60) + " \u0633\u0627\u0639\u0629 " + (m % 60 ? m % 60 + " \u062F\u0642\u064A\u0642\u0629" : "") : m + " \u062F\u0642\u064A\u0642\u0629").trim(), summary = table([
    tr(cell("\u0627\u0644\u0628\u0646\u062F", { b: !0, fill: "E8F0F8", w: 3200 }) + cell("\u0627\u0644\u0639\u062F\u062F", { b: !0, fill: "E8F0F8", w: 1800 })),
    tr(cell("\u0623\u064A\u0627\u0645 \u0627\u0644\u062F\u0648\u0627\u0645 \u0627\u0644\u0645\u062D\u062A\u0633\u0628\u0629", { w: 3200 }) + cell(String(s.days), { w: 1800 })),
    tr(cell("\u0623\u064A\u0627\u0645 \u0645\u0646\u0636\u0628\u0637\u0629 (\u062D\u0636\u0648\u0631 \u0648\u0627\u0646\u0635\u0631\u0627\u0641 \u0641\u064A \u0627\u0644\u0645\u0648\u0639\u062F)", { w: 3200 }) + cell(String(s.onTime), { w: 1800 })),
    tr(cell("\u0645\u0631\u0627\u062A \u0627\u0644\u062A\u0623\u062E\u064A\u0631 \u0627\u0644\u0635\u0628\u0627\u062D\u064A", { w: 3200 }) + cell(s.late + (s.lateMin ? " (" + dur(s.lateMin) + ")" : ""), { w: 1800, color: s.late ? "A61B1B" : void 0 })),
    tr(cell("\u0645\u0631\u0627\u062A \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0627\u0644\u0645\u0628\u0643\u0631", { w: 3200 }) + cell(s.early + (s.earlyMin ? " (" + dur(s.earlyMin) + ")" : ""), { w: 1800, color: s.early ? "A61B1B" : void 0 })),
    tr(cell("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631", { w: 3200 }) + cell(String(s.missIn), { w: 1800, color: s.missIn ? "A61B1B" : void 0 })),
    tr(cell("\u0639\u062F\u0645 \u0625\u062B\u0628\u0627\u062A \u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641", { w: 3200 }) + cell(String(s.missOut), { w: 1800, color: s.missOut ? "A61B1B" : void 0 }))
  ]), flagged = s.rows.filter((r) => r.lateMin || r.earlyMin || r.missIn || r.missOut), detail = flagged.length ? table([
    tr(["\u0627\u0644\u062A\u0627\u0631\u064A\u062E", "\u0628\u0635\u0645\u0629 \u0627\u0644\u062D\u0636\u0648\u0631", "\u0627\u0644\u062A\u0623\u062E\u064A\u0631", "\u0628\u0635\u0645\u0629 \u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641", "\u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u0627\u0644\u0645\u0628\u0643\u0631"].map((h) => cell(h, { b: !0, fill: "E8F0F8", w: 1000 })).join("")),
    ...flagged.map((r) => tr(cell(r.date, { w: 1000 }) + cell(r.inClock || "\u0644\u0645 \u064A\u0628\u0635\u0645", { w: 1000, color: r.missIn ? "A61B1B" : void 0 }) + cell(r.lateMin ? r.lateMin + " \u062F" : "\u2014", { w: 1000, color: r.lateMin ? "A61B1B" : void 0 }) + cell(r.outClock || "\u0644\u0645 \u064A\u0628\u0635\u0645", { w: 1000, color: r.missOut ? "A61B1B" : void 0 }) + cell(r.earlyMin ? r.earlyMin + " \u062F" : "\u2014", { w: 1000, color: r.earlyMin ? "A61B1B" : void 0 })))
  ]) : para(run("\u0644\u0627 \u062A\u0648\u062C\u062F \u0645\u0644\u0627\u062D\u0638\u0627\u062A \u062E\u0644\u0627\u0644 \u0627\u0644\u0634\u0647\u0631 \u2014 \u0634\u0643\u0631\u064B\u0627 \u0644\u0627\u0646\u0636\u0628\u0627\u0637\u0643\u0645.", { b: !0, color: "2E7D32" }));
  return {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + [
      d.schoolName ? para(run(d.schoolName, { b: !0, sz: 26 }), { jc: "center" }) : "",
      para(run("\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631", { b: !0, sz: 44, color: "1F5F8B" }), { jc: "center", after: 240 }),
      para(run("\u0627\u0644\u0623\u0633\u062A\u0627\u0630: ", { b: !0 }) + run(d.name + " \u0627\u0644\u0645\u062D\u062A\u0631\u0645")),
      para(run("\u0631\u0642\u0645 \u0627\u0644\u0645\u0648\u0638\u0641: ", { b: !0 }) + run(d.empNo || "\u2014")),
      d.spec ? para(run("\u0627\u0644\u0645\u0633\u0645\u0649 \u0627\u0644\u0648\u0638\u064A\u0641\u064A: ", { b: !0 }) + run(d.spec)) : "",
      para(run("\u0627\u0644\u062A\u0642\u0631\u064A\u0631 \u0627\u0644\u0634\u0647\u0631\u064A \u0644\u0644\u062D\u0636\u0648\u0631 \u0648\u0627\u0644\u0627\u0646\u0635\u0631\u0627\u0641 \u2014 \u0634\u0647\u0631 " + mName + " " + d.year, { b: !0, sz: 28 }), { after: 160 }),
      para(run("\u0646\u0641\u064A\u062F\u0643\u0645 \u0628\u0623\u0646\u0647 \u0645\u0646 \u062E\u0644\u0627\u0644 \u0627\u0644\u0645\u062A\u0627\u0628\u0639\u0629 \u0627\u0644\u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A\u0629 \u0644\u0645\u0624\u0634\u0631 \u0627\u0644\u0627\u0646\u0636\u0628\u0627\u0637 \u0627\u0644\u0645\u062F\u0631\u0633\u064A (\u062C\u0647\u0627\u0632 \u0627\u0644\u0628\u0635\u0645\u0629) \u062E\u0644\u0627\u0644 \u0627\u0644\u0634\u0647\u0631 \u0627\u0644\u0645\u0630\u0643\u0648\u0631 \u062A\u0628\u064A\u0651\u0646 \u0645\u0627 \u064A\u0644\u064A:")),
      summary,
      para("", { after: 120 }),
      para(run("\u062A\u0641\u0627\u0635\u064A\u0644 \u0627\u0644\u0623\u064A\u0627\u0645 \u0627\u0644\u062A\u064A \u0639\u0644\u064A\u0647\u0627 \u0645\u0644\u0627\u062D\u0638\u0627\u062A", { b: !0, sz: 26 })),
      detail,
      para("", { after: 400 }),
      para(run(d.principalName || "\u0646\u0627\u0635\u0631 \u063A\u0631\u064A\u0628 \u0627\u0644\u0628\u0644\u0648\u0634\u064A", { b: !0 }), { jc: "left", after: 0 }),
      para(run(d.principalTitle || "\u0645\u062F\u064A\u0631 \u0627\u0644\u0645\u062F\u0631\u0633\u0629"), { jc: "left" })
    ].join("") + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>'
  };
};
const DEFAULT_GUARDIAN_TEMPLATE = "السلام عليكم ورحمة الله وبركاته\nولي أمر الطالب {student} المحترم\nنحيطكم علمًا بأن ابنكم ({class}) تغيّب اليوم {day} {date} عن {count} حصة:\n{periods}\n\nنرجو منكم متابعة ابنكم والتواصل مع إدارة المدرسة عند وجود عذر.\n{school}";
const DEFAULT_MONTHLY_TEMPLATE = "السلام عليكم ورحمة الله\nالأستاذ {name} المحترم\nمرفق لكم خطاب «لمن يهمه الأمر» بالتقرير الشهري لحضوركم وانصرافكم لشهر {month} {year}:\n• أيام الدوام المحتسبة: {days}\n• أيام منضبطة: {onTime}\n• مرات التأخير الصباحي: {late} (إجمالي {lateTotal})\n• مرات الانصراف المبكر: {early}\n• عدم إثبات بصمة الحضور: {missIn}\n• عدم إثبات بصمة الانصراف: {missOut}\n{school}";
const DEFAULT_OPTIN_TEXT = "📩 يرجى الرد على هذه الرسالة بكلمة «تم» لتأكيد استقبال الإشعارات.";
const DEFAULT_SCHEDULE = [{"id":"assembly","label":"الطابور","from":"07:10","to":"07:25","kind":"break"},{"id":"1","label":"الأولى","from":"07:25","to":"08:05","kind":"class"},{"id":"2","label":"الثانية","from":"08:10","to":"08:50","kind":"class"},{"id":"3","label":"الثالثة","from":"08:55","to":"09:35","kind":"class"},{"id":"4","label":"الرابعة","from":"09:40","to":"10:20","kind":"class"},{"id":"recess","label":"الفسحة","from":"10:20","to":"10:45","kind":"break"},{"id":"5","label":"الخامسة","from":"10:45","to":"11:25","kind":"class"},{"id":"6","label":"السادسة","from":"11:30","to":"12:10","kind":"class"},{"id":"7","label":"السابعة","from":"12:15","to":"12:55","kind":"class"},{"id":"8","label":"الثامنة","from":"13:00","to":"13:40","kind":"class"}];

/* ---------------- Firebase REST ---------------- */
async function fb(path, init, query = "") {
  const r = await fetch(ROOT + "/" + path + ".json" + query, { ...init, headers: { "Content-Type": "application/json" } });
  if (!r.ok) throw new Error("firebase " + r.status);
  return r.json();
}
const fbPut = (p, v) => fb(p, { method: "PUT", body: JSON.stringify(v) });
const fbPost = (p, v) => fb(p, { method: "POST", body: JSON.stringify(v) });
const fbDel = (p) => fb(p, { method: "DELETE" });
const fbPatch = (p, v) => fb(p, { method: "PATCH", body: JSON.stringify(v) });
const q = (from, to) => "?orderBy=" + encodeURIComponent('"$key"') + "&startAt=" + encodeURIComponent(JSON.stringify(from)) + "&endAt=" + encodeURIComponent(JSON.stringify(to));

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
    // A reply (e.g. "\u062A\u0645") from a contact we wrote to is recorded so the school can see who confirmed.
    s.ev.on("messages.upsert", async ({ messages }) => {
      for (const m of messages || []) {
        try {
          if (m.key?.fromMe) continue;
          const jid = m.key?.remoteJid || ""; if (!jid.endsWith("@s.whatsapp.net")) continue;
          const num = jid.split("@")[0], t = m.message?.conversation || m.message?.extendedTextMessage?.text || "";
          if (!(await fb("whatsapp/contacts/" + num))) continue;
          await fbPatch("whatsapp/contacts/" + num, { lastReplyAt: Date.now(), ...(/\u062A\u0645/.test(t) ? { confirmedAt: Date.now() } : {}) });
        } catch {}
      }
    });
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
let CFG = {};
async function loadCfg() { try { CFG = (await fb("whatsapp/config")) || {}; } catch {} return CFG; }
/* Anti-ban pacing: every outgoing message waits at least delaySec (default 5s, minimum 3s) after the previous one, one at a time. */
let lastSend = 0, chain = Promise.resolve();
function paced(fn) {
  const run = chain.then(async () => {
    const gap = Math.max(3, Number(CFG.delaySec) || 5) * 1000 + Math.floor(Math.random() * 800);
    const wait = lastSend + gap - Date.now(); if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastSend = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}
/* The first message any number receives ends with the reply request (optInText) so a two-way chat exists. */
async function prep(to, message) {
  const num = String(to).replace(/\D/g, "");
  let first = false; try { first = !(await fb("whatsapp/contacts/" + num)); } catch {}
  return { num, first, text: withOptIn(String(message || ""), first, CFG.optInText ?? DEFAULT_OPTIN_TEXT) };
}
async function markContact(num, kind, first) {
  try { if (first) await fbPut("whatsapp/contacts/" + num, { firstAt: Date.now(), lastAt: Date.now(), kind: kind || "" }); else await fbPatch("whatsapp/contacts/" + num, { lastAt: Date.now() }); } catch {}
}
function sendText(to, message, kind) {
  return paced(async () => {
    if (!sock || !connected) throw new Error("whatsapp not connected");
    const p = await prep(to, message);
    await sock.sendMessage(jidOf(to), { text: p.text });
    await markContact(p.num, kind, p.first);
  });
}
function sendDoc(to, message, buffer, fileName, mimetype, kind) {
  return paced(async () => {
    if (!sock || !connected) throw new Error("whatsapp not connected");
    const p = await prep(to, message);
    if (p.text) await sock.sendMessage(jidOf(to), { text: p.text });
    await sleep(1200);
    await sock.sendMessage(jidOf(to), { document: buffer, mimetype, fileName });
    await markContact(p.num, kind, p.first);
  });
}
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docxBuffer = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

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
function sendPdf(to, message, svg, fileName, kind) { return paced(() => sendPdfNow(to, message, svg, fileName, kind)); }
async function sendPdfNow(to, message, svg, fileName, kind) {
  if (!sock || !connected) throw new Error("whatsapp not connected");
  const p = await prep(to, message); message = p.text;
  let png = null, pdf = null;
  try { png = await svgToPng(svg); } catch (e) { pdfError = "render: " + (e?.message || e); console.error(pdfError); }
  if (png) { try { pdf = await pngToPdf(png); pdfError = ""; } catch (e) { pdfError = "pdf: " + (e?.message || e); console.error(pdfError); } }
  if (message) await sock.sendMessage(jidOf(to), { text: String(message) });
  if (pdf) await sock.sendMessage(jidOf(to), { document: pdf, mimetype: "application/pdf", fileName: fileName || "\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631.pdf" });
  else if (png) await sock.sendMessage(jidOf(to), { image: png, caption: (fileName || "\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631").replace(/\.pdf$/i, "") });
  await markContact(p.num, kind, p.first);
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
  const cfg = await loadCfg();
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
      const r = await sendPdf(to, renameWording(fillTemplate(cfg.template || DEFAULT_NOTICE_TEMPLATE, vars)), svg, "\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631 - " + (u.name || uid) + " - " + date + ".pdf", "teacher");
      items[uid] = r.pdf ? { ok: true, name: u.name || uid } : { ok: true, name: u.name || uid, err: r.image ? "\u0623\u064F\u0631\u0633\u0644 \u0627\u0644\u062E\u0637\u0627\u0628 \u0643\u0635\u0648\u0631\u0629" : "\u0623\u064F\u0631\u0633\u0644\u062A \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0628\u062F\u0648\u0646 \u0627\u0644\u062E\u0637\u0627\u0628: " + r.pdfError }; sent++;
    } catch (e) { items[uid] = { ok: false, err: e?.message || "send failed", name: u.name || uid }; failed++; }
  }
  if (cfg.summaryEnabled !== false) {
    const summary = buildManagerSummary(rows, date, day, { sent, failed });
    for (const n of managerNumbers(cfg)) { try { await sendText(n, summary, "manager"); } catch (e) { failed++; } }
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
    for (const t of targets) { try { await sendText(t, m.message, m.kind || "queue"); } catch (e) { ok = false; err = e?.message || "send failed"; } }
    if (ok || (m.tries || 0) >= 4) { await fbDel("whatsapp/queue/" + id); await log({ kind: m.kind || "queue", to: m.to, ok, err }); }
    else await fbPut("whatsapp/queue/" + id + "/tries", (m.tries || 0) + 1);
  }
}

/* ---------------- guardians of absent students ---------------- */
async function guardianList(date) {
  const r = q(date + "_", date + "_\uf8ff");
  const [students, att, logs, meta, schedule, school] = await Promise.all([fb("students"), fb("attendance", undefined, r), fb("attendanceLog", undefined, r), fb("attendanceMeta", undefined, r), fb("settings/schedule"), fb("settings/schoolName")]);
  return { list: collectAbsences(date, students, att, logs, meta, Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_SCHEDULE), school: school || "" };
}
// mode "auto": first run of the day \u00B7 "next": the next batch of unsent students \u00B7 ids: chosen students (manual, no limit).
async function runGuardian(date, opts = {}) {
  const cfg = await loadCfg();
  const limit = opts.ids ? Infinity : Math.max(1, Number(cfg.guardianLimit) || 50);
  const { list, school } = await guardianList(date);
  const day = dayNameAr(date), base = "whatsapp/guardianRuns/" + date;
  const prev = (await fb(base)) || {}, items = prev.items || {};
  await fbPatch(base, { status: "running", at: Date.now(), by: opts.by || "auto" });
  let sentNow = 0;
  for (const a of list) {
    const old = items[a.id];
    const to = waNumber(a.phone);
    const info = { name: a.name, cls: a.classSection, periods: a.periods.length, to: to || "" };
    if (opts.ids) { if (!opts.ids.includes(a.id)) { if (!old) items[a.id] = { ...info, status: "held", err: "\u0644\u0645 \u064A\u064F\u0631\u0633\u0644 \u0628\u0639\u062F" }; continue; } }
    else if (old && old.status === "sent") continue;
    if (!to) { items[a.id] = { ...info, status: "nophone", err: "\u0644\u0627 \u064A\u0648\u062C\u062F \u0631\u0642\u0645 \u0648\u0644\u064A \u0623\u0645\u0631" }; continue; }
    if (sentNow >= limit) { items[a.id] = { ...info, status: "held", err: "\u062A\u062C\u0627\u0648\u0632 \u0627\u0644\u062D\u062F (" + limit + " \u0631\u0633\u0627\u0644\u0629) \u2014 \u064A\u0645\u0643\u0646 \u0625\u0631\u0633\u0627\u0644\u0647 \u064A\u062F\u0648\u064A\u064B\u0627" }; continue; }
    sentNow++;
    try { await sendText(to, guardianMessage(cfg.guardianTemplate || DEFAULT_GUARDIAN_TEMPLATE, a, { date, day, school }), "guardian"); items[a.id] = { ...info, status: "sent", at: Date.now() }; }
    catch (e) { items[a.id] = { ...info, status: "failed", err: e?.message || "send failed", at: Date.now() }; }
    await fbPut(base + "/items/" + a.id, items[a.id]).catch(() => {});
  }
  const vals = Object.values(items), count = (s) => vals.filter((x) => x.status === s).length;
  const res = { status: "done", at: Date.now(), by: opts.by || "auto", total: list.length, sent: count("sent"), failed: count("failed"), held: count("held"), nophone: count("nophone"), items };
  await fbPut(base, res);
  if (!opts.ids && opts.by === "auto" && cfg.guardianSummary !== false && list.length) {
    const msg = guardianSummary(date, day, res.total, res.sent, res.failed, res.held, res.nophone);
    for (const n of managerNumbers(cfg)) { try { await sendText(n, msg, "manager"); } catch {} }
  }
  return res;
}

/* ---------------- monthly report (Word) for every teacher ---------------- */
async function monthData(year, month) {
  const ym = year + "-" + String(month).padStart(2, "0");
  const att = await fb("staffAttendance", undefined, q(ym + "-01", ym + "-31"));
  const days = Object.keys(att || {}).filter((d) => att[d] && Object.keys(att[d]).length);
  return { ym, att: att || {}, days };
}
async function runMonthly(year, month, opts = {}) {
  const cfg = await loadCfg();
  const { ym, att, days } = await monthData(year, month);
  if (!days.length) throw Object.assign(new Error("\u0644\u0627 \u062A\u0648\u062C\u062F \u0628\u064A\u0627\u0646\u0627\u062A \u0628\u0635\u0645\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u0634\u0647\u0631 \u2014 \u0644\u0627 \u064A\u0645\u0643\u0646 \u0627\u0644\u0625\u0631\u0633\u0627\u0644"), { status: 400 });
  const [users, school] = await Promise.all([fb("users"), fb("settings/schoolName")]);
  const base = "whatsapp/monthlyRuns/" + ym, items = {};
  if (!opts.testTo) await fbPut(base, { status: "running", at: Date.now(), by: opts.by || "manual" });
  let sent = 0, failed = 0;
  const list = Object.entries(users || {}).filter(([uid, u]) => u && u.role !== "admin" && u.role !== "developer" && (!opts.uids || opts.uids.includes(uid)));
  for (const [uid, u] of list) {
    const stats = monthStats(att, uid, cfg);
    if (!Object.values(att).some((d) => d && d[uid]) && !u.empNo) continue;
    const name = u.name || uid, spec = (u.title || u.specialization || "").trim();
    const to = opts.testTo ? waNumber(opts.testTo) : waNumber(u.whatsapp, u.countryCode || "+968");
    if (!to) { items[uid] = { ok: false, name, err: "\u0644\u0627 \u064A\u0648\u062C\u062F \u0631\u0642\u0645 \u0648\u0627\u062A\u0633\u0627\u0628" }; failed++; continue; }
    try {
      const file = docxBuffer(buildMonthlyDocx({ schoolName: school || "", name, empNo: u.empNo, spec, year, month, stats, principalName: cfg.principalName, principalTitle: cfg.principalTitle }));
      const msg = fillVars(cfg.monthlyTemplate || DEFAULT_MONTHLY_TEMPLATE, monthlyVars(name, u.empNo || "", year, month, stats, school || ""));
      await sendDoc(to, (opts.testTo ? "\u{1f9ea} \u0631\u0633\u0627\u0644\u0629 \u062A\u062C\u0631\u064A\u0628\u064A\u0629\n" : "") + msg, file, "\u0644\u0645\u0646 \u064A\u0647\u0645\u0647 \u0627\u0644\u0623\u0645\u0631 - " + name + " - " + ym + ".docx", DOCX, "monthly");
      items[uid] = { ok: true, name, at: Date.now() }; sent++;
    } catch (e) { items[uid] = { ok: false, name, err: e?.message || "send failed" }; failed++; }
    if (!opts.testTo) await fbPut(base + "/items/" + uid, items[uid]).catch(() => {});
    if (opts.testTo) break;
  }
  const res = { status: "done", at: Date.now(), by: opts.by || "manual", days: days.length, sent, failed, items };
  if (!opts.testTo) await fbPut(base, res);
  return res;
}

let busy = false;
async function tick() {
  if (busy || !connected) return;
  busy = true;
  try {
    const cfg = await loadCfg();
    if (!cfg || !(await isActive(cfg))) return;
    await processQueue(cfg);
    const now = omanNow(), workDay = (cfg.workDays || [0, 1, 2, 3, 4]).includes(now.dow);
    const t = toMin(cfg.time);
    if (cfg.enabled !== false && workDay && now.min >= t && now.min <= t + 240 && !(await fb("whatsapp/runs/" + now.date + "/status"))) {
      // the fingerprint report may not be uploaded yet \u2014 then try again next tick
      if (await fb("staffAttendance/" + now.date, undefined, "?shallow=true")) {
        await fbPut("whatsapp/runs/" + now.date, { status: "running", at: Date.now() });
        const res = await runDaily(now.date);
        await fbPut("whatsapp/runs/" + now.date, { ...res, status: "done", at: Date.now() });
      }
    }
    const g = toMin(cfg.guardianTime || "14:00");
    if (cfg.guardianEnabled !== false && workDay && now.min >= g && now.min <= g + 240 && !(await fb("whatsapp/guardianRuns/" + now.date + "/status"))) {
      await runGuardian(now.date, { by: "auto" });
    }
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
  try { const { to, message } = req.body || {}; if (!to || !message) return res.status(400).json({ error: "to & message required" }); await loadCfg(); await sendText(to, message, req.body?.kind || "manual"); res.json({ ok: true }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/send-pdf", auth, async (req, res) => {
  try { const { to, message, svg, doc, fileName } = req.body || {}; const pic = svg || (doc ? buildNoticeSvg(doc) : ""); if (!to || !pic) return res.status(400).json({ error: "to & svg required" }); const r = await sendPdf(to, message, pic, fileName, "test"); await log({ kind: "test", to, ok: true, pdf: r.pdf, err: r.pdfError }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(e?.message === "whatsapp not connected" ? 503 : 500).json({ error: e?.message || "send failed" }); }
});
app.post("/run-daily", auth, async (req, res) => {
  try { const date = req.body?.date || omanNow().date; const r = await runDaily(date, { force: !!req.body?.force, by: req.body?.by || "manual" }); await fbPut("whatsapp/runs/" + date, { ...r, status: "done", at: Date.now() }); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e?.message || "run failed" }); }
});
app.post("/guardian-run", auth, async (req, res) => {
  const date = req.body?.date || omanNow().date, ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined;
  if (ids) { try { const r = await runGuardian(date, { ids, by: "manual" }); return res.json({ ok: true, ...r, items: undefined }); } catch (e) { return res.status(500).json({ error: e?.message || "run failed" }); } }
  runGuardian(date, { by: req.body?.by || "manual" }).catch((e) => console.error("guardian", e));
  res.json({ ok: true, started: true });
});
app.post("/send-monthly", auth, async (req, res) => {
  const year = Number(req.body?.year), month = Number(req.body?.month);
  if (!year || !(month >= 1 && month <= 12)) return res.status(400).json({ error: "\u0627\u062E\u062A\u0631 \u0627\u0644\u0633\u0646\u0629 \u0648\u0627\u0644\u0634\u0647\u0631" });
  try {
    const { days } = await monthData(year, month);
    if (!days.length) return res.status(400).json({ error: "\u0644\u0627 \u062A\u0648\u062C\u062F \u0628\u064A\u0627\u0646\u0627\u062A \u0628\u0635\u0645\u0629 \u0641\u064A \u0647\u0630\u0627 \u0627\u0644\u0634\u0647\u0631 \u2014 \u0644\u0627 \u064A\u0645\u0643\u0646 \u0627\u0644\u0625\u0631\u0633\u0627\u0644" });
    const opts = { testTo: req.body?.testTo, uids: Array.isArray(req.body?.uids) ? req.body.uids.map(String) : undefined, by: "manual" };
    if (opts.testTo || (opts.uids && opts.uids.length === 1)) { const r = await runMonthly(year, month, opts); return res.json({ ok: true, ...r, items: undefined }); }
    runMonthly(year, month, opts).catch((e) => console.error("monthly", e));
    res.json({ ok: true, started: true, days: days.length });
  } catch (e) { res.status(e?.status || 500).json({ error: e?.message || "failed" }); }
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
