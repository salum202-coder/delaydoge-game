const express = require("express");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");
const cors = require("cors");
const path = require("path");

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
  console.log("MongoDB Connected 🔥");
}

start().catch(console.error);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/save", async (req, res) => {
  const data = req.body;

  if (!data.userId) {
    return res.status(400).json({ success: false, message: "userId is required" });
  }

  await db.collection("players").updateOne(
    { userId: data.userId },
    {
      $set: {
        userId: data.userId,
        coins: Number(data.coins) || 0,
        xp: Number(data.xp) || 0,
        taps: Number(data.taps) || 0,
        streak: Number(data.streak) || 0,
        energy: Number(data.energy) || 100,
        rank: data.rank || "Rookie",
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date(),
        lastDailyReward: null
      }
    },
    { upsert: true }
  );

  res.json({ success: true });
});

app.get("/player/:userId", async (req, res) => {
  const player = await db.collection("players").findOne(
    { userId: req.params.userId },
    { projection: { _id: 0 } }
  );

  if (!player) {
    return res.json({ success: false, message: "Player not found" });
  }

  res.json({ success: true, player });
});

app.post("/daily-reward", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId is required" });
  }

  const today = new Date().toISOString().slice(0, 10);

  const player = await db.collection("players").findOne({ userId });

  if (player && player.lastDailyReward === today) {
    return res.json({
      success: false,
      message: "Already claimed today",
      alreadyClaimed: true
    });
  }

  const currentStreak = Number(player?.streak) || 0;
  const newStreak = currentStreak + 1;
  const reward = 50 + newStreak * 10;

  const result = await db.collection("players").findOneAndUpdate(
    { userId },
    {
      $inc: {
        coins: reward,
        xp: reward
      },
      $set: {
        energy: 100,
        streak: newStreak,
        lastDailyReward: today,
        updatedAt: new Date()
      },
      $setOnInsert: {
        userId,
        taps: 0,
        rank: "Rookie",
        createdAt: new Date()
      }
    },
    {
      upsert: true,
      returnDocument: "after",
      projection: { _id: 0 }
    }
  );

  res.json({
    success: true,
    message: `Daily reward claimed +${reward}`,
    reward,
    player: result.value
  });
});

app.get("/leaderboard", async (req, res) => {
  const top = await db
    .collection("players")
    .find({}, { projection: { _id: 0, userId: 1, coins: 1, xp: 1, taps: 1, streak: 1, rank: 1 } })
    .sort({ coins: -1, xp: -1 })
    .limit(20)
    .toArray();

  res.json({ success: true, leaderboard: top });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running on " + PORT);
});