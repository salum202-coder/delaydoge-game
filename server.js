
require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();

app.use((req, res, next) => {
  const allowedOrigins = ["https://delaydoge-game.onrender.com", "https://delaydoge-app.onrender.com"];
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes(origin) ? origin : "https://delaydoge-game.onrender.com");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const BASE_ENERGY = 100;
const BASE_REGEN_MS = 5000;
const MAX_INITDATA_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_TAP_INTERVAL_MS = 140;
const BASE_MAX_COMBO = 5;
const DAILY_MS = 24 * 60 * 60 * 1000;
const STREAK_RESET_MS = 48 * 60 * 60 * 1000;

const DAILY_REWARDS = [
  { day: 1, points: 100, xp: 100, energy: 20 },
  { day: 2, points: 150, xp: 150, energy: 25 },
  { day: 3, points: 200, xp: 200, energy: 30 },
  { day: 4, points: 250, xp: 250, energy: 35 },
  { day: 5, points: 300, xp: 300, energy: 40 },
  { day: 6, points: 400, xp: 400, energy: 50 },
  { day: 7, points: 600, xp: 600, energy: BASE_ENERGY }
];

const TASK_REWARDS = {
  tap50: { points: 80, xp: 80, label: "Tap 50 times today" },
  spinDaily: { points: 120, xp: 80, label: "Use Daily Spin" },
  openBox: { points: 150, xp: 100, label: "Open 1 Mystery Box" },
  invite1: { points: 250, xp: 250, label: "Invite your first friend" }
};

const STAGES = [
  { id: "lazy_start", title: "Lazy Start", icon: "😴", unlockLevel: 1, reward: { points: 120, xp: 80, boxes: 0, energy: 10 }, desc: "Every legend starts late." },
  { id: "neighborhood_delivery", title: "Neighborhood Delivery", icon: "📦", unlockLevel: 3, reward: { points: 260, xp: 160, boxes: 1, energy: 15 }, desc: "The first package is already delayed." },
  { id: "traffic_hell", title: "Traffic Hell", icon: "🚦", unlockLevel: 5, reward: { points: 420, xp: 240, boxes: 1, energy: 20 }, desc: "Traffic is DelayDoge's natural habitat." },
  { id: "customs_checkpoint", title: "Customs Checkpoint", icon: "🛃", unlockLevel: 8, reward: { points: 700, xp: 420, boxes: 2, energy: 25 }, desc: "All shipments are subject to delay." },
  { id: "karen_complaint_zone", title: "Karen Complaint Zone", icon: "😡", unlockLevel: 12, reward: { points: 1000, xp: 650, boxes: 2, energy: 30 }, desc: "Complaint received. Delivery delayed again." },
  { id: "legendary_delivery", title: "Legendary Delivery", icon: "👑", unlockLevel: 18, reward: { points: 1800, xp: 1200, boxes: 3, energy: 50 }, desc: "Late, but legendary." }
];

const UPGRADE_CONFIG = {
  tapPower: { id: "tapPower", title: "Tap Power", icon: "👆", desc: "+1 extra point per combo tap level.", baseCost: 500, costStep: 350, max: 10 },
  energyCap: { id: "energyCap", title: "Energy Capacity", icon: "⚡", desc: "+20 max energy per level.", baseCost: 700, costStep: 450, max: 8 },
  regenSpeed: { id: "regenSpeed", title: "Energy Regen", icon: "🔋", desc: "Faster energy recovery.", baseCost: 900, costStep: 500, max: 7 },
  comboBoost: { id: "comboBoost", title: "Combo Boost", icon: "🔥", desc: "+1 max combo per level.", baseCost: 1000, costStep: 700, max: 5 },
  boxLuck: { id: "boxLuck", title: "Box Luck", icon: "🎁", desc: "Better Mystery Box chances.", baseCost: 1200, costStep: 800, max: 5 }
};

const SPIN_REWARDS = [
  { id: "points100", label: "+100 pts", weight: 28, points: 100, xp: 35, energy: 0, boxes: 0 },
  { id: "points250", label: "+250 pts", weight: 18, points: 250, xp: 80, energy: 0, boxes: 0 },
  { id: "xp150", label: "+150 XP", weight: 18, points: 50, xp: 150, energy: 0, boxes: 0 },
  { id: "energy40", label: "+40 Energy", weight: 18, points: 40, xp: 40, energy: 40, boxes: 0 },
  { id: "box1", label: "+1 Mystery Box", weight: 12, points: 80, xp: 80, energy: 0, boxes: 1 },
  { id: "jackpot", label: "Legendary Bonus", weight: 6, points: 600, xp: 300, energy: 60, boxes: 1 }
];

const BOX_REWARDS = [
  { id: "small", label: "Small Delay Pack", weight: 36, points: 150, xp: 80, energy: 10, boxes: 0 },
  { id: "medium", label: "Lost Parcel", weight: 28, points: 320, xp: 160, energy: 20, boxes: 0 },
  { id: "energy", label: "Delay Fuel", weight: 20, points: 100, xp: 120, energy: 60, boxes: 0 },
  { id: "big", label: "Customs Release", weight: 12, points: 700, xp: 360, energy: 30, boxes: 0 },
  { id: "legendary", label: "Legendary Delivery", weight: 4, points: 1500, xp: 900, energy: 100, boxes: 1 }
];

let db;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function cleanObj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
function sameDay(ts, day = todayKey()) {
  if (!ts) return false;
  try { return new Date(ts).toISOString().slice(0, 10) === day; } catch { return false; }
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
function sanitizeReferralCode(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 80);
}
function timingSafeEqualHex(a, b) {
  try {
    const aBuffer = Buffer.from(a, "hex");
    const bBuffer = Buffer.from(b, "hex");
    if (aBuffer.length !== bBuffer.length) return false;
    return crypto.timingSafeEqual(aBuffer, bBuffer);
  } catch { return false; }
}

function verifyTelegramInitData(initData) {
  if (!initData || typeof initData !== "string" || !TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = safeNumber(params.get("auth_date"), 0);
  const rawUser = params.get("user");
  const startParam = sanitizeReferralCode(params.get("start_param") || "");
  if (!hash || !authDate || !rawUser) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > MAX_INITDATA_AGE_SECONDS) return null;
  params.delete("hash");
  const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeEqualHex(calculatedHash, hash)) return null;
  try {
    const user = JSON.parse(rawUser);
    if (!user || !user.id) return null;
    return { user, startParam };
  } catch { return null; }
}

function getUpgradeLevel(player, id) {
  return Math.max(0, Math.floor(safeNumber(cleanObj(player.upgrades)[id], 0)));
}
function getMaxEnergy(player) {
  return BASE_ENERGY + getUpgradeLevel(player, "energyCap") * 20;
}
function getRegenMs(player) {
  return Math.max(1800, BASE_REGEN_MS - getUpgradeLevel(player, "regenSpeed") * 450);
}
function getMaxCombo(player) {
  return BASE_MAX_COMBO + getUpgradeLevel(player, "comboBoost");
}
function getTapPower(player) {
  return 1 + getUpgradeLevel(player, "tapPower");
}
function getUpgradeCost(player, id) {
  const cfg = UPGRADE_CONFIG[id];
  if (!cfg) return 0;
  const level = getUpgradeLevel(player, id);
  return Math.floor(cfg.baseCost + cfg.costStep * level * 1.25);
}
function getUpgradeState(player) {
  const result = {};
  for (const [id, cfg] of Object.entries(UPGRADE_CONFIG)) {
    const level = getUpgradeLevel(player, id);
    result[id] = { ...cfg, level, cost: getUpgradeCost(player, id), maxed: level >= cfg.max };
  }
  return result;
}
function pickWeighted(items, luckBoost = 0) {
  const boosted = items.map((item) => {
    let weight = item.weight;
    if (["big", "legendary", "jackpot"].includes(item.id)) weight += luckBoost * 2;
    return { ...item, weight };
  });
  const total = boosted.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of boosted) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return boosted[0];
}
function applyEnergyRegen(player) {
  const now = Date.now();
  const maxEnergy = getMaxEnergy(player);
  const regenMs = getRegenMs(player);
  let energy = safeNumber(player.energy, maxEnergy);
  let lastEnergyAt = safeNumber(player.lastEnergyAt, now);
  energy = Math.max(0, Math.min(maxEnergy, energy));
  if (energy >= maxEnergy) return { energy: maxEnergy, lastEnergyAt: now };
  const elapsed = Math.max(0, now - lastEnergyAt);
  const gained = Math.floor(elapsed / regenMs);
  if (gained <= 0) return { energy, lastEnergyAt };
  const newEnergy = Math.min(maxEnergy, energy + gained);
  return { energy: newEnergy, lastEnergyAt: newEnergy >= maxEnergy ? now : lastEnergyAt + gained * regenMs };
}

function buildStages(player) {
  const level = calculateLevel(player.xp);
  const claimed = cleanObj(player.claimedStageRewards);
  return STAGES.map((stage) => ({ ...stage, unlocked: level >= stage.unlockLevel, claimed: Boolean(claimed[stage.id]) }));
}
function buildGameState(player) {
  const day = todayKey();
  const lastSpinAt = safeNumber(player.lastSpinAt, 0);
  const stages = buildStages(player);
  const currentStage = [...stages].reverse().find((s) => s.unlocked) || stages[0];
  return {
    stages,
    currentStage,
    boxes: safeNumber(player.boxes, 0),
    boxesOpened: safeNumber(player.boxesOpened, 0),
    todayBoxesOpened: player.todayKey === day ? safeNumber(player.todayBoxesOpened, 0) : 0,
    upgrades: getUpgradeState(player),
    tapPower: getTapPower(player),
    maxEnergy: getMaxEnergy(player),
    regenMs: getRegenMs(player),
    maxCombo: getMaxCombo(player),
    lastSpinAt,
    canSpin: !lastSpinAt || !sameDay(lastSpinAt, day),
    nextSpinAt: lastSpinAt ? lastSpinAt + DAILY_MS : 0,
    spinCount: safeNumber(player.spinCount, 0)
  };
}
function publicPlayer(player) {
  const xp = safeNumber(player.xp, 0);
  const now = Date.now();
  const lastDailyRewardAt = safeNumber(player.lastDailyRewardAt, 0);
  const nextDailyAt = lastDailyRewardAt ? lastDailyRewardAt + DAILY_MS : 0;
  const game = buildGameState(player);
  return {
    userId: player.userId,
    telegramId: player.telegramId,
    username: player.username || "",
    firstName: player.firstName || "",
    lastName: player.lastName || "",
    photoUrl: player.photoUrl || "",
    points: safeNumber(player.points, 0),
    xp,
    energy: safeNumber(player.energy, game.maxEnergy),
    maxEnergy: game.maxEnergy,
    taps: safeNumber(player.taps, 0),
    combo: safeNumber(player.combo, 1),
    level: calculateLevel(xp),
    rank: getRank(xp),
    dailyStreak: safeNumber(player.dailyStreak, 0),
    lastDailyRewardAt,
    canClaimDaily: !lastDailyRewardAt || now >= nextDailyAt,
    nextDailyAt,
    todayTaps: safeNumber(player.todayTaps, 0),
    todayPointsEarned: safeNumber(player.todayPointsEarned, 0),
    todayKey: player.todayKey || todayKey(),
    referrals: safeNumber(player.referrals, 0),
    referralPoints: safeNumber(player.referralPoints, 0),
    invitedBy: player.invitedBy || "",
    inviteCode: player.inviteCode || player.userId,
    claimedTasks: cleanObj(player.claimedTasks),
    boxes: game.boxes,
    upgrades: cleanObj(player.upgrades),
    game
  };
}

async function applyReferralIfNeeded(player, referralCode) {
  const cleanCode = sanitizeReferralCode(referralCode);
  if (!cleanCode || player.invitedBy || cleanCode === player.userId) return;
  const referrer = await db.collection("users").findOne({ inviteCode: cleanCode });
  if (!referrer || referrer.userId === player.userId) return;
  const setResult = await db.collection("users").updateOne(
    { userId: player.userId, $or: [{ invitedBy: "" }, { invitedBy: { $exists: false } }] },
    { $set: { invitedBy: referrer.userId, invitedAt: new Date(), updatedAt: new Date() } }
  );
  if (setResult.modifiedCount > 0) {
    await db.collection("users").updateOne(
      { userId: referrer.userId },
      { $inc: { referrals: 1, referralPoints: 250, points: 250, xp: 250 }, $set: { updatedAt: new Date() } }
    );
  }
}

async function getPlayer(initData, options = {}) {
  const verified = verifyTelegramInitData(initData);
  if (!verified) return null;
  const tg = verified.user;
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
        energy: BASE_ENERGY,
        maxEnergy: BASE_ENERGY,
        taps: 0,
        combo: 1,
        lastTapAt: 0,
        lastSyncAt: 0,
        lastEnergyAt: Date.now(),
        suspicious: 0,
        dailyStreak: 0,
        lastDailyRewardAt: 0,
        inviteCode: userId,
        invitedBy: "",
        referrals: 0,
        referralPoints: 0,
        todayKey: todayKey(),
        todayTaps: 0,
        todayPointsEarned: 0,
        todayBoxesOpened: 0,
        boxes: 1,
        boxesOpened: 0,
        spinCount: 0,
        lastSpinAt: 0,
        upgrades: {},
        claimedStageRewards: {},
        claimedTasks: {},
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

  let player = await db.collection("users").findOne({ userId });
  const referralCode = verified.startParam || options.referralCode || "";
  await applyReferralIfNeeded(player, referralCode);
  player = await db.collection("users").findOne({ userId });
  const regen = applyEnergyRegen(player);

  await db.collection("users").updateOne(
    { userId },
    { $set: { energy: regen.energy, maxEnergy: getMaxEnergy(player), lastEnergyAt: regen.lastEnergyAt, updatedAt: new Date() } }
  );

  player.energy = regen.energy;
  player.maxEnergy = getMaxEnergy(player);
  player.lastEnergyAt = regen.lastEnergyAt;
  return player;
}

async function getTasksForPlayer(player) {
  const day = todayKey();
  const claimedTasks = cleanObj(player.claimedTasks);
  const todayTaps = player.todayKey === day ? safeNumber(player.todayTaps, 0) : 0;
  const todayBoxesOpened = player.todayKey === day ? safeNumber(player.todayBoxesOpened, 0) : 0;
  const spunToday = sameDay(safeNumber(player.lastSpinAt, 0), day);
  return {
    tap50: { id: "tap50", title: "Tap 50 times today", progress: todayTaps, target: 50, reward: TASK_REWARDS.tap50, completed: todayTaps >= 50, claimed: Boolean(claimedTasks.tap50 === day) },
    spinDaily: { id: "spinDaily", title: "Use Daily Spin", progress: spunToday ? 1 : 0, target: 1, reward: TASK_REWARDS.spinDaily, completed: spunToday, claimed: Boolean(claimedTasks.spinDaily === day) },
    openBox: { id: "openBox", title: "Open 1 Mystery Box", progress: Math.min(1, todayBoxesOpened), target: 1, reward: TASK_REWARDS.openBox, completed: todayBoxesOpened >= 1, claimed: Boolean(claimedTasks.openBox === day) },
    invite1: { id: "invite1", title: "Invite your first friend", progress: Math.min(1, safeNumber(player.referrals, 0)), target: 1, reward: TASK_REWARDS.invite1, completed: safeNumber(player.referrals, 0) >= 1, claimed: Boolean(claimedTasks.invite1) }
  };
}
async function getBundle(player) {
  const updated = await db.collection("users").findOne({ userId: player.userId });
  return { player: publicPlayer(updated), tasks: await getTasksForPlayer(updated), game: buildGameState(updated) };
}

app.get("/health", (req, res) => {
  res.json({ success: true, status: "online", app: "DelayDoge API", version: "V19 Game Expansion", time: new Date() });
});

app.post("/auth", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData, { referralCode: req.body.referralCode });
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    res.json(await getBundle(player));
  } catch (e) {
    console.error("AUTH ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/tap", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });

    let points = safeNumber(player.points, 0);
    let xp = safeNumber(player.xp, 0);
    let energy = safeNumber(player.energy, getMaxEnergy(player));
    let taps = safeNumber(player.taps, 0);
    let combo = safeNumber(player.combo, 1);
    let lastTapAt = safeNumber(player.lastTapAt, 0);
    let suspicious = safeNumber(player.suspicious, 0);
    const now = Date.now();
    const gap = lastTapAt ? now - lastTapAt : 9999;

    if (gap < MIN_TAP_INTERVAL_MS) {
      suspicious += 1;
      await db.collection("users").updateOne({ userId: player.userId }, { $set: { suspicious, lastSyncAt: now, updatedAt: new Date() } });
      const bundle = await getBundle(player);
      return res.json({ ...bundle.player, tasks: bundle.tasks, game: bundle.game, gained: { points: 0, xp: 0, taps: 0 }, message: "Too fast. Slow down." });
    }

    if (energy <= 0) {
      const bundle = await getBundle(player);
      return res.json({ ...bundle.player, tasks: bundle.tasks, game: bundle.game, gained: { points: 0, xp: 0, taps: 0 }, message: "Energy empty. Wait for recharge." });
    }

    combo = gap < 800 ? Math.min(combo + 1, getMaxCombo(player)) : 1;
    const tapPower = getTapPower(player);
    const pointsGain = combo * tapPower;
    const xpGain = combo * 2 + tapPower;
    const day = todayKey();
    const sameToday = player.todayKey === day;
    const todayTaps = (sameToday ? safeNumber(player.todayTaps, 0) : 0) + 1;
    const todayPointsEarned = (sameToday ? safeNumber(player.todayPointsEarned, 0) : 0) + pointsGain;

    points += pointsGain;
    xp += xpGain;
    energy = Math.max(0, energy - 1);
    taps += 1;

    await db.collection("users").updateOne(
      { userId: player.userId },
      {
        $set: {
          points, xp, energy, maxEnergy: getMaxEnergy(player), taps, combo,
          lastTapAt: now, lastSyncAt: now,
          lastEnergyAt: energy < getMaxEnergy(player) ? now : player.lastEnergyAt,
          suspicious, level: calculateLevel(xp), rank: getRank(xp),
          todayKey: day, todayTaps, todayPointsEarned, updatedAt: new Date()
        }
      }
    );

    const bundle = await getBundle(player);
    res.json({ ...bundle.player, tasks: bundle.tasks, game: bundle.game, gained: { points: pointsGain, xp: xpGain, taps: 1 } });
  } catch (e) {
    console.error("TAP ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/daily", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const now = Date.now();
    const lastDailyRewardAt = safeNumber(player.lastDailyRewardAt, 0);
    if (lastDailyRewardAt && now - lastDailyRewardAt < DAILY_MS) return res.json({ ok: false, message: "Daily reward already claimed.", nextDailyAt: lastDailyRewardAt + DAILY_MS, ...(await getBundle(player)) });

    let streak = safeNumber(player.dailyStreak, 0);
    streak = !lastDailyRewardAt || now - lastDailyRewardAt > STREAK_RESET_MS ? 1 : streak + 1;
    const reward = DAILY_REWARDS[Math.min(streak, 7) - 1] || DAILY_REWARDS[6];
    const maxEnergy = getMaxEnergy(player);
    const points = safeNumber(player.points, 0) + reward.points;
    const xp = safeNumber(player.xp, 0) + reward.xp;
    const energy = Math.min(maxEnergy, safeNumber(player.energy, maxEnergy) + reward.energy);

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points, xp, energy, maxEnergy, dailyStreak: streak, lastDailyRewardAt: now, level: calculateLevel(xp), rank: getRank(xp), updatedAt: new Date() } }
    );

    res.json({ ok: true, message: `Daily reward claimed! Day ${streak}`, reward, ...(await getBundle(player)) });
  } catch (e) {
    console.error("DAILY ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/tasks", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    res.json(await getBundle(player));
  } catch (e) {
    console.error("TASKS ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/claim-task", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    const taskId = String(req.body.taskId || "");
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const tasks = await getTasksForPlayer(player);
    const task = tasks[taskId];
    if (!task || !TASK_REWARDS[taskId]) return res.status(400).json({ error: "Unknown task" });
    if (!task.completed) return res.json({ ok: false, message: "Task not completed yet.", ...(await getBundle(player)) });
    if (task.claimed) return res.json({ ok: false, message: "Task already claimed.", ...(await getBundle(player)) });

    const reward = TASK_REWARDS[taskId];
    const points = safeNumber(player.points, 0) + reward.points;
    const xp = safeNumber(player.xp, 0) + reward.xp;
    const claimedTasks = cleanObj(player.claimedTasks);
    const day = todayKey();
    claimedTasks[taskId] = ["tap50", "spinDaily", "openBox"].includes(taskId) ? day : true;

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points, xp, claimedTasks, level: calculateLevel(xp), rank: getRank(xp), updatedAt: new Date() } }
    );

    res.json({ ok: true, message: `Task reward claimed: +${reward.points} points`, reward, ...(await getBundle(player)) });
  } catch (e) {
    console.error("CLAIM TASK ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/spin", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const day = todayKey();
    const lastSpinAt = safeNumber(player.lastSpinAt, 0);
    if (lastSpinAt && sameDay(lastSpinAt, day)) return res.json({ ok: false, message: "Daily Spin already used.", reward: null, ...(await getBundle(player)) });

    const reward = pickWeighted(SPIN_REWARDS, getUpgradeLevel(player, "boxLuck"));
    const maxEnergy = getMaxEnergy(player);
    const points = safeNumber(player.points, 0) + safeNumber(reward.points, 0);
    const xp = safeNumber(player.xp, 0) + safeNumber(reward.xp, 0);
    const energy = Math.min(maxEnergy, safeNumber(player.energy, maxEnergy) + safeNumber(reward.energy, 0));
    const boxes = safeNumber(player.boxes, 0) + safeNumber(reward.boxes, 0);

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points, xp, energy, boxes, lastSpinAt: Date.now(), todayKey: day, level: calculateLevel(xp), rank: getRank(xp), updatedAt: new Date() }, $inc: { spinCount: 1 } }
    );

    res.json({ ok: true, message: `Spin reward: ${reward.label}`, reward, ...(await getBundle(player)) });
  } catch (e) {
    console.error("SPIN ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/open-box", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const currentBoxes = safeNumber(player.boxes, 0);
    if (currentBoxes <= 0) return res.json({ ok: false, message: "No Mystery Boxes available.", reward: null, ...(await getBundle(player)) });

    const reward = pickWeighted(BOX_REWARDS, getUpgradeLevel(player, "boxLuck"));
    const day = todayKey();
    const sameToday = player.todayKey === day;
    const maxEnergy = getMaxEnergy(player);
    const points = safeNumber(player.points, 0) + safeNumber(reward.points, 0);
    const xp = safeNumber(player.xp, 0) + safeNumber(reward.xp, 0);
    const energy = Math.min(maxEnergy, safeNumber(player.energy, maxEnergy) + safeNumber(reward.energy, 0));
    const boxes = Math.max(0, currentBoxes - 1 + safeNumber(reward.boxes, 0));
    const todayBoxesOpened = (sameToday ? safeNumber(player.todayBoxesOpened, 0) : 0) + 1;

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points, xp, energy, boxes, todayKey: day, todayBoxesOpened, level: calculateLevel(xp), rank: getRank(xp), updatedAt: new Date() }, $inc: { boxesOpened: 1 } }
    );

    res.json({ ok: true, message: `Mystery Box: ${reward.label}`, reward, ...(await getBundle(player)) });
  } catch (e) {
    console.error("OPEN BOX ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/upgrade", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    const upgradeId = String(req.body.upgradeId || "");
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const cfg = UPGRADE_CONFIG[upgradeId];
    if (!cfg) return res.status(400).json({ error: "Unknown upgrade" });
    const level = getUpgradeLevel(player, upgradeId);
    if (level >= cfg.max) return res.json({ ok: false, message: "Upgrade already maxed.", ...(await getBundle(player)) });

    const cost = getUpgradeCost(player, upgradeId);
    const points = safeNumber(player.points, 0);
    if (points < cost) return res.json({ ok: false, message: `Need ${cost} points.`, ...(await getBundle(player)) });

    const upgrades = cleanObj(player.upgrades);
    upgrades[upgradeId] = level + 1;

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points: points - cost, upgrades, maxEnergy: getMaxEnergy({ ...player, upgrades }), updatedAt: new Date() } }
    );

    res.json({ ok: true, message: `${cfg.title} upgraded to level ${level + 1}`, upgrade: { id: upgradeId, level: level + 1, cost }, ...(await getBundle(player)) });
  } catch (e) {
    console.error("UPGRADE ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/claim-stage", async (req, res) => {
  try {
    const player = await getPlayer(req.body.initData);
    const stageId = String(req.body.stageId || "");
    if (!player) return res.status(403).json({ error: "Invalid Telegram data" });
    const stage = STAGES.find((s) => s.id === stageId);
    if (!stage) return res.status(400).json({ error: "Unknown stage" });
    const level = calculateLevel(player.xp);
    if (level < stage.unlockLevel) return res.json({ ok: false, message: "Stage is still locked.", ...(await getBundle(player)) });

    const claimedStageRewards = cleanObj(player.claimedStageRewards);
    if (claimedStageRewards[stageId]) return res.json({ ok: false, message: "Stage reward already claimed.", ...(await getBundle(player)) });

    const reward = stage.reward || {};
    const maxEnergy = getMaxEnergy(player);
    const points = safeNumber(player.points, 0) + safeNumber(reward.points, 0);
    const xp = safeNumber(player.xp, 0) + safeNumber(reward.xp, 0);
    const energy = Math.min(maxEnergy, safeNumber(player.energy, maxEnergy) + safeNumber(reward.energy, 0));
    const boxes = safeNumber(player.boxes, 0) + safeNumber(reward.boxes, 0);
    claimedStageRewards[stageId] = true;

    await db.collection("users").updateOne(
      { userId: player.userId },
      { $set: { points, xp, energy, boxes, claimedStageRewards, level: calculateLevel(xp), rank: getRank(xp), updatedAt: new Date() } }
    );

    res.json({ ok: true, message: `${stage.title} reward claimed`, reward, stage, ...(await getBundle(player)) });
  } catch (e) {
    console.error("CLAIM STAGE ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const leaders = await db.collection("users")
      .find({}, { projection: { userId: 1, username: 1, firstName: 1, points: 1, xp: 1, level: 1, photoUrl: 1 } })
      .sort({ points: -1, xp: -1 })
      .limit(20)
      .toArray();

    res.json({
      leaders: leaders.map((p, index) => ({
        rank: index + 1,
        name: p.username ? `@${p.username}` : (p.firstName || "Delay Player"),
        points: safeNumber(p.points, 0),
        xp: safeNumber(p.xp, 0),
        level: calculateLevel(p.xp || 0),
        photoUrl: p.photoUrl || ""
      }))
    });
  } catch (e) {
    console.error("LEADERBOARD ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

async function start() {
  if (!MONGO_URI) throw new Error("Missing MONGO_URI");
  if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("delaydoge");

  await db.collection("users").createIndex({ userId: 1 }, { unique: true });
  await db.collection("users").createIndex({ telegramId: 1 });
  await db.collection("users").createIndex({ inviteCode: 1 });
  await db.collection("users").createIndex({ points: -1 });
  await db.collection("users").createIndex({ xp: -1 });

  console.log("✅ MongoDB Connected");
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error("❌ Server failed to start:", err);
  process.exit(1);
});
