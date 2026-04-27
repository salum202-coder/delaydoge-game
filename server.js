const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;

let db;

async function start() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI");

  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");

  await db.collection("users").createIndex({ userId: 1 }, { unique: true });
  await db.collection("users").createIndex({ telegramId: 1 });
  await db.collection("users").createIndex({ points: -1, xp: -1 });
  await db.collection("referrals").createIndex({ invitedUserId: 1 }, { unique: true });
  await db.collection("referrals").createIndex({ inviterUserId: 1 });

  console.log("MongoDB Connected");
}

function cleanTelegramUser(user) {
  if (!user) return null;
  return {
    id: user.id || null,
    username: user.username || "",
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    language_code: user.language_code || "",
    photo_url: user.photo_url || ""
  };
}

function getRank(xp) {
  xp = Number(xp) || 0;
  if (xp >= 10000) return "Delay King";
  if (xp >= 5000) return "Delivery Legend";
  if (xp >= 2500) return "Customs Boss";
  if (xp >= 1000) return "Lost Parcel";
  if (xp >= 300) return "Delayed";
  return "Rookie";
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function publicUser(user) {
  if (!user) return null;
  const { _id, ...rest } = user;
  return rest;
}

function requireDb(req, res, next) {
  if (!db) {
    return res.status(503).json({
      success: false,
      message: "Database not ready"
    });
  }
  next();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "DelayDoge V7",
    db: !!db
  });
});

app.post("/auth/telegram", requireDb, async (req, res) => {
  try {
    const { userId, fallbackUserId, telegram, user, referralCode } = req.body;

    const tg = cleanTelegramUser(telegram || user);
    const finalUserId = tg?.id ? `tg_${tg.id}` : userId || fallbackUserId;

    if (!finalUserId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const users = db.collection("users");
    const referrals = db.collection("referrals");

    const existing = await users.findOne({ userId: finalUserId });
    const isNew = !existing;

    await users.updateOne(
      { userId: finalUserId },
      {
        $set: {
          userId: finalUserId,
          telegramId: tg?.id || null,
          telegram: tg,
          username: tg?.username || "",
          firstName: tg?.first_name || "",
          photoUrl: tg?.photo_url || "",
          lastSeenAt: new Date(),
          updatedAt: new Date()
        },
        $setOnInsert: {
          points: 0,
          coins: 0,
          xp: 0,
          taps: 0,
          streak: 0,
          energy: 100,
          rank: "Rookie",
          referrals: 0,
          referralEarnings: 0,
          invitedBy: null,
          createdAt: new Date(),
          lastDailyReward: null
        }
      },
      { upsert: true }
    );

    const validReferral =
      isNew &&
      referralCode &&
      referralCode !== finalUserId &&
      referralCode.startsWith("tg_");

    if (validReferral) {
      const inviter = await users.findOne({ userId: referralCode });

      if (inviter) {
        try {
          await referrals.insertOne({
            inviterUserId: referralCode,
            invitedUserId: finalUserId,
            createdAt: new Date(),
            inviterReward: 3000,
            invitedReward: 1000
          });

          await users.updateOne(
            { userId: referralCode },
            {
              $inc: {
                points: 3000,
                coins: 3000,
                xp: 1000,
                referrals: 1,
                referralEarnings: 3000
              },
              $set: { updatedAt: new Date() }
            }
          );

          await users.updateOne(
            { userId: finalUserId },
            {
              $inc: {
                points: 1000,
                coins: 1000,
                xp: 500
              },
              $set: {
                invitedBy: referralCode,
                updatedAt: new Date()
              }
            }
          );
        } catch (e) {
          console.warn("Referral skipped:", e.message);
        }
      }
    }

    const updated = await users.findOne({ userId: finalUserId });
    const totalUsers = await users.countDocuments();

    res.json({
      success: true,
      isNew,
      user: publicUser(updated),
      player: publicUser(updated),
      totalUsers
    });
  } catch (err) {
    console.error("/auth/telegram error", err);
    res.status(500).json({
      success: false,
      message: "Login failed"
    });
  }
});

app.post("/save", requireDb, async (req, res) => {
  try {
    const { userId, coins, points, xp, taps, streak, energy, telegram } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const finalPoints = safeNumber(points ?? coins);
    const finalXp = safeNumber(xp);
    const finalTaps = safeNumber(taps);
    const finalStreak = safeNumber(streak);
    const finalEnergy = Math.min(100, safeNumber(energy, 100));

    await db.collection("users").updateOne(
      { userId },
      {
        $max: {
          points: finalPoints,
          coins: finalPoints,
          xp: finalXp,
          taps: finalTaps
        },
        $set: {
          streak: finalStreak,
          energy: finalEnergy,
          rank: getRank(finalXp),
          telegram: cleanTelegramUser(telegram),
          updatedAt: new Date(),
          lastSeenAt: new Date()
        },
        $setOnInsert: {
          userId,
          referrals: 0,
          referralEarnings: 0,
          createdAt: new Date(),
          lastDailyReward: null
        }
      },
      { upsert: true }
    );

    const updated = await db.collection("users").findOne({ userId });

    res.json({
      success: true,
      user: publicUser(updated),
      player: publicUser(updated)
    });
  } catch (err) {
    console.error("/save error", err);
    res.status(500).json({
      success: false,
      message: "Save failed"
    });
  }
});

app.post("/tap", requireDb, async (req, res) => {
  try {
    const { id, userId, points } = req.body;
    const finalUserId = userId || (id ? `tg_${id}` : null);

    if (!finalUserId) {
      return res.status(400).json({
        success: false,
        message: "Missing user"
      });
    }

    const score = safeNumber(points);

    await db.collection("users").updateOne(
      { userId: finalUserId },
      {
        $max: {
          points: score,
          coins: score
        },
        $set: {
          updatedAt: new Date(),
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("/tap error", err);
    res.status(500).json({
      success: false,
      message: "Tap failed"
    });
  }
});

app.post("/daily-reward", requireDb, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const users = db.collection("users");
    const user = await users.findOne({ userId });

    if (user?.lastDailyReward === today) {
      return res.json({
        success: false,
        message: "Already claimed today",
        alreadyClaimed: true
      });
    }

    const newStreak = (safeNumber(user?.streak) || 0) + 1;
    const reward = 100 + newStreak * 25;

    await users.updateOne(
      { userId },
      {
        $inc: {
          points: reward,
          coins: reward,
          xp: reward
        },
        $set: {
          streak: newStreak,
          energy: 100,
          lastDailyReward: today,
          updatedAt: new Date(),
          lastSeenAt: new Date()
        },
        $setOnInsert: {
          userId,
          taps: 0,
          referrals: 0,
          referralEarnings: 0,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    const updated = await users.findOne({ userId });

    res.json({
      success: true,
      reward,
      user: publicUser(updated),
      player: publicUser(updated)
    });
  } catch (err) {
    console.error("/daily-reward error", err);
    res.status(500).json({
      success: false,
      message: "Daily reward failed"
    });
  }
});

app.get("/player/:userId", requireDb, async (req, res) => {
  const user = await db.collection("users").findOne({
    userId: req.params.userId
  });

  if (!user) {
    return res.json({
      success: false,
      message: "Player not found"
    });
  }

  res.json({
    success: true,
    user: publicUser(user),
    player: publicUser(user)
  });
});

app.get("/leaderboard", requireDb, async (req, res) => {
  try {
    const top = await db.collection("users")
      .find(
        {},
        {
          projection: {
            _id: 0,
            userId: 1,
            telegramId: 1,
            telegram: 1,
            username: 1,
            firstName: 1,
            photoUrl: 1,
            points: 1,
            coins: 1,
            xp: 1,
            taps: 1,
            streak: 1,
            rank: 1,
            referrals: 1,
            referralEarnings: 1
          }
        }
      )
      .sort({
        points: -1,
        xp: -1,
        referrals: -1
      })
      .limit(100)
      .toArray();

    res.json({
      success: true,
      leaderboard: top
    });
  } catch (err) {
    console.error("/leaderboard error", err);
    res.status(500).json({
      success: false,
      message: "Leaderboard failed"
    });
  }
});

app.get("/stats", requireDb, async (req, res) => {
  const users = db.collection("users");

  const totalUsers = await users.countDocuments();
  const totalReferrals = await db.collection("referrals").countDocuments();
  const top = await users.find({}).sort({ points: -1 }).limit(1).toArray();

  res.json({
    success: true,
    totalUsers,
    totalReferrals,
    topPlayer: top[0] ? publicUser(top[0]) : null
  });
});

app.get("/ref/:code", (req, res) => {
  res.redirect(
    `https://t.me/DelayDogeGameBot?start=${encodeURIComponent(req.params.code)}`
  );
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

start()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server Running on " + PORT);
    });
  })
  .catch((err) => {
    console.error("MongoDB failed", err);
    process.exit(1);
  });
