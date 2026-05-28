require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();

/* ================= CORS ================= */
app.use((req, res, next) => {
  const allowedOrigins = [
    "https://delaydoge-game.onrender.com",
    "https://delaydoge-app.onrender.com"
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://delaydoge-game.onrender.com");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const MAX_ENERGY = 100;
const ENERGY_REGEN_MS = 5000;
const MAX_INITDATA_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_TAP_INTERVAL_MS = 140;
const MAX_COMBO = 5;

const DAILY_MS = 24 * 60 * 60 * 1000;
const STREAK_RESET_MS = 48 * 60 * 60 * 1000;

const DAILY_REWARDS = [
  { day: 1, points: 100, xp: 100, energy: 20 },
  { day: 2, points: 150, xp: 150, energy: 25 },
  { day: 3, points: 200, xp: 200, energy: 30 },
  { day: 4, points: 250, xp: 250, energy: 35 },
  { day: 5, points: 300, xp: 300, energy: 40 },
  { day: 6, points: 400, xp: 400, energy: 50 },
  { day: 7, points: 600, xp: 600, energy: MAX_ENERGY }
];

const TASK_REWARDS = {
  tap50: { points: 80, xp: 80, label: "Tap 50 times today" },
  invite1: { points: 250, xp: 250, label: "Invite your first friend" }
};

let db;

/* ================= HELPERS ================= */

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function calculateLevel(xp) {
  return Math.floor(Math.sqrt(safeNumber(xp, 0) / 100)) + 1;
}

function getRank(xp) {
  if (xp >= 10000) return "Delay King";
  if (xp >= 5000) return "Delivery Legend";
  if (xp >= 2500) return "Customs Boss";
  if (xp >= 1000) return "Lost Parcel";
  if (xp >= 300) return "Delayed";
  return "Rookie";
}

function sanitizeReferralCode(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 80);
}

function timingSafeEqualHex(a, b) {
  try {
    const aBuffer = Buffer.from(a, "hex");
    const bBuffer = Buffer.from(b, "hex");
    if (aBuffer.length !== bBuffer.length) return false;
    return crypto.timingSafeEqual(aBuffer, bBuffer);
  } catch {
    return false;
  }
}

function verifyTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") return null;
  if (!TELEGRAM_BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = safeNumber(params.get("auth_date"), 0);
  const rawUser = params.get("user");
  const startParam = sanitizeReferralCode(params.get("start_param") || "");

  if (!hash || !authDate || !rawUser) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > MAX_INITDATA_AGE_SECONDS) return null;

  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeEqualHex(calculatedHash, hash)) return null;

  try {
    const user = JSON.parse(rawUser);
    if (!user || !user.id) return null;
    return { user, startParam };
  } catch {
    return null;
  }
}

function applyEnergyRegen(player) {
  const now = Date.now();

  let energy = safeNumber(player.energy, MAX_ENERGY);
  let lastEnergyAt = safeNumber(player.lastEnergyAt, now);

  energy = Math.max(0, Math.min(MAX_ENERGY, energy));

  if (energy >= MAX_ENERGY) {
    return { energy: MAX_ENERGY, lastEnergyAt: now };
  }

  const elapsed = Math.max(0, now - lastEnergyAt);
  const gained = Math.floor(elapsed / ENERGY_REGEN_MS);

  if (gained <= 0) {
    return { energy, lastEnergyAt };
  }

  const newEnergy = Math.min(MAX_ENERGY, energy + gained);

  return {
    energy: newEnergy,
    lastEnergyAt: newEnergy >= MAX_ENERGY ? now : lastEnergyAt + gained * ENERGY_REGEN_MS
  };
}

function publicPlayer(player) {
  const xp = safeNumber(player.xp, 0);
  const now = Date.now();
  const lastDailyRewardAt = safeNumber(player.lastDailyRewardAt, 0);
  const nextDailyAt = lastDailyRewardAt ? lastDailyRewardAt + DAILY_MS : 0;

  return {
    userId: player.userId,
    telegramId: player.telegramId,
    username: player.username || "",
    firstName: player.firstName || "",
    lastName: player.lastName || "",
    photoUrl: player.photoUrl || "",
    points: safeNumber(player.points, 0),
    xp,
    energy: safeNumber(player.energy, MAX_ENERGY),
    maxEnergy: MAX_ENERGY,
    taps: safeNumber(player.taps, 0),
    combo: safeNumber(player.combo, 1),
    level: calculateLevel(xp),
    rank: getRank(xp),
    dailyStreak: safeNumber(player.dailyStreak, 0),
    lastDailyRewardAt,
    canClaimDaily: !lastDailyRewardAt || now >= nextDailyAt,
    nextDailyAt,
    todayTaps: safeNumber(player.todayTaps, 0),
    todayKey: player.todayKey || todayKey(),
    referrals: safeNumber(player.referrals, 0),
    referralPoints: safeNumber(player.referralPoints, 0),
    invitedBy: player.invitedBy || "",
    inviteCode: player.inviteCode || player.userId,
    claimedTasks: player.claimedTasks || {}
  };
}

async function applyReferralIfNeeded(player, referralCode) {
  const cleanCode = sanitizeReferralCode(referralCode);
  if (!cleanCode) return;
  if (player.invitedBy) return;
  if (cleanCode === player.userId) return;

  const referrer = await db.collection("users").findOne({ inviteCode: cleanCode });
  if (!referrer || referrer.userId === player.userId) return;

  const setResult = await db.collection("users").updateOne(
    { userId: player.userId, $or: [{ invitedBy: "" }, { invitedBy: { $exists: false } }] },
    { $set: { invitedBy: referrer.userId, invitedAt: new Date(), updatedAt: new Date() } }
  );

  if (setResult.modifiedCount > 0) {
    await db.collection("users").updateOne(
      { userId: referrer.userId },
      {
        $inc: {
          referrals: 1,
          referralPoints: 250,
          points: 250,
          xp: 250
        },
        $set: { updatedAt: new Date() }
      }
    );
  }
}

/* ================= PLAYER ================= */

async function getPlayer(initData, options = {}) {
  const verified = verifyTelegramInitData(initData);
  if (!verified) return null;

  const tg = verified.user;
  const userId = "tg_" + tg.id;
  const now = new Date();

  await db.collection("users").updateOne(
    { userId },
    {
      $setOnInsert: {
        userId,
        telegramId: tg.id,
        points: 0,
        xp: 0,
        energy: MAX_ENERGY,
        maxEnergy: MAX_ENERGY,
        taps: 0,
        combo: 1,
        lastTapAt: 0,
        lastSyncAt: 0,
        lastEnergyAt: Date.now(),
        suspicious: 0,
        dailyStreak: 0,
        lastDailyRewardAt: 0,
        inviteCode: userId,
        invitedBy: "",
        referrals: 0,
        referralPoints: 0,
        todayKey: todayKey(),
        todayTaps: 0,
        claimedTasks: {},
        createdAt: now
      },
      $set: {
        username: tg.username || "",
        firstName: tg.first_name || "",
        lastName: tg.last_name || "",
        photoUrl: tg.photo_url || "",
        updatedAt: now
      }
    },
    { upsert: true }
  );

  let player = await db.collection("users").findOne({ userId });

  const referralCode = options.referralCode || verified.startParam || "";
  await applyReferralIfNeeded(player, referralCode);

  player = await db.collection("users").findOne({ userId });
  const regen = applyEnergyRegen(player);

  await db.collection("users").updateOne(
    { userId },
    {
      $set: {
        energy: regen.energy,
        maxEnergy: MAX_ENERGY,
        lastEnergyAt: regen.lastEnergyAt,
        updatedAt: new Date()
      }
    }
  );

  player.energy = regen.energy;
  player.maxEnergy = MAX_ENERGY;
  player.lastEnergyAt = regen.lastEnergyAt;

  return player;
}

async function getTasksForPlayer(player) {
  const day = todayKey();
  const claimedTasks = player.claimedTasks || {};
  const todayTaps = player.todayKey === day ? safeNumber(player.todayTaps, 0) : 0;

  return {
    tap50: {
      id: "tap50",
      title: "Tap 50 times today",
      progress: todayTaps,
      target: 50,
      reward: TASK_REWARDS.tap50,
      completed: todayTaps >= 50,
      claimed: Boolean(claimedTasks.tap50 === day)
    },
    invite1: {
      id: "invite1",
      title: "Invite your first friend",
      progress: Math.min(1, safeNumber(player.referrals, 0)),
      target: 1,
      reward: TASK_REWARDS.invite1,
      completed: safeNumber(player.referrals, 0) >= 1,
      claimed: Boolean(claimedTasks.invite1)
    }
  };
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    app: "DelayDoge API",
    energy: "enabled",
    telegramAuth: "verified",
    daily: "enabled",
    referrals: "enabled",
    leaderboard: "enabled",
    time: new Date()
  });
});

app.post("/auth", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData, {
      referralCode: req.body.referralCode
    });

    if (!player) {
      return res.status(403).json({ error: "Invalid Telegram data" });
    }

    const tasks = await getTasksForPlayer(player);

    res.json({
      player: publicPlayer(player),
      tasks
    });
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/tap", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);

    if (!player) {
      return res.status(403).json({ error: "Invalid Telegram data" });
    }

    let points = safeNumber(player.points, 0);
    let xp = safeNumber(player.xp, 0);
    let energy = safeNumber(player.energy, MAX_ENERGY);
    let taps = safeNumber(player.taps, 0);
    let combo = safeNumber(player.combo, 1);
    let lastTapAt = safeNumber(player.lastTapAt, 0);
    let suspicious = safeNumber(player.suspicious, 0);

    const now = Date.now();
    const gap = lastTapAt ? now - lastTapAt : 9999;

    if (gap < MIN_TAP_INTERVAL_MS) {
      suspicious += 1;

      await db.collection("users").updateOne(
        { userId: player.userId },
        { $set: { suspicious, lastSyncAt: now, updatedAt: new Date() } }
      );

      return res.json({
        ...publicPlayer({ ...player, suspicious }),
        gained: { points: 0, xp: 0, taps: 0 },
        message: "Too fast. Slow down."
      });
    }

    if (energy <= 0) {
      return res.json({
        ...publicPlayer({ ...player, energy: 0 }),
        gained: { points: 0, xp: 0, taps: 0 },
        message: "Energy empty. Wait for recharge."
      });
    }

    if (gap < 800) {
      combo = Math.min(combo + 1, MAX_COMBO);
    } else {
      combo = 1;
    }

    const pointsGain = combo;
    const xpGain = combo * 2;
    const day = todayKey();
    const oldTodayKey = player.todayKey || day;
    const oldTodayTaps = safeNumber(player.todayTaps, 0);
    const todayTaps = oldTodayKey === day ? oldTodayTaps + 1 : 1;

    points += pointsGain;
    xp += xpGain;
    energy = Math.max(0, energy - 1);
    taps += 1;

    const level = calculateLevel(xp);
    const rank = getRank(xp);

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points,
          xp,
          energy,
          maxEnergy: MAX_ENERGY,
          taps,
          combo,
          lastTapAt: now,
          lastSyncAt: now,
          lastEnergyAt: energy < MAX_ENERGY ? now : player.lastEnergyAt,
          suspicious,
          level,
          rank,
          todayKey: day,
          todayTaps,
          updatedAt: new Date()
        }
      }
    );

    const updated = await db.collection("users").findOne({ userId: player.userId });
    const tasks = await getTasksForPlayer(updated);

    res.json({
      ...publicPlayer(updated),
      tasks,
      gained: { points: pointsGain, xp: xpGain, taps: 1 }
    });
  } catch (e) {
    console.error("TAP ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/daily", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);

    if (!player) {
      return res.status(403).json({ error: "Invalid Telegram data" });
    }

    const now = Date.now();
    const lastDailyRewardAt = safeNumber(player.lastDailyRewardAt, 0);

    if (lastDailyRewardAt && now - lastDailyRewardAt < DAILY_MS) {
      return res.json({
        ok: false,
        message: "Daily reward already claimed.",
        nextDailyAt: lastDailyRewardAt + DAILY_MS,
        player: publicPlayer(player)
      });
    }

    let streak = safeNumber(player.dailyStreak, 0);
    if (!lastDailyRewardAt || now - lastDailyRewardAt > STREAK_RESET_MS) {
      streak = 1;
    } else {
      streak += 1;
    }

    const reward = DAILY_REWARDS[Math.min(streak, 7) - 1] || DAILY_REWARDS[6];

    const points = safeNumber(player.points, 0) + reward.points;
    const xp = safeNumber(player.xp, 0) + reward.xp;
    const energy = Math.min(MAX_ENERGY, safeNumber(player.energy, MAX_ENERGY) + reward.energy);

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points,
          xp,
          energy,
          maxEnergy: MAX_ENERGY,
          dailyStreak: streak,
          lastDailyRewardAt: now,
          level: calculateLevel(xp),
          rank: getRank(xp),
          updatedAt: new Date()
        }
      }
    );

    const updated = await db.collection("users").findOne({ userId: player.userId });

    res.json({
      ok: true,
      message: `Daily reward claimed! Day ${streak}`,
      reward,
      player: publicPlayer(updated)
    });
  } catch (e) {
    console.error("DAILY ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/tasks", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);

    if (!player) {
      return res.status(403).json({ error: "Invalid Telegram data" });
    }

    res.json({
      tasks: await getTasksForPlayer(player),
      player: publicPlayer(player)
    });
  } catch (e) {
    console.error("TASKS ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/claim-task", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    const taskId = String(req.body.taskId || "");

    if (!player) {
      return res.status(403).json({ error: "Invalid Telegram data" });
    }

    const tasks = await getTasksForPlayer(player);
    const task = tasks[taskId];

    if (!task || !TASK_REWARDS[taskId]) {
      return res.status(400).json({ error: "Unknown task" });
    }

    if (!task.completed) {
      return res.json({ ok: false, message: "Task not completed yet.", tasks, player: publicPlayer(player) });
    }

    if (task.claimed) {
      return res.json({ ok: false, message: "Task already claimed.", tasks, player: publicPlayer(player) });
    }

    const reward = TASK_REWARDS[taskId];
    const points = safeNumber(player.points, 0) + reward.points;
    const xp = safeNumber(player.xp, 0) + reward.xp;
    const claimedTasks = player.claimedTasks || {};

    if (taskId === "tap50") {
      claimedTasks.tap50 = todayKey();
    } else {
      claimedTasks[taskId] = true;
    }

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points,
          xp,
          claimedTasks,
          level: calculateLevel(xp),
          rank: getRank(xp),
          updatedAt: new Date()
        }
      }
    );

    const updated = await db.collection("users").findOne({ userId: player.userId });

    res.json({
      ok: true,
      message: `Task reward claimed: +${reward.points} points`,
      reward,
      player: publicPlayer(updated),
      tasks: await getTasksForPlayer(updated)
    });
  } catch (e) {
    console.error("CLAIM TASK ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const leaders = await db.collection("users")
      .find({}, { projection: { userId: 1, username: 1, firstName: 1, points: 1, xp: 1, level: 1, photoUrl: 1 } })
      .sort({ points: -1, xp: -1 })
      .limit(20)
      .toArray();

    res.json({
      leaders: leaders.map((p, index) => ({
        rank: index + 1,
        name: p.username ? `@${p.username}` : (p.firstName || "Delay Player"),
        points: safeNumber(p.points, 0),
        xp: safeNumber(p.xp, 0),
        level: calculateLevel(p.xp || 0),
        photoUrl: p.photoUrl || ""
      }))
    });
  } catch (e) {
    console.error("LEADERBOARD ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= START ================= */

async function start() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }

  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");

  await db.collection("users").createIndex({ userId: 1 }, { unique: true });
  await db.collection("users").createIndex({ telegramId: 1 });
  await db.collection("users").createIndex({ inviteCode: 1 });
  await db.collection("users").createIndex({ points: -1 });
  await db.collection("users").createIndex({ xp: -1 });

  console.log("✅ MongoDB Connected");

  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("❌ Server failed to start:", err);
  process.exit(1);
});
