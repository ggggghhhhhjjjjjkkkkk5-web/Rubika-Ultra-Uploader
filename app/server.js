import express from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import Redis from "ioredis";
import { Queue } from "bullmq";
import helmet from "helmet";
import crypto from "node:crypto";
import fs from "node:fs";

const app = express();
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const queue = new Queue("filestorm-uploads", { connection: redis });
const dataDir = process.env.DATA_DIR || "./data";
fs.mkdirSync(dataDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.json({ limit: "20kb" }));
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET || "unsafe-dev-secret-change-me",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8*60*60*1000 }
}));
app.use(express.static("public"));
const requireAuth = (req,res,next) => req.session?.ok ? next() : res.status(401).json({ error: "ابتدا وارد پنل شوید." });
app.get("/health", (_req,res) => res.json({ ok: true }));
app.post("/api/login", (req,res) => {
  const supplied = String(req.body.password || "");
  const expected = String(process.env.ADMIN_PASSWORD || "");
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: "رمز نادرست است." });
  }
  req.session.ok = true; res.json({ ok: true });
});
app.post("/api/logout", requireAuth, (req,res) => req.session.destroy(() => res.json({ ok: true })));
app.post("/api/jobs", requireAuth, async (req,res) => {
  const url = String(req.body.url || "").trim();
  const channelId = String(req.body.channelId || process.env.RUBIKA_CHANNEL_ID || "").trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "لینک باید با http یا https شروع شود." });
  if (!channelId) return res.status(400).json({ error: "شناسه کانال را وارد کنید." });
  const job = await queue.add("download-and-publish", { url, channelId }, { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 200 });
  res.json({ id: job.id, status: "queued" });
});
app.get("/api/jobs", requireAuth, async (_req,res) => {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaiting(0,49), queue.getActive(0,49), queue.getCompleted(0,49), queue.getFailed(0,49), queue.getDelayed(0,49)
  ]);
  const all = [...waiting,...active,...delayed,...completed,...failed].sort((a,b)=>Number(b.timestamp)-Number(a.timestamp));
  res.json(all.map(j=>({ id:j.id, name:j.name, state:j.failedReason ? "failed" : (j.returnvalue?.status || (j.finishedOn ? "completed" : j.processedOn ? "downloading" : "queued")), progress:j.progress, data:{ channelId:j.data.channelId, fileName:j.returnvalue?.fileName }, error:j.failedReason })));
});
app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Uploader panel listening"));
