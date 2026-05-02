const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;

let db;

// ================= HELPERS =================

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function getTelegramUser(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const user = params.get("user");
  if (!user) return null;
  try {
    return JSON.parse(user);
  } catch {
    return null;
  }
}

// ================= PLAYER =================

async function getPlayer(initData) {
  const tg = getTelegramUser(initData);
  if (!tg) return null;

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
        lastTap: 0,
        lastSync: 0,
        suspicious: 0
      }
    },
    { upsert: true }
  );

  return await db.collection("users").findOne({ userId });
}

// ================= ROUTES =================

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------- AUTH --------

app.post("/auth", async (req, res) => {
  const { initData } = req.body;
  const player = await getPlayer(initData);

  if (!player) {
    return res.status(403).json({ error: "Invalid Telegram data" });
  }

  res.json({ player });
});

// -------- TAP --------

app.post("/tap", async (req, res) => {
  const { initData, taps } = req.body;
  const player = await getPlayer(initData);

  if (!player) {
    return res.status(403).json({ error: "Invalid Telegram data" });
  }

  const now = Date.now();

  let energy = safeNumber(player.energy, 100);
  let points = safeNumber(player.points, 0);
  let xp = safeNumber(player.xp, 0);
  let totalTaps = safeNumber(player.taps, 0);

  let suspicious = safeNumber(player.suspicious, 0);

  const t = Math.floor(safeNumber(taps, 0));

  // ===== Anti Cheat =====

  if (t > 30) {
    suspicious++;
  }

  if (player.lastSync && now - player.lastSync < 700) {
    suspicious++;
  }

  if (suspicious >= 5) {
    return res.status(429).json({ error: "Too fast" });
  }

  const allowed = Math.min(t, energy);

  let gain = 0;

  for (let i = 0; i < allowed; i++) {
    gain += 1;
  }

  points += gain;
  xp += gain * 2;
  energy -= allowed;
  totalTaps += allowed;

  await db.collection("users").updateOne(
    { userId: player.userId },
    {
      $set: {
        points,
        xp,
        energy,
        lastSync: now,
        suspicious
      },
      $inc: {
        taps: allowed
      }
    }
  );

  res.json({
    points,
    xp,
    energy,
    taps: totalTaps
  });
});

// ================= START =================

async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("delaydoge");

  console.log("Mongo Connected");

  app.listen(PORT, () => {
    console.log("Server running on", PORT);
  });
}

start();
