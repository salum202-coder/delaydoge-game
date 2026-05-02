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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function calculateLevel(xp) {
  return Math.floor(Math.sqrt(safeNumber(xp, 0) / 100)) + 1;
}

function getUnlockedCharacters(level) {
  const characters = ["DelayDoge"];
  if (level >= 2) characters.push("Express Cat");
  if (level >= 4) characters.push("Traffic Raccoon");
  if (level >= 6) characters.push("Angry Karen");
  if (level >= 8) characters.push("Customs Boss");
  return characters;
}

function verifyTelegram(initData) {
  return true; // مؤقت للتجربة
}
  if (!initData || !BOT_TOKEN) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return false;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex")
    );
  } catch {
    return false;
  }
}

function getTelegramUser(initData) {
  const params = new URLSearchParams(initData);
  const rawUser = params.get("user");

  if (!rawUser) return null;

  try {
    const user = JSON.parse(rawUser);
    if (!user || !user.id) return null;

    return {
      id: user.id,
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      photoUrl: user.photo_url || ""
    };
  } catch {
    return null;
  }
}

async function findOrCreatePlayer(initData) {
  if (!verifyTelegram(initData)) {
    return { error: "Invalid Telegram data" };
  }

  const tgUser = getTelegramUser(initData);

  if (!tgUser) {
    return { error: "Invalid Telegram user" };
  }

  const userId = `tg_${tgUser.id}`;
  const now = new Date();

  await db.collection("users").updateOne(
    { userId },
    {
      $setOnInsert: {
        userId,
        telegramId: tgUser.id,
        points: 0,
        xp: 0,
        taps: 0,
        energy: 100,
        maxEnergy: 100,
        combo: 1,
        lastTapAt: 0,
        createdAt: now
      },
      $set: {
        username: tgUser.username,
        firstName: tgUser.firstName,
        lastName: tgUser.lastName,
        photoUrl: tgUser.photoUrl,
        updatedAt: now
      }
    },
    { upsert: true }
  );

  const player = await db.collection("users").findOne({ userId });
  return { player };
}

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    app: "DelayDoge API",
    time: new Date()
  });
});

app.post("/auth/telegram", async (req, res) => {
  try {
    const { initData } = req.body;

    const result = await findOrCreatePlayer(initData);

    if (result.error) {
      return res.status(403).json({
        success: false,
        message: result.error
      });
    }

    const player = result.player;
    const level = calculateLevel(player.xp || 0);

    res.json({
      success: true,
      player: {
        ...player,
        level,
        unlockedCharacters: getUnlockedCharacters(level)
      }
    });
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

app.post("/tap-sync", async (req, res) => {
  try {
    const { initData, taps } = req.body;

    const result = await findOrCreatePlayer(initData);

    if (result.error) {
      return res.status(403).json({
        success: false,
        message: result.error
      });
    }

    const player = result.player;
    const now = Date.now();

    let energy = safeNumber(player.energy, 100);
    let points = safeNumber(player.points, 0);
    let xp = safeNumber(player.xp, 0);
    let totalTaps = safeNumber(player.taps, 0);

    let combo = safeNumber(player.combo, 1);
    let lastTapAt = safeNumber(player.lastTapAt, 0);

    const requestedTaps = Math.floor(safeNumber(taps, 0));
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

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points,
          xp,
          energy,
          level,
          combo,
          lastTapAt,
          unlockedCharacters: getUnlockedCharacters(level),
          updatedAt: new Date()
        },
        $inc: {
          taps: allowedTaps
        }
      }
    );

    res.json({
      success: true,
      points,
      xp,
      taps: totalTaps,
      energy,
      level,
      combo,
      multiplier: combo,
      unlockedCharacters: getUnlockedCharacters(level),
      gained: {
        points: pointsGain,
        xp: xpGain,
        taps: allowedTaps
      }
    });
  } catch (e) {
    console.error("TAP SYNC ERROR:", e);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

async function start() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI");
  if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

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
