const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();

/* ================= CORS FIX ================= */
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

app.use(express.json());
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
    return JSON.parse(rawUser);
  } catch {
    return null;
  }
}

/* ================= PLAYER ================= */

async function getPlayer(initData) {
  const tg = getTelegramUser(initData);
  if (!tg || !tg.id) return null;

  const userId = "tg_" + tg.id;

  await db.collection("users").updateOne(
    { userId },
    {
      $setOnInsert: {
        userId,
        points: 0,
        xp: 0,
        energy: 100,
        taps: 0,
        combo: 1,
        lastTapAt: 0,
        lastSyncAt: 0
      }
    },
    { upsert: true }
  );

  return await db.collection("users").findOne({ userId });
}

/* ================= ROUTES ================= */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/auth", async (req, res) => {
  const player = await getPlayer(req.body.initData);

  if (!player) return res.status(403).json({ error: "Invalid Telegram data" });

  res.json({
    player: {
      ...player,
      level: calculateLevel(player.xp),
      rank: getRank(player.xp)
    }
  });
});

app.post("/tap", async (req, res) => {
  const player = await getPlayer(req.body.initData);

  if (!player) return res.status(403).json({ error: "Invalid Telegram data" });

  let { points, xp, energy, taps, combo, lastTapAt } = player;

  if (energy <= 0) {
    return res.json(player);
  }

  const now = Date.now();

  const gap = now - lastTapAt;

  if (gap < 800) combo = Math.min(combo + 1, 5);
  else combo = 1;

  points += combo;
  xp += combo * 2;
  energy -= 1;
  taps += 1;
  lastTapAt = now;

  await db.collection("users").updateOne(
    { userId: player.userId },
    {
      $set: { points, xp, energy, taps, combo, lastTapAt }
    }
  );

  res.json({
    points,
    xp,
    energy,
    taps,
    combo,
    level: calculateLevel(xp),
    rank: getRank(xp)
  });
});

/* ================= START ================= */

async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");

  console.log("Mongo connected");

  app.listen(PORT, () => {
    console.log("Server running");
  });
}

start();
