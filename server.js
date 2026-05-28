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

let db;

/* ================= HELPERS ================= */

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    return user;
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
    return {
      energy: MAX_ENERGY,
      lastEnergyAt: now
    };
  }

  const elapsed = Math.max(0, now - lastEnergyAt);
  const gained = Math.floor(elapsed / ENERGY_REGEN_MS);

  if (gained <= 0) {
    return {
      energy,
      lastEnergyAt
    };
  }

  const newEnergy = Math.min(MAX_ENERGY, energy + gained);

  return {
    energy: newEnergy,
    lastEnergyAt:
      newEnergy >= MAX_ENERGY
        ? now
        : lastEnergyAt + gained * ENERGY_REGEN_MS
  };
}

/* ================= PLAYER ================= */

async function getPlayer(initData) {
  const tg = verifyTelegramInitData(initData);

  if (!tg) return null;

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

  const player = await db.collection("users").findOne({ userId });
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

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    app: "DelayDoge API",
    energy: "enabled",
    telegramAuth: "verified",
    time: new Date()
  });
});

app.post("/auth", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);

    if (!player) {
      return res.status(403).json({
        error: "Invalid Telegram data"
      });
    }

    const xp = safeNumber(player.xp, 0);

    res.json({
      player: {
        ...player,
        level: calculateLevel(xp),
        rank: getRank(xp),
        maxEnergy: MAX_ENERGY
      }
    });
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({
      error: "Server error"
    });
  }
});

app.post("/tap", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);

    if (!player) {
      return res.status(403).json({
        error: "Invalid Telegram data"
      });
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
        {
          $set: {
            suspicious,
            lastSyncAt: now,
            updatedAt: new Date()
          }
        }
      );

      return res.json({
        points,
        xp,
        energy,
        maxEnergy: MAX_ENERGY,
        taps,
        combo,
        level: calculateLevel(xp),
        rank: getRank(xp),
        gained: {
          points: 0,
          xp: 0,
          taps: 0
        },
        message: "Too fast. Slow down."
      });
    }

    if (energy <= 0) {
      return res.json({
        points,
        xp,
        energy: 0,
        maxEnergy: MAX_ENERGY,
        taps,
        combo,
        level: calculateLevel(xp),
        rank: getRank(xp),
        gained: {
          points: 0,
          xp: 0,
          taps: 0
        },
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
          updatedAt: new Date()
        }
      }
    );

    res.json({
      points,
      xp,
      energy,
      maxEnergy: MAX_ENERGY,
      taps,
      combo,
      level,
      rank,
      gained: {
        points: pointsGain,
        xp: xpGain,
        taps: 1
      }
    });
  } catch (e) {
    console.error("TAP ERROR:", e);
    res.status(500).json({
      error: "Server error"
    });
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
