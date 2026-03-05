const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "quiz.db");
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      total_score INTEGER DEFAULT 0,
      svodollars INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      correct_answers INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      last_played TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      questions TEXT NOT NULL,
      current_index INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      timer_message_id INTEGER DEFAULT NULL,
      finished INTEGER DEFAULT 0
    );
  `);

  // Migrate existing DBs
  try { db.run("ALTER TABLE users ADD COLUMN svodollars INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE sessions ADD COLUMN timer_message_id INTEGER DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN rainbow_nick INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN timer_bonus INTEGER DEFAULT 0"); } catch(e) {}

  // Shop: purchases log + poop attacks
  db.run(`
    CREATE TABLE IF NOT EXISTS poop_attacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS burn_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  save();
}

function save() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function ensureUser(telegramId, username) {
  db.run("INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)", [telegramId, username || "Аноним"]);
  save();
  return getOne("SELECT * FROM users WHERE telegram_id = ?", [telegramId]);
}

function getUser(telegramId) {
  return getOne("SELECT * FROM users WHERE telegram_id = ?", [telegramId]);
}

function getAllUsers() {
  return getAll("SELECT telegram_id FROM users");
}

function createSession(telegramId, category, questions) {
  const existing = getOne("SELECT id FROM sessions WHERE telegram_id = ? AND finished = 0", [telegramId]);
  if (existing) db.run("UPDATE sessions SET finished = 1 WHERE id = ?", [existing.id]);
  db.run("INSERT INTO sessions (telegram_id, category, questions) VALUES (?, ?, ?)",
    [telegramId, category, JSON.stringify(questions)]);
  save();
}

function getActiveSession(telegramId) {
  const session = getOne("SELECT * FROM sessions WHERE telegram_id = ? AND finished = 0 ORDER BY id DESC LIMIT 1", [telegramId]);
  if (!session) return null;
  return { ...session, questions: JSON.parse(session.questions) };
}

function updateSession(sessionId, currentIndex, score) {
  db.run("UPDATE sessions SET current_index = ?, score = ? WHERE id = ?", [currentIndex, score, sessionId]);
  save();
}

function setSessionTimerMsg(sessionId, messageId) {
  db.run("UPDATE sessions SET timer_message_id = ? WHERE id = ?", [messageId, sessionId]);
  save();
}

function finishSession(sessionId, telegramId, totalScore, correctCount, allCorrect, svoEarned) {
  db.run("UPDATE sessions SET finished = 1 WHERE id = ?", [sessionId]);
  const user = getUser(telegramId);
  const newStreak = allCorrect ? (user.streak || 0) + 1 : 0;
  const newBestStreak = Math.max(user.best_streak || 0, newStreak);
  db.run(
    `UPDATE users SET
      total_score = total_score + ?,
      svodollars = svodollars + ?,
      games_played = games_played + 1,
      correct_answers = correct_answers + ?,
      streak = ?,
      best_streak = ?,
      last_played = datetime('now')
    WHERE telegram_id = ?`,
    [totalScore, svoEarned || 0, correctCount, newStreak, newBestStreak, telegramId]
  );
  save();
}

function getLeaderboard() {
  return getAll(
    `SELECT telegram_id, username, total_score, svodollars, games_played, correct_answers, best_streak, rainbow_nick, timer_bonus
     FROM users ORDER BY total_score DESC LIMIT 10`
  );
}

// ── Магазин ───────────────────────────────────────────────────────────────────

function spendCoins(telegramId, amount) {
  const user = getUser(telegramId);
  if (!user || (user.svodollars || 0) < amount) return false;
  db.run("UPDATE users SET svodollars = svodollars - ? WHERE telegram_id = ?", [amount, telegramId]);
  save();
  return true;
}

function buyRainbowNick(telegramId) {
  if (!spendCoins(telegramId, 15)) return false;
  db.run("UPDATE users SET rainbow_nick = 1 WHERE telegram_id = ?", [telegramId]);
  save();
  return true;
}

function buyTimerBonus(telegramId) {
  if (!spendCoins(telegramId, 10)) return false;
  db.run("UPDATE users SET timer_bonus = timer_bonus + 1 WHERE telegram_id = ?", [telegramId]);
  save();
  return true;
}

function useTimerBonus(telegramId) {
  const user = getUser(telegramId);
  if (!user || user.timer_bonus <= 0) return false;
  db.run("UPDATE users SET timer_bonus = timer_bonus - 1 WHERE telegram_id = ?", [telegramId]);
  save();
  return true;
}

function throwPoop(fromId, toId) {
  if (!spendCoins(fromId, 5)) return false;
  db.run("INSERT INTO poop_attacks (from_id, to_id) VALUES (?, ?)", [fromId, toId]);
  save();
  return true;
}

function burnCoins(telegramId, amount) {
  const user = getUser(telegramId);
  if (!user || (user.svodollars || 0) < amount) return false;
  db.run("UPDATE users SET svodollars = svodollars - ? WHERE telegram_id = ?", [amount, telegramId]);
  db.run("INSERT INTO burn_log (telegram_id, amount) VALUES (?, ?)", [telegramId, amount]);
  save();
  return true;
}

function getPoopCount(telegramId) {
  const row = getOne("SELECT COUNT(*) as cnt FROM poop_attacks WHERE to_id = ?", [telegramId]);
  return row ? (row.cnt || 0) : 0;
}

function run_direct(sql, params = []) {
  db.run(sql, params);
  save();
}

module.exports = {
  initDB, save, ensureUser, getUser, getAllUsers,
  createSession, getActiveSession, updateSession, setSessionTimerMsg,
  finishSession, getLeaderboard,
  spendCoins, buyRainbowNick, buyTimerBonus, useTimerBonus,
  throwPoop, burnCoins, getPoopCount, run_direct,
};
