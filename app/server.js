import express from "express";
import session from "express-session";
import helmet from "helmet";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import axios from "axios";
import FormData from "form-data";

const app = express();
const dataDir = process.env.DATA_DIR || "./data";
const maxBytes = Number(process.env.MAX_FILE_BYTES || 950_000_000);
fs.mkdirSync(dataDir, { recursive: true });
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "30kb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static("public"));

const jobs = [];
const secrets = new Map();
const requireAuth = (req, res, next) => req.session?.ok ? next() : res.status(401).json({ error: "ابتدا وارد پنل شوید." });
const safeEqual = (a,b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x,y);
};
app.get("/health", (_req,res) => res.json({ ok:true, app:"FileStorm", publisher:"rubika-bot-api" }));
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
function apiUrl(token, method) {
  return "https://botapi.rubika.ir/v3/" + encodeURIComponent(token) + "/" + method;
}
async function botCall(token, method, body = {}) {
  const response = await axios.post(apiUrl(token, method), body, { timeout: 30000, maxRedirects: 0 });
  const data = response.data;
  if (!data || data.status !== "OK") {
    const detail = String(data?.status_det || data?.message || "پاسخ نامعتبر از سرویس بات");
    throw new Error("خطای API بات: " + detail.slice(0,180));
  }
  return data.data || {};
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
      const out = fs.createWriteStream(target,{flags:"wx"});
      let received = 0;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > maxBytes) throw new Error("حجم فایل از سقف این نسخه بیشتر است.");
          if (!out.write(Buffer.from(chunk))) await new Promise((resolve,reject)=>{out.once("drain",resolve);out.once("error",reject);});
          job.progress = { received, total: declared || null, percent: declared ? Math.min(99,Math.floor(received/declared*100)) : null };
        }
        await new Promise((resolve,reject)=>out.end(err=>err?reject(err):resolve()));
      } catch (e) { out.destroy(); await fs.promises.rm(target,{force:true}); throw e; }
      if (!received) { await fs.promises.rm(target,{force:true}); throw new Error("فایل دریافتی خالی است."); }
      job.fileName = safeName; job.bytes = received; job.filePath = target;
      job.progress = { received, total: declared || received, percent:100 };
      return target;
    }
    throw new Error("تعداد تغییر مسیر لینک بیش از حد است.");
  } finally { clearTimeout(timeout); }
}
async function publish(job, token) {
  job.status = "checking_bot";
  await botCall(token, "getMe");
  job.status = "requesting_upload";
  const requested = await botCall(token, "requestSendFile", { type:"File" });
  if (!requested.upload_url) throw new Error("سرویس بات نشانی آپلود برنگرداند.");
  const uploadUrl = new URL(requested.upload_url);
  if (uploadUrl.protocol !== "https:") throw new Error("نشانی آپلود امن نیست.");
  job.status = "uploading";
  const form = new FormData();
  form.append("file", fs.createReadStream(job.filePath), { filename:job.fileName, knownLength:job.bytes });
  const uploaded = await axios.post(uploadUrl.toString(), form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 0, maxRedirects: 0
  });
  const fileId = uploaded.data?.data?.file_id || uploaded.data?.file_id;
  if (!fileId) throw new Error("آپلود انجام شد اما شناسه فایل دریافت نشد.");
  job.status = "sending";
  const sent = await botCall(token, "sendFile", { chat_id:job.channelId, file_id:fileId, text:job.caption || "" });
  if (!sent.message_id) throw new Error("پاسخ ارسال فایل شناسه پیام نداشت؛ دسترسی بات به کانال را بررسی کنید.");
  job.messageId = sent.message_id;
  job.status = "sent";
  job.message = "فایل با موفقیت در کانال ارسال شد.";
}
let busy = false;
async function runQueue() {
  if (busy) return;
  busy = true;
  try {
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      const token = secrets.get(job.id);
      try {
        job.status = "downloading";
        await download(job);
        await publish(job, token);
      } catch (e) {
        job.status = "failed";
        job.message = String(e?.message || "خطای نامشخص").slice(0,220);
      } finally {
        secrets.delete(job.id);
        if (job.filePath) {
          await fs.promises.rm(job.filePath,{force:true}).catch(()=>{});
          delete job.filePath;
        }
      }
    }
  } finally { busy = false; }
}
app.post("/api/bot/check", requireAuth, async (req,res) => {
  const token = String(req.body.token || "").trim();
  if (!token || token.length > 500) return res.status(400).json({error:"توکن بات را وارد کنید."});
  try {
    const data = await botCall(token,"getMe");
    const bot = data.bot || data;
    res.json({ok:true,name:bot.name || bot.username || "بات متصل شد",username:bot.username || ""});
  } catch(e) { res.status(400).json({error:String(e.message || "اتصال ناموفق").slice(0,220)}); }
});
app.post("/api/jobs", requireAuth, (req,res) => {
  const url = String(req.body.url || "").trim();
  const channelId = String(req.body.channelId || "").trim();
  const token = String(req.body.token || "").trim();
  const caption = String(req.body.caption || "").trim().slice(0,1000);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error:"لینک مستقیم HTTP/HTTPS وارد کنید." });
  if (!channelId) return res.status(400).json({ error:"شناسه کانال را وارد کنید." });
  if (!token || token.length > 500) return res.status(400).json({error:"توکن بات را وارد کنید."});
  if (jobs.filter(j=>["queued","downloading","checking_bot","requesting_upload","uploading","sending"].includes(j.status)).length >= 2)
    return res.status(429).json({error:"صف موقتاً پر است؛ کمی بعد تلاش کنید."});
  const job = { id:crypto.randomUUID().slice(0,8), url, channelId, caption, status:"queued", progress:{percent:0}, createdAt:new Date().toISOString(), message:"در صف پردازش" };
  secrets.set(job.id,token);
  jobs.push(job);
  res.json({id:job.id,status:job.status});
  void runQueue();
});
const port = Number(process.env.PORT || 3000);
app.listen(port,"0.0.0.0",()=>console.log("FileStorm publisher ready on "+port));
