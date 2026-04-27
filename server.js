const express = require("express");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const client = new MongoClient(process.env.MONGO_URI);
let db;

async function start() {
  await client.connect();
  db = client.db("delaydoge");
  await db.collection("players").createIndex({ userId: 1 }, { unique: true });
  await db.collection("players").createIndex({ "telegram.id": 1 });
  await db.collection("players").createIndex({ coins: -1, xp: -1 });
  console.log("MongoDB Connected 🔥");
}

start().catch((err) => {
  console.error("MongoDB connection failed", err);
  process.exit(1);
});

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function rankFromXp(xp) {
  xp = Number(xp) || 0;
  if (xp >= 3000) return "Delivery Legend";
  if (xp >= 1500) return "Customs Boss";
  if (xp >= 700) return "Lost Parcel";
  if (xp >= 300) return "Furious";
  if (xp >= 100) return "Delayed";
  return "Rookie";
}

function normalizeTelegramUser(user) {
  if (!user || !user.id) return null;
  return {
    id: user.id,
    username: user.username || "",
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    language_code: user.language_code || "",
    photo_url: user.photo_url || ""
  };
}

function validateTelegramInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !initData) return { ok: true, mode: "dev" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "Missing hash" };

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  try {
    const isValid = crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(hash));
    return isValid ? { ok: true, mode: "verified" } : { ok: false, reason: "Invalid hash" };
  } catch {
    return { ok: false, reason: "Hash compare failed" };
  }
}

function publicPlayer(player) {
  if (!player) return null;
  const { _id, ...rest } = player;
  return rest;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "DelayDoge V6" });
});

app.post("/auth/telegram", async (req, res) => {
  try {
    const { initData, user, fallbackUserId, referralCode } = req.body;
    const validation = validateTelegramInitData(initData || "");

    if (!validation.ok) {
      return res.status(401).json({ success: false, message: validation.reason });
    }

    const telegram = normalizeTelegramUser(user);
    const userId = telegram?.id ? `tg_${telegram.id}` : fallbackUserId;

    if (!userId) {
      return res.status(400).json({ success: false, message: "Missing user" });
    }

    const players = db.collection("players");
    const existing = await players.findOne({ userId });
    const isNewPlayer = !existing;

    const update = {
      $set: {
        userId,
        telegram,
        authMode: validation.mode,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      },
      $setOnInsert: {
        coins: 0,
        xp: 0,
        taps: 0,
        streak: 0,
        energy: 100,
        rank: "Rookie",
        referrals: 0,
        referralBonusEarned: 0,
        createdAt: new Date(),
        lastDailyReward: null
      }
    };

    if (isNewPlayer && referralCode && referralCode !== userId) {
      update.$setOnInsert.referredBy = referralCode;
    }

    await players.updateOne({ userId }, update, { upsert: true });

    if (isNewPlayer && referralCode && referralCode !== userId) {
      await players.updateOne(
        { userId: referralCode },
        {
          $inc: {
            coins: 200,
            xp: 100,
            referrals: 1,
            referralBonusEarned: 200
          },
          $set: { updatedAt: new Date() }
        }
      );
    }

    const player = await players.findOne({ userId });
    res.json({ success: true, player: publicPlayer(player), isNewPlayer });
  } catch (err) {
    console.error("/auth/telegram error", err);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

app.post("/save", async (req, res) => {
  try {
    const data = req.body;

    if (!data.userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    const coins = Math.max(0, Number(data.coins) || 0);
    const xp = Math.max(0, Number(data.xp) || 0);
    const taps = Math.max(0, Number(data.taps) || 0);
    const streak = Math.max(0, Number(data.streak) || 0);
    const energy = Math.max(0, Math.min(100, Number(data.energy) || 0));

    await db.collection("players").updateOne(
      { userId: data.userId },
      {
        $set: {
          userId: data.userId,
          coins,
          xp,
          taps,
          streak,
          energy,
          rank: rankFromXp(xp),
          telegram: normalizeTelegramUser(data.telegram),
          updatedAt: new Date(),
          lastSeenAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date(),
          lastDailyReward: null,
          referrals: 0,
          referralBonusEarned: 0
        }
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("/save error", err);
    res.status(500).json({ success: false, message: "Save failed" });
  }
});

app.get("/player/:userId", async (req, res) => {
  const player = await db.collection("players").findOne({ userId: req.params.userId });

  if (!player) {
    return res.json({ success: false, message: "Player not found" });
  }

  res.json({ success: true, player: publicPlayer(player) });
});

app.post("/daily-reward", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    const today = getToday();
    const players = db.collection("players");
    const player = await players.findOne({ userId });

    if (player && player.lastDailyReward === today) {
      return res.json({
        success: false,
        message: "Already claimed today",
        alreadyClaimed: true
      });
    }

    const newStreak = (Number(player?.streak) || 0) + 1;
    const reward = 50 + newStreak * 10;

    await players.updateOne(
      { userId },
      {
        $inc: { coins: reward, xp: reward },
        $set: {
          energy: 100,
          streak: newStreak,
          lastDailyReward: today,
          updatedAt: new Date(),
          lastSeenAt: new Date()
        },
        $setOnInsert: {
          userId,
          taps: 0,
          rank: "Rookie",
          referrals: 0,
          referralBonusEarned: 0,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    const updated = await players.findOne({ userId });

    res.json({
      success: true,
      message: `Daily reward claimed +${reward}`,
      reward,
      player: publicPlayer(updated)
    });
  } catch (err) {
    console.error("/daily-reward error", err);
    res.status(500).json({ success: false, message: "Daily reward failed" });
  }
});

app.get("/leaderboard", async (req, res) => {
  const top = await db.collection("players")
    .find(
      {},
      {
        projection: {
          _id: 0,
          userId: 1,
          telegram: 1,
          coins: 1,
          xp: 1,
          taps: 1,
          streak: 1,
          rank: 1,
          referrals: 1
        }
      }
    )
    .sort({ coins: -1, xp: -1 })
    .limit(50)
    .toArray();

  res.json({ success: true, leaderboard: top });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running on " + PORT);
});