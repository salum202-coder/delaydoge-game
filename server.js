const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();

/* ================= CORS FIX ================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://delaydoge-game.onrender.com");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;

let db;

/* ================= HELPERS ================= */

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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
        energy: 100,
        maxEnergy: 100,
        taps: 0,
        combo: 1,
        lastTapAt: 0,
        lastSyncAt: 0,
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

  return await db.collection("users").findOne({ userId });
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    app: "DelayDoge API",
    time: new Date()
  });
});

/* ---------- AUTH ---------- */

app.post("/auth", async (req, res) => {
  try {
    const { initData } = req.body;

    const player = await getPlayer(initData);

    if (!player) {
      return res.status(403).json({
        error: "Invalid Telegram data"
      });
    }

    const xp = safeNumber(player.xp, 0);
    const level = calculateLevel(xp);

    res.json({
      player: {
        ...player,
        level,
        rank: getRank(xp)
      }
    });
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({
      error: "Server error"
    });
  }
});

/* ---------- TAP ---------- */

app.post("/tap", async (req, res) => {
  try {
    const { initData, taps } = req.body;

    const player = await getPlayer(initData);

    if (!player) {
      return res.status(403).json({
        error: "Invalid Telegram data"
      });
    }

    const now = Date.now();

    let energy = safeNumber(player.energy, 100);
    let points = safeNumber(player.points, 0);
    let xp = safeNumber(player.xp, 0);
    let totalTaps = safeNumber(player.taps, 0);
    let combo = safeNumber(player.combo, 1);
    let lastTapAt = safeNumber(player.lastTapAt, 0);
    let lastSyncAt = safeNumber(player.lastSyncAt, 0);
    let suspicious = safeNumber(player.suspicious, 0);

    const requestedTaps = Math.floor(safeNumber(taps, 0));

    if (requestedTaps <= 0) {
      return res.json({
        points,
        xp,
        energy,
        taps: totalTaps,
        combo,
        level: calculateLevel(xp),
        rank: getRank(xp)
      });
    }

    /* ================= ANTI CHEAT ================= */

    if (requestedTaps > 30) {
      suspicious++;
    }

    if (lastSyncAt && now - lastSyncAt < 600) {
      suspicious++;
    }

    if (suspicious >= 5) {
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

      return res.status(429).json({
        error: "Too fast. Slow down."
      });
    }

    const safeTaps = Math.max(0, Math.min(requestedTaps, 30));
    const allowedTaps = Math.min(safeTaps, energy);

    let pointsGain = 0;
    let xpGain = 0;

    for (let i = 0; i < allowedTaps; i++) {
      const virtualTapTime = now + i * 120;
      const gap = lastTapAt ? virtualTapTime - lastTapAt : 9999;

      if (gap <= 900) {
        combo = Math.min(combo + 1, 5);
      } else {
        combo = 1;
      }

      pointsGain += combo;
      xpGain += combo * 2;

      lastTapAt = virtualTapTime;
    }

    points += pointsGain;
    xp += xpGain;
    energy = Math.max(0, energy - allowedTaps);
    totalTaps += allowedTaps;

    const level = calculateLevel(xp);
    const rank = getRank(xp);

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points,
          xp,
          energy,
          combo,
          lastTapAt,
          lastSyncAt: now,
          suspicious,
          level,
          rank,
          updatedAt: new Date()
        },
        $inc: {
          taps: allowedTaps
        }
      }
    );

    res.json({
      points,
      xp,
      energy,
      taps: totalTaps,
      combo,
      level,
      rank,
      gained: {
        points: pointsGain,
        xp: xpGain,
        taps: allowedTaps
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
