const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;

let db;

async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("delaydoge");

  await db.collection("users").createIndex({ userId: 1 }, { unique: true });

  console.log("MongoDB Connected");
}

function verifyTelegram(initData) {
  if (!initData || !BOT_TOKEN) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  return hmac === hash;
}

app.post("/tap-sync", async (req, res) => {
  try {
    const { initData, taps } = req.body;

    if (!verifyTelegram(initData)) {
      return res.status(403).json({ success: false, message: "Invalid Telegram data" });
    }

    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get("user"));
    const userId = "tg_" + user.id;

    const player = await db.collection("users").findOne({ userId });

    if (!player) {
      return res.status(404).json({ success: false });
    }

    let energy = player.energy ?? 100;
    let points = player.points ?? 0;
    let xp = player.xp ?? 0;

    let safeTaps = Math.min(Number(taps) || 0, 30);
    let allowed = Math.min(safeTaps, energy);

    let gain = allowed;

    points += gain;
    xp += allowed * 2;
    energy -= allowed;

    await db.collection("users").updateOne(
      { userId },
      {
        $set: {
          points,
          xp,
          energy,
          taps: (player.taps || 0) + allowed,
          updatedAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      points,
      xp,
      energy
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});

app.post("/auth/telegram", async (req, res) => {
  const { initData } = req.body;

  if (!verifyTelegram(initData)) {
    return res.status(403).json({ success: false });
  }

  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get("user"));
  const userId = "tg_" + user.id;

  await db.collection("users").updateOne(
    { userId },
    {
      $setOnInsert: {
        userId,
        points: 0,
        xp: 0,
        taps: 0,
        energy: 100,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );

  const player = await db.collection("users").findOne({ userId });

  res.json({ success: true, player });
});

app.listen(PORT, () => console.log("Server running"));
start();
