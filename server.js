const express = require("express");
const path = require("path");
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

const MAX_ENERGY = 100;
const ENERGY_REGEN_MS = 5000;

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

function getTelegramUser(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const rawUser = params.get("user");

  if (!rawUser) return null;

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

  // مؤقتًا: أي حساب قديم طاقته صفر نرجعها 100
  if (energy <= 0) {
    return {
      energy: MAX_ENERGY,
      lastEnergyAt: now
    };
  }

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
  const tg = getTelegramUser(initData);

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

    const now = Date.now();
    const gap = lastTapAt ? now - lastTapAt : 9999;

    if (gap < 800) {
      combo = Math.min(combo + 1, 5);
    } else {
      combo = 1;
    }

    const pointsGain = combo;
    const xpGain = combo * 2;

    points += pointsGain;
    xp += xpGain;
    energy = Math.max(0, energy - 1);
    taps += 1;
    lastTapAt = now;

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
          lastTapAt,
          lastSyncAt: now,
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

  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");

  await db.collection("users").createIndex({ userId: 1 }, { unique: true });

  console.log("✅ MongoDB Connected");

  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("❌ Server failed to start:", err);
  process.exit(1);
});
