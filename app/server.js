import express from "express";
import session from "express-session";
import helmet from "helmet";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const app = express();
const dataDir = process.env.DATA_DIR || "./data";
const maxBytes = Number(process.env.MAX_FILE_BYTES || 950_000_000);
fs.mkdirSync(dataDir, { recursive: true });
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 *  60 * 60 * 1000 }
}));
app.use(express.static("public"));

const jobs = [];
const requireAuth = (req, res, next) => req.session?.ok ? next() : res.status(401).json({ error: "ابتدا وارد پنل شوید." });
const safeEqual = (a,b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x,y);
};
app.get("/health", (_req,res) => res.json({ ok:true, app:"FileStorm" }));
app.post("/api/login", (req,res) => {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || !safeEqual(req.body.password || "", expected)) return res.status(401).json({ error:"رمز نادرست است." });
  req.session.ok = true; res.json({ ok:true });
});
app.post("/api/logout", requireAuth, (req,res) => req.session.destroy(() => res.json({ ok:true })));
app.get("/api/jobs", requireAuth, (_req,res) => res.json(jobs.slice().reverse().slice(0,50)));

function assertPublic(ipText) {
  const ip = ipaddr.parse(ipText);
  if (ip.range() !== "unicast") throw new Error("لینک به نشانی خصوصی یا محلی اشاره می‌کند و مجاز نیست.");
}
async function validateUrl(raw) {
  const u = new URL(raw);
  if (!["http:","https:"].includes(u.protocol) || u.username || u.password) throw new Error("فقط لینک عمومی HTTP/HTTPS مجاز است.");
  const records = await dns.lookup(u.hostname, { all:true });
  if (!records.length) throw new Error("دامنه پیدا نشد.");
  for (const r of records) assertPublic(r.address);
  return u;
}
async function download(job) {
  let current = job.url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DOWNLOAD_TIMEOUT_MS || 3_600_000));
  try {
    for (let hop=0; hop<5; hop++) {
      await validateUrl(current);
      const response = await fetch(current, { redirect:"manual", signal:controller.signal });
      if ([301,302,303,307,308].includes(response.status)) {
        const loc = response.headers.get("location");
        if (!loc) throw new Error("ریدایرکت نامعتبر است.");
        current = new URL(loc,current).toString(); continue;
      }
      if (!response.ok || !response.body) throw new Error("دانلود ناموفق: HTTP " + response.status);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > maxBytes) throw new Error("حجم فایل از سقف این نسخه بیشتر است.");
      const fileName = path.basename(new URL(current).pathname) || "download.bin";
      const safeName = fileName.replace(/[^\p{L}\p{N}._-]/gu,"_").slice(0,120) || "download.bin";
      const target = path.join(dataDir, job.id + "-" + safeName);
      let received = 0;
      const meter = new (await import("node:stream")).Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          if (received > maxBytes) return cb(new Error("حجم فایل از سقف این نسخه بیشتر است."));
          job.progress = { received, total: declared || null, percent: declared ? Math.min(99,Math.floor(received/declared*100)) : null };
          cb(null,chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(target,{flags:"wx"}));
      job.fileName = safeName; job.bytes = received; job.filePath = target;
      job.progress = { received, total: declared || received, percent:100 };
      job.status = "downloaded_waiting_for_publisher";
      job.message = "دانلود کامل شد؛ اتصال انتشار هنوز فعال نشده است.";
      return;
    }
    throw new Error("تعداد تغییر مسیر لینک بیش از حد است.");
  } finally { clearTimeout(timeout); }
}
let busy = false;
async function runQueue() {
  if (busy) return;
  busy = true;
  try {
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      job.status = "downloading";
      try { await download(job); }
      catch (e) { job.status = "failed"; job.message = e.message; }
    }
  } finally { busy = false; }
}
app.post("/api/jobs", requireAuth, (req,res) => {
  const url = String(req.body.url || "").trim();
  const channelId = String(req.body.channelId || "").trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error:"لینک مستقیم HTTP/HTTPS وارد کنید." });
  if (!channelId) return res.status(400).json({ error:"شناسه کانال را وارد کنید." });
  if (jobs.filter(j=>["queued","downloading"].includes(j.status)).length >= 2) return res.status(429).json({error:"صف موقتاً پر است؛ کمی بعد تلاش کنید."});
  const job = { id:crypto.randomUUID().slice(0,8), url, channelId, status:"queued", progress:{percent:0}, createdAt:new Date().toISOString(), message:"در صف دانلود" };
  jobs.push(job); res.json({id:job.id,status:job.status}); void runQueue();
});
const port = Number(process.env.PORT || 3000);
app.listen(port,"0.0.0.0",()=>console.log("FileStorm listening on "+port));
