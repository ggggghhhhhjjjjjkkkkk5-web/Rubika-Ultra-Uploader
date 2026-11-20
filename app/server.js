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
const botToken = String(process.env.BOT_TOKEN || "").trim();
const targetChannelId = String(process.env.TARGET_CHANNEL_ID || "").trim();
const botWebhookSecret = String(process.env.BOT_WEBHOOK_SECRET || process.env.SESSION_SECRET || "").trim();
const allowedBotUsers = new Set(String(process.env.BOT_ALLOWED_USERS || "").split(",").map(x=>x.trim()).filter(Boolean));
const rubikaChunkBytes = Math.min(Number(process.env.RUBIKA_CHUNK_BYTES || 49 * 1024 * 1024), 49 * 1024 * 1024);
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
  let response;
  try {
    response = await axios.post(apiUrl(token, method), body, { timeout: 30000, maxRedirects: 0 });
  } catch (e) {
    const payload = e?.response?.data;
    const detail = payload?.status_det || payload?.message || e?.message || "ارتباط با API برقرار نشد";
    throw new Error("خطای " + method + ": " + String(detail).slice(0,180));
  }
  const data = response.data;
  if (!data || data.status !== "OK") {
    const detail = String(data?.status_det || data?.message || "پاسخ نامعتبر از سرویس بات");
    throw new Error("خطای " + method + ": " + detail.slice(0,180));
  }
  return data.data || {};
}
async function download(job, onProgress = async () => {}) {
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
      const disposition = response.headers.get("content-disposition") || "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
      let headerName = "";
      try { headerName = encodedName ? decodeURIComponent(encodedName) : (plainName || ""); } catch {}
      const urlName = path.basename(decodeURIComponent(new URL(current).pathname)) || "";
      const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const mimeExtensions = { "video/mp4":".mp4", "video/webm":".webm", "video/quicktime":".mov", "audio/mpeg":".mp3", "audio/mp4":".m4a", "image/jpeg":".jpg", "image/png":".png", "image/webp":".webp", "application/pdf":".pdf", "application/zip":".zip" };
      let fileName = path.basename(headerName || urlName || "download");
      if (!path.extname(fileName) && mimeExtensions[mime]) fileName += mimeExtensions[mime];
      if (!path.extname(fileName)) fileName += ".bin";
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
          void onProgress(job.progress.percent, received, declared || null);
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
async function publish(job, token, onProgress = async () => {}) {
  job.status = "checking_bot";
  await botCall(token, "getMe");
  const parts = Math.ceil(job.bytes / rubikaChunkBytes);
  let uploadedBytes = 0;
  const sentIds = [];
  for (let part = 0; part < parts; part++) {
    const start = part * rubikaChunkBytes;
    const end = Math.min(job.bytes - 1, start + rubikaChunkBytes - 1);
    const partBytes = end - start + 1;
    job.status = "requesting_upload";
    const requested = await botCall(token, "requestSendFile", { type:"File" });
    if (!requested.upload_url) throw new Error("سرویس بات نشانی آپلود برنگرداند.");
    const uploadUrl = new URL(requested.upload_url);
    if (uploadUrl.protocol !== "https:") throw new Error("نشانی آپلود امن نیست.");
    job.status = "uploading";
    const form = new FormData();
    const partName = parts > 1 ? job.fileName + ".part" + String(part + 1).padStart(3,"0") : job.fileName;
    form.append("file", fs.createReadStream(job.filePath,{start,end}), { filename:partName, knownLength:partBytes });
    const uploaded = await axios.post(uploadUrl.toString(), form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 0, maxRedirects: 0,
      onUploadProgress: event => {
        const current = Math.min(partBytes, Number(event.loaded || 0));
        const percent = Math.min(99,Math.floor((uploadedBytes + current) / job.bytes * 100));
        void onProgress(percent, uploadedBytes + current, job.bytes, part + 1, parts);
      }
    });
    const fileId = uploaded.data?.data?.file_id || uploaded.data?.file_id;
    if (!fileId) throw new Error("آپلود انجام شد اما شناسه فایل دریافت نشد.");
    job.status = "sending";
    const payload = { chat_id:job.channelId, file_id:fileId };
    const caption = [job.caption, parts > 1 ? "بخش " + (part + 1) + " از " + parts : ""].filter(Boolean).join("\n");
    if (caption) payload.text = caption;
    const sent = await botCall(token, "sendFile", payload);
    if (!sent.message_id) throw new Error("فایل آپلود شد اما API شناسه پیام برنگرداند؛ شناسه کانال و دسترسی بات را بررسی کنید.");
    sentIds.push(sent.message_id);
    uploadedBytes += partBytes;
    void onProgress(Math.floor(uploadedBytes / job.bytes * 100), uploadedBytes, job.bytes, part + 1, parts);
  }
  job.messageId = sentIds[sentIds.length - 1];
  job.messageIds = sentIds;
  job.status = "sent";
  job.message = parts > 1
    ? "فایل به " + parts + " بخش تقسیم و همه بخش‌ها در کانال ارسال شدند."
    : "فایل با موفقیت در کانال ارسال شد.";
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
        await download(job, (percent, received, total) => updateBotProgress(job,"دانلود روی سرور",percent,received,total));
        await updateBotProgress(job,"دانلود کامل شد؛ شروع انتقال به کانال",100,job.bytes,job.bytes);
        await publish(job, token, (percent, sent, total, part, parts) => updateBotProgress(job,parts > 1 ? "آپلود بخش " + part + " از " + parts : "آپلود به کانال",percent,sent,total));
        await updateBotProgress(job,"انتقال کامل شد؛ فایل در کانال منتشر شد",100,job.bytes,job.bytes);
      } catch (e) {
        job.status = "failed";
        job.message = String(e?.message || "خطای نامشخص").slice(0,220);
        console.error("[FileStorm job " + job.id + " at " + job.status + "] " + job.message);
        await updateBotProgress(job,"خطا: " + job.message,null);
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
app.post("/api/bot/check-channel", requireAuth, async (req,res) => {
  const token = String(req.body.token || "").trim();
  const channelId = String(req.body.channelId || "").trim();
  if (!token || !channelId) return res.status(400).json({error:"توکن بات و شناسه کانال را وارد کنید."});
  try {
    const data = await botCall(token,"getChat",{chat_id:channelId});
    const chat = data.chat || data;
    const type = chat.chat_type || chat.type || "";
    const title = chat.title || chat.name || chat.username || "کانال";
    if (type && String(type).toLowerCase() !== "channel") {
      return res.status(400).json({error:"این شناسه مربوط به کانال نیست (نوع برگشتی: " + type + ")."});
    }
    const sent = await botCall(token,"sendMessage",{chat_id:channelId,text:"FileStorm: بررسی دسترسی ارسال بات با موفقیت انجام شد."});
    if (!sent.message_id) throw new Error("پیام آزمایشی ارسال نشد؛ بات را در کانال مدیر کنید و مجوز ارسال پیام بدهید.");
    res.json({ok:true,title,type,messageId:sent.message_id});
  } catch(e) { res.status(400).json({error:String(e.message || "بررسی کانال ناموفق بود").slice(0,220)}); }
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
async function updateBotProgress(job, stage, percent, done, total) {
  if (!job.botChatId || !job.progressMessageId || !job.botToken) return;
  const now = Date.now();
  if (percent !== 100 && now - (job.lastProgressAt || 0) < 1800) return;
  job.lastProgressAt = now;
  const p = Number.isFinite(percent) ? Math.max(0,Math.min(100,percent)) : null;
  const bar = p === null ? "" : "\n" + "█".repeat(Math.floor(p/5)) + "░".repeat(20-Math.floor(p/5)) + " " + p + "%";
  const size = total ? "\n" + (done/1048576).toFixed(1) + " / " + (total/1048576).toFixed(1) + " MB" : "";
  const text = "📦 FileStorm\n" + stage + bar + size;
  try {
    await botCall(job.botToken,"editMessageText",{chat_id:job.botChatId,message_id:job.progressMessageId,text});
  } catch (e) {
    if (!job.progressEditWarned) { job.progressEditWarned = true; console.warn("Bot progress edit failed:",e.message); }
  }
}
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function handleBotUpdate(update) {
  const message = update?.new_message || update?.update?.new_message || update?.message;
  const chatId = update?.chat_id || update?.update?.chat_id || message?.chat_id;
  if (!message || !chatId || !message.text) return;
  const senderId = String(message.sender_id || "");
  if (allowedBotUsers.size && !allowedBotUsers.has(senderId)) return;
  const text = String(message.text).trim();
  if (text === "/start" || text === "/help") {
    await botCall(botToken,"sendMessage",{chat_id:chatId,text:"سلام! لینک مستقیم فایل را همین‌جا بفرست تا سرور آن را دانلود و به کانال مقصد منتقل کند.\n\nبرای شروع، یک لینک HTTP/HTTPS مستقیم ارسال کن."});
    return;
  }
  if (text === "/id") {
    await botCall(botToken,"sendMessage",{chat_id:chatId,text:"شناسه گفت‌وگوی شما: " + chatId + (senderId ? "\nشناسه کاربری: " + senderId : "")});
    return;
  }
  let chatType = "";
  try {
    const info = await botCall(botToken,"getChat",{chat_id:chatId});
    const chat = info.chat || info;
    chatType = String(chat.chat_type || chat.type || "");
  } catch {}
  if (chatType && chatType.toLowerCase() !== "user") return;
  if (!targetChannelId) {
    await botCall(botToken,"sendMessage",{chat_id:chatId,text:"سرویس هنوز شناسه کانال مقصد را دریافت نکرده است. مدیر باید TARGET_CHANNEL_ID را در تنظیمات سرور ثبت کند."});
    return;
  }
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  if (!match) {
    await botCall(botToken,"sendMessage",{chat_id:chatId,text:"لطفاً لینک مستقیم فایل را بفرست. لینک باید بدون صفحه واسطه، قابل دانلود باشد."});
    return;
  }
  const active = jobs.filter(j=>["queued","downloading","checking_bot","requesting_upload","uploading","sending"].includes(j.status)).length;
  if (active >= 2) {
    await botCall(botToken,"sendMessage",{chat_id:chatId,text:"صف انتقال فعلاً پر است؛ چند دقیقه دیگر دوباره تلاش کن."});
    return;
  }
  const url = match[0].replace(/[),.!?]+$/g,"");
  const reply = await botCall(botToken,"sendMessage",{chat_id:chatId,text:"درخواست دریافت شد.\nدر حال آماده‌سازی دانلود..."});
  const progressMessageId = reply.message_id || reply.message?.message_id;
  if (!progressMessageId) throw new Error("پیام وضعیت ساخته نشد.");
  const job = {
    id:crypto.randomUUID().slice(0,8), url, channelId:targetChannelId, caption:"",
    status:"queued", progress:{percent:0}, createdAt:new Date().toISOString(),
    message:"در صف پردازش", botChatId:chatId, botToken, progressMessageId
  };
  secrets.set(job.id,botToken);
  jobs.push(job);
  void runQueue();
}
app.post("/rubika/update/:secret", (req,res) => {
  if (!botWebhookSecret || req.params.secret !== botWebhookSecret) return res.sendStatus(404);
  const update = req.body?.update || req.body;
  res.status(200).json({ok:true});
  void handleBotUpdate(update).catch(e=>console.error("Webhook update handling failed:",e.message));
});
async function pollRubikaBot() {
  if (!botToken) { console.log("FileStorm bot polling disabled: BOT_TOKEN is not configured."); return; }
  if (!targetChannelId) console.warn("FileStorm bot: TARGET_CHANNEL_ID is not configured.");
  if (botWebhookSecret) {
    try {
      const base = String(process.env.PUBLIC_BASE_URL || "https://filestorm-test.onrender.com").replace(/\/$/,"");
      await botCall(botToken,"updateBotEndpoints",{url:base + "/rubika/update/" + encodeURIComponent(botWebhookSecret),type:"ReceiveUpdate"});
      console.log("FileStorm Rubika webhook registered.");
      return;
    } catch (e) {
      console.warn("Rubika webhook registration failed; falling back to polling:",e.message);
    }
  }
  let offsetId;
  let failures = 0;
  try {
    await botCall(botToken,"getMe");
    console.log("FileStorm Rubika chat bot connected.");
  } catch (e) {
    console.error("FileStorm bot token check failed:",e.message);
    return;
  }
  while (true) {
    try {
      const payload = {limit:100};
      if (offsetId) payload.offset_id = offsetId;
      const data = await botCall(botToken,"getUpdates",payload);
      const updates = Array.isArray(data.updates) ? data.updates : [];
      for (const update of updates) {
        try { await handleBotUpdate(update); }
        catch (e) { console.error("Bot update handling failed:",e.message); }
      }
      if (data.next_offset_id) offsetId = data.next_offset_id;
      failures = 0;
      if (!updates.length) await sleep(1800);
    } catch (e) {
      failures++;
      console.error("Rubika polling error:",e.message);
      await sleep(Math.min(30000,1500 * failures));
    }
  }
}
if (botToken) void pollRubikaBot();
const port = Number(process.env.PORT || 3000);
app.listen(port,"0.0.0.0",()=>console.log("FileStorm publisher ready on "+port));
