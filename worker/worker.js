import { Worker } from "bullmq";
import Redis from "ioredis";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { createWriteStream } from "node:fs";
import { publishFile } from "../app/rubika-adapter.js";

const connection = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const dataDir = process.env.DATA_DIR || "./data";
fs.mkdirSync(dataDir, { recursive: true });
const maxBytes = Number(process.env.MAX_FILE_BYTES || 15_000_000_000);

function assertPublicAddress(address) {
  const ip = ipaddr.parse(address);
  if (ip.range() !== "unicast") throw new Error("آدرس مقصد لینک عمومی نیست.");
}
async function validateUrl(raw) {
  const u = new URL(raw);
  if (!["http:","https:"].includes(u.protocol)) throw new Error("فقط لینک HTTP/HTTPS مجاز است.");
  if (u.username || u.password) throw new Error("لینک دارای اطلاعات ورود پذیرفته نمی‌شود.");
  const records = await dns.lookup(u.hostname, { all: true });
  if (!records.length) throw new Error("دامنه پیدا نشد.");
  for (const r of records) assertPublicAddress(r.address);
  return u;
}
async function download(url, target, job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.DOWNLOAD_TIMEOUT_MS || 7_200_000));
  try {
    let current = url;
    for (let hop=0; hop<5; hop++) {
      await validateUrl(current);
      const response = await fetch(current, { redirect: "manual", signal: controller.signal });
      if ([301,302,303,307,308].includes(response.status)) {
        const loc = response.headers.get("location");
        if (!loc) throw new Error("ریدایرکت نامعتبر.");
        current = new URL(loc, current).toString(); continue;
      }
      if (!response.ok || !response.body) throw new Error(`دانلود ناموفق: HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > maxBytes) throw new Error("حجم فایل از سقف تنظیم‌شده بیشتر است.");
      const total = declared || null; let received = 0;
      const reader = response.body.getReader();
      const out = createWriteStream(target, { flags: "wx" });
      try {
        while (true) {
          const {done,value} = await reader.read(); if (done) break;
          received += value.byteLength;
          if (received > maxBytes) throw new Error("حجم فایل از سقف تنظیم‌شده بیشتر است.");
          if (total) await job.updateProgress({ phase:"downloading", percent: Math.min(99, Math.floor(received/total*100)), received, total });
          else await job.updateProgress({ phase:"downloading", received, total:null });
          if (!out.write(Buffer.from(value))) await new Promise(resolve=>out.once("drain",resolve));
        }
      } catch (error) {
        out.destroy(error);
        throw error;
      }
      out.end();
      await new Promise((resolve,reject)=>{out.once("finish",resolve);out.once("error",reject);});
      return { bytes: received, finalUrl: current };
    }
    throw new Error("تعداد تغییر مسیر لینک بیش از حد است.");
  } finally { clearTimeout(timer); }
}
const worker = new Worker("rubika-uploads", async job => {
  const id = String(job.id).replace(/[^a-zA-Z0-9_-]/g,"");
  const target = path.join(dataDir, `${id}.bin`);
  const result = await download(job.data.url, target, job);
  const fileName = path.basename(new URL(job.data.url).pathname) || `upload-${id}.bin`;
  await job.updateProgress({ phase:"downloaded", percent:100, bytes:result.bytes });
  const published = await publishFile({ filePath:target, fileName, channelId:job.data.channelId });
  if (published.status === "published") { try { fs.unlinkSync(target); } catch {} }
  return { fileName, bytes:result.bytes, ...published };
}, { connection, concurrency: 1, lockDuration: 30*60*1000 });
worker.on("failed", (job,err)=>console.error("Job failed",job?.id,err.message));
process.on("SIGTERM", async()=>{ await worker.close(); await connection.quit(); process.exit(0); });
