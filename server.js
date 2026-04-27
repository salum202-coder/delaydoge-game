const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;

let db;

// ================================
// Mongo Start
// ================================
async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");
  console.log("MongoDB Connected");
}

// ================================
// Static Files
// ================================
app.use(express.static(path.join(__dirname)));

// ================================
// Telegram Login Save User
// ================================
app.post("/login", async (req, res) => {
  try {
    const user = req.body;

    if (!user || !user.id) {
      return res.status(400).json({ error: "No user data" });
    }

    const users = db.collection("users");

    let oldUser = await users.findOne({ telegramId: user.id });

    if (!oldUser) {
      await users.insertOne({
        telegramId: user.id,
        username: user.username || "",
        first_name: user.first_name || "",
        photo_url: user.photo_url || "",
        points: 0,
        referrals: 0,
        createdAt: new Date()
      });
    } else {
      await users.updateOne(
        { telegramId: user.id },
        {
          $set: {
            username: user.username || "",
            first_name: user.first_name || "",
            photo_url: user.photo_url || ""
          }
        }
      );
    }

    const finalUser = await users.findOne({ telegramId: user.id });

    res.json(finalUser);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "login failed" });
  }
});

// ================================
// Save Score
// ================================
app.post("/tap", async (req, res) => {
  try {
    const { id, points } = req.body;

    await db.collection("users").updateOne(
      { telegramId: id },
      { $set: { points: points } }
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "tap failed" });
  }
});

// ================================
// Leaderboard
// ================================
app.get("/leaderboard", async (req, res) => {
  try {
    const data = await db.collection("users")
      .find({})
      .sort({ points: -1 })
      .limit(50)
      .toArray();

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "leaderboard failed" });
  }
});

// ================================
// Telegram Referral Join
// ================================
app.get("/ref/:code", async (req, res) => {
  res.redirect(`https://t.me/DelayDogeGameBot?start=${req.params.code}`);
});

// ================================
// Main Page
// ================================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ================================
// Start Server AFTER Mongo
// ================================
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