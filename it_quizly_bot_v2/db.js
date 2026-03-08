const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "quiz.db");
let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
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
      last_played TEXT,
      rainbow_nick INTEGER DEFAULT 0,
      timer_bonus INTEGER DEFAULT 0,
      dice_wins INTEGER DEFAULT 0,
      dice_losses INTEGER DEFAULT 0,
      dice_earned INTEGER DEFAULT 0,
      mine_wins INTEGER DEFAULT 0,
      mine_losses INTEGER DEFAULT 0,
      mine_earned INTEGER DEFAULT 0,
      duel_wins INTEGER DEFAULT 0,
      duel_losses INTEGER DEFAULT 0,
      duel_earned INTEGER DEFAULT 0,
      last_daily TEXT DEFAULT NULL
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
    CREATE TABLE IF NOT EXISTS dice_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      initiator_id INTEGER NOT NULL,
      opponent_id INTEGER,
      bet INTEGER NOT NULL,
      initiator_roll INTEGER,
      opponent_roll INTEGER,
      initiator_msg_id INTEGER,
      opponent_msg_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      bet INTEGER NOT NULL,
      board TEXT NOT NULL,
      revealed TEXT NOT NULL,
      safe_found INTEGER DEFAULT 0,
      message_id INTEGER,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS duel_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      initiator_id INTEGER NOT NULL,
      opponent_id INTEGER,
      bet INTEGER NOT NULL,
      initiator_hp INTEGER DEFAULT 3,
      opponent_hp INTEGER DEFAULT 3,
      current_turn INTEGER,
      initiator_action TEXT,
      opponent_action TEXT,
      round INTEGER DEFAULT 1,
      message_id INTEGER,
      initiator_msg_id INTEGER,
      opponent_msg_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Russian roulette games
    CREATE TABLE IF NOT EXISTS roulette_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      initiator_id INTEGER NOT NULL,
      opponent_id INTEGER,
      bet INTEGER NOT NULL,
      current_turn INTEGER,        -- telegram_id whose turn it is
      chamber INTEGER DEFAULT 0,   -- current chamber position 0-5
      bullet INTEGER NOT NULL,     -- which chamber has the bullet 0-5
      status TEXT DEFAULT 'pending', -- pending | active | finished | cancelled
      loser_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const migrations = [
    "ALTER TABLE users ADD COLUMN rainbow_nick INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN timer_bonus INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN dice_wins INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN dice_losses INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN dice_earned INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN mine_wins INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN mine_losses INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN mine_earned INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN duel_wins INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN duel_losses INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN duel_earned INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN last_daily TEXT DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) {}
  }
}

function getOne(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}
function getAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

// ── Users ─────────────────────────────────────────────────────────────────────
function ensureUser(telegramId, username) {
  const existing = getUser(telegramId);
  if (!existing) {
    run("INSERT OR IGNORE INTO users (telegram_id, username, svodollars) VALUES (?, ?, 250)", telegramId, username || "Аноним");
  }
  return getUser(telegramId);
}

// Returns { ok, hoursLeft } — ok=true if bonus was claimed, hoursLeft if not yet
function claimDailyBonus(telegramId) {
  const user = getUser(telegramId);
  if (!user) return { ok: false, hoursLeft: 0 };

  if (user.last_daily) {
    const last = new Date(user.last_daily);
    const now = new Date();
    const diffMs = now - last;
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 24) {
      const hoursLeft = Math.ceil(24 - diffHours);
      return { ok: false, hoursLeft };
    }
  }

  run("UPDATE users SET svodollars = svodollars + 100, last_daily = datetime('now') WHERE telegram_id = ?", telegramId);
  return { ok: true };
}
function getUser(telegramId) {
  return getOne("SELECT * FROM users WHERE telegram_id = ?", telegramId);
}
function getAllUsers() {
  return getAll("SELECT telegram_id FROM users");
}
function addCoins(telegramId, amount) {
  run("UPDATE users SET svodollars = svodollars + ? WHERE telegram_id = ?", amount, telegramId);
}
function spendCoins(telegramId, amount) {
  const user = getUser(telegramId);
  if (!user || (user.svodollars || 0) < amount) return false;
  run("UPDATE users SET svodollars = svodollars - ? WHERE telegram_id = ?", amount, telegramId);
  return true;
}
function adminAddCoins(telegramId, amount) {
  run("UPDATE users SET svodollars = svodollars + ? WHERE telegram_id = ?", amount, telegramId);
}
function adminSetScore(telegramId, score) {
  run("UPDATE users SET total_score = ? WHERE telegram_id = ?", score, telegramId);
}

// ── Quiz sessions ─────────────────────────────────────────────────────────────
function createSession(telegramId, category, questions) {
  const existing = getOne("SELECT id FROM sessions WHERE telegram_id = ? AND finished = 0", telegramId);
  if (existing) run("UPDATE sessions SET finished = 1 WHERE id = ?", existing.id);
  run("INSERT INTO sessions (telegram_id, category, questions) VALUES (?, ?, ?)",
    telegramId, category, JSON.stringify(questions));
}
function getActiveSession(telegramId) {
  const s = getOne("SELECT * FROM sessions WHERE telegram_id = ? AND finished = 0 ORDER BY id DESC LIMIT 1", telegramId);
  if (!s) return null;
  return { ...s, questions: JSON.parse(s.questions) };
}
function updateSession(sessionId, currentIndex, score) {
  run("UPDATE sessions SET current_index = ?, score = ? WHERE id = ?", currentIndex, score, sessionId);
}
function setSessionTimerMsg(sessionId, messageId) {
  run("UPDATE sessions SET timer_message_id = ? WHERE id = ?", messageId, sessionId);
}
function finishSession(sessionId, telegramId, totalScore, correctCount, allCorrect, svoEarned) {
  run("UPDATE sessions SET finished = 1 WHERE id = ?", sessionId);
  const user = getUser(telegramId);
  const newStreak = allCorrect ? (user.streak || 0) + 1 : 0;
  const newBestStreak = Math.max(user.best_streak || 0, newStreak);
  run(
    `UPDATE users SET total_score=total_score+?, svodollars=svodollars+?,
     games_played=games_played+1, correct_answers=correct_answers+?,
     streak=?, best_streak=?, last_played=datetime('now') WHERE telegram_id=?`,
    totalScore, svoEarned || 0, correctCount, newStreak, newBestStreak, telegramId
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function getLeaderboard(mode = "quiz") {
  if (mode === "dice") return getAll(
    "SELECT telegram_id,username,rainbow_nick,dice_wins,dice_losses,dice_earned FROM users ORDER BY dice_wins DESC,dice_earned DESC LIMIT 10"
  );
  if (mode === "duel") return getAll(
    "SELECT telegram_id,username,rainbow_nick,duel_wins,duel_losses,duel_earned FROM users ORDER BY duel_wins DESC,duel_earned DESC LIMIT 10"
  );
  return getAll(
    "SELECT telegram_id,username,total_score,svodollars,games_played,correct_answers,best_streak,rainbow_nick,timer_bonus FROM users ORDER BY total_score DESC LIMIT 10"
  );
}

// ── Shop ──────────────────────────────────────────────────────────────────────
function buyRainbowNick(telegramId) {
  if (!spendCoins(telegramId, 15)) return false;
  run("UPDATE users SET rainbow_nick = 1 WHERE telegram_id = ?", telegramId);
  return true;
}
function buyTimerBonus(telegramId) {
  if (!spendCoins(telegramId, 10)) return false;
  run("UPDATE users SET timer_bonus = timer_bonus + 1 WHERE telegram_id = ?", telegramId);
  return true;
}
function useTimerBonus(telegramId) {
  const user = getUser(telegramId);
  if (!user || user.timer_bonus <= 0) return false;
  run("UPDATE users SET timer_bonus = timer_bonus - 1 WHERE telegram_id = ?", telegramId);
  return true;
}
function throwPoop(fromId, toId) {
  if (!spendCoins(fromId, 5)) return false;
  run("INSERT INTO poop_attacks (from_id, to_id) VALUES (?, ?)", fromId, toId);
  return true;
}
function burnCoins(telegramId, amount) {
  const user = getUser(telegramId);
  if (!user || (user.svodollars || 0) < amount) return false;
  run("UPDATE users SET svodollars = svodollars - ? WHERE telegram_id = ?", amount, telegramId);
  run("INSERT INTO burn_log (telegram_id, amount) VALUES (?, ?)", telegramId, amount);
  return true;
}
function getPoopCount(telegramId) {
  const row = getOne("SELECT COUNT(*) as cnt FROM poop_attacks WHERE to_id = ?", telegramId);
  return row ? (row.cnt || 0) : 0;
}

// ── Dice ──────────────────────────────────────────────────────────────────────
function createDiceGame(initiatorId, opponentId, bet) {
  if (!spendCoins(initiatorId, bet)) return null;
  const r = run("INSERT INTO dice_games (initiator_id, opponent_id, bet, status) VALUES (?, ?, ?, 'pending')",
    initiatorId, opponentId ?? null, bet);
  return r.lastInsertRowid;
}
function getDiceGame(gameId) {
  return getOne("SELECT * FROM dice_games WHERE id = ?", gameId);
}
function getDiceGameByUser(userId) {
  return getOne(
    "SELECT * FROM dice_games WHERE (initiator_id=? OR opponent_id=?) AND status IN ('pending','waiting_rolls') ORDER BY id DESC LIMIT 1",
    userId, userId
  );
}
function acceptDiceGame(gameId, opponentId) {
  const game = getDiceGame(gameId);
  if (!game) return false;
  if (!spendCoins(opponentId, game.bet)) return false;
  run("UPDATE dice_games SET opponent_id=?, status='waiting_rolls' WHERE id=?", opponentId, gameId);
  return true;
}
function setDiceRoll(gameId, userId, roll) {
  const game = getDiceGame(gameId);
  if (!game) return null;
  if (game.initiator_id === userId) run("UPDATE dice_games SET initiator_roll=? WHERE id=?", roll, gameId);
  else run("UPDATE dice_games SET opponent_roll=? WHERE id=?", roll, gameId);
  return getDiceGame(gameId);
}
function finishDiceGame(gameId) {
  const game = getDiceGame(gameId);
  if (!game) return null;
  run("UPDATE dice_games SET status='finished' WHERE id=?", gameId);
  const iWin = game.initiator_roll > game.opponent_roll;
  const isDraw = game.initiator_roll === game.opponent_roll;
  const pot = game.bet * 2;
  if (isDraw) {
    addCoins(game.initiator_id, game.bet);
    addCoins(game.opponent_id, game.bet);
  } else {
    const winnerId = iWin ? game.initiator_id : game.opponent_id;
    const loserId  = iWin ? game.opponent_id  : game.initiator_id;
    addCoins(winnerId, pot);
    run("UPDATE users SET dice_wins=dice_wins+1, dice_earned=dice_earned+? WHERE telegram_id=?", game.bet, winnerId);
    run("UPDATE users SET dice_losses=dice_losses+1 WHERE telegram_id=?", loserId);
  }
  return { ...game, isDraw, winnerId: isDraw ? null : (iWin ? game.initiator_id : game.opponent_id) };
}
function getOpenDiceGames() {
  return getAll("SELECT * FROM dice_games WHERE status='pending' AND opponent_id IS NULL ORDER BY id DESC LIMIT 10");
}

function cancelDiceGame(gameId) {
  const game = getDiceGame(gameId);
  if (!game) return;
  if (game.status === "pending") addCoins(game.initiator_id, game.bet);
  if (game.status === "waiting_rolls") {
    addCoins(game.initiator_id, game.bet);
    if (game.opponent_id) addCoins(game.opponent_id, game.bet);
  }
  run("UPDATE dice_games SET status='cancelled' WHERE id=?", gameId);
}
function setDiceMsgId(gameId, field, msgId) {
  run(`UPDATE dice_games SET ${field}=? WHERE id=?`, msgId, gameId);
}

// ── Minesweeper ───────────────────────────────────────────────────────────────
const MINE_TOTAL = 16;
const MINE_COUNT = 14;
const MINE_SAFE  = 2;

function generateMineBoard() {
  const board = Array(MINE_TOTAL).fill(false);
  let placed = 0;
  while (placed < MINE_COUNT) {
    const idx = Math.floor(Math.random() * MINE_TOTAL);
    if (!board[idx]) { board[idx] = true; placed++; }
  }
  return board;
}
function createMineGame(telegramId, bet) {
  if (!spendCoins(telegramId, bet)) return null;
  const board = generateMineBoard();
  const revealed = Array(MINE_TOTAL).fill(false);
  const r = run("INSERT INTO mine_games (telegram_id, bet, board, revealed) VALUES (?, ?, ?, ?)",
    telegramId, bet, JSON.stringify(board), JSON.stringify(revealed));
  return r.lastInsertRowid;
}
function getMineGame(gameId) {
  const g = getOne("SELECT * FROM mine_games WHERE id=?", gameId);
  if (!g) return null;
  return { ...g, board: JSON.parse(g.board), revealed: JSON.parse(g.revealed) };
}
function getActiveMineGame(telegramId) {
  const g = getOne("SELECT * FROM mine_games WHERE telegram_id=? AND status='active' ORDER BY id DESC LIMIT 1", telegramId);
  if (!g) return null;
  return { ...g, board: JSON.parse(g.board), revealed: JSON.parse(g.revealed) };
}
function revealMineCell(gameId, cellIndex) {
  const g = getMineGame(gameId);
  if (!g || g.status !== "active") return null;
  g.revealed[cellIndex] = true;
  const hitMine = g.board[cellIndex];
  if (hitMine) {
    run("UPDATE mine_games SET revealed=?, status='lost' WHERE id=?", JSON.stringify(g.revealed), gameId);
    run("UPDATE users SET mine_losses=mine_losses+1 WHERE telegram_id=?", g.telegram_id);
    return { ...g, hitMine: true, status: "lost" };
  }
  const safeFound = g.safe_found + 1;
  const won = safeFound >= MINE_SAFE;
  const newStatus = won ? "won" : "active";
  run("UPDATE mine_games SET revealed=?, safe_found=?, status=? WHERE id=?",
    JSON.stringify(g.revealed), safeFound, newStatus, gameId);
  if (won) {
    const payout = g.bet * 2;
    addCoins(g.telegram_id, payout);
    run("UPDATE users SET mine_wins=mine_wins+1, mine_earned=mine_earned+? WHERE telegram_id=?", g.bet, g.telegram_id);
  }
  return { ...g, revealed: g.revealed, safe_found: safeFound, hitMine: false, status: newStatus };
}
function cashoutMine(gameId) {
  const g = getMineGame(gameId);
  if (!g || g.status !== "active" || g.safe_found === 0) return null;
  const multiplier = 1.5;
  const payout = Math.floor(g.bet * multiplier);
  addCoins(g.telegram_id, payout);
  run("UPDATE mine_games SET status='cashed' WHERE id=?", gameId);
  run("UPDATE users SET mine_wins=mine_wins+1, mine_earned=mine_earned+? WHERE telegram_id=?",
    payout - g.bet, g.telegram_id);
  return { payout, multiplier };
}
function setMineMsgId(gameId, msgId) {
  run("UPDATE mine_games SET message_id=? WHERE id=?", msgId, gameId);
}

// ── Duel ──────────────────────────────────────────────────────────────────────
// ── Russian Roulette ──────────────────────────────────────────────────────────

function createRouletteGame(initiatorId, opponentId, bet) {
  if (!spendCoins(initiatorId, bet)) return null;
  const bullet = Math.floor(Math.random() * 6); // random chamber 0-5
  const r = run(
    "INSERT INTO roulette_games (initiator_id, opponent_id, bet, bullet, current_turn, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    initiatorId, opponentId ?? null, bet, bullet, initiatorId
  );
  return r.lastInsertRowid;
}

function getRouletteGame(gameId) {
  return getOne("SELECT * FROM roulette_games WHERE id=?", gameId);
}

function getRouletteGameByUser(userId) {
  return getOne(
    "SELECT * FROM roulette_games WHERE (initiator_id=? OR opponent_id=?) AND status IN ('pending','active') ORDER BY id DESC LIMIT 1",
    userId, userId
  );
}

function getOpenRouletteGames() {
  return getAll("SELECT * FROM roulette_games WHERE status='pending' AND opponent_id IS NULL ORDER BY id DESC LIMIT 10");
}

function acceptRouletteGame(gameId, opponentId) {
  const game = getRouletteGame(gameId);
  if (!game) return false;
  if (!spendCoins(opponentId, game.bet)) return false;
  run("UPDATE roulette_games SET opponent_id=?, status='active' WHERE id=?", opponentId, gameId);
  return true;
}

// Pull the trigger — returns { fired, chamber, nextTurn, finished, loserId, winnerId }
function pullTrigger(gameId, userId) {
  const game = getRouletteGame(gameId);
  if (!game || game.status !== "active") return null;
  if (game.current_turn !== userId) return null;

  const fired = game.chamber === game.bullet;
  const nextChamber = game.chamber + 1;
  const nextTurn = game.current_turn === game.initiator_id ? game.opponent_id : game.initiator_id;

  if (fired) {
    // This player lost
    const loserId  = userId;
    const winnerId = userId === game.initiator_id ? game.opponent_id : game.initiator_id;
    run("UPDATE roulette_games SET chamber=?, status='finished', loser_id=? WHERE id=?",
      nextChamber, loserId, gameId);
    addCoins(winnerId, game.bet * 2);
    run("UPDATE users SET duel_wins=duel_wins+1, duel_earned=duel_earned+? WHERE telegram_id=?", game.bet, winnerId);
    run("UPDATE users SET duel_losses=duel_losses+1 WHERE telegram_id=?", loserId);
    return { fired: true, chamber: game.chamber, finished: true, loserId, winnerId };
  }

  // Safe — advance chamber and switch turn
  run("UPDATE roulette_games SET chamber=?, current_turn=? WHERE id=?", nextChamber, nextTurn, gameId);
  return { fired: false, chamber: game.chamber, finished: false, nextTurn };
}

function cancelRouletteGame(gameId) {
  const game = getRouletteGame(gameId);
  if (!game) return;
  if (game.status === "pending") addCoins(game.initiator_id, game.bet);
  if (game.status === "active") {
    addCoins(game.initiator_id, game.bet);
    if (game.opponent_id) addCoins(game.opponent_id, game.bet);
  }
  run("UPDATE roulette_games SET status='cancelled' WHERE id=?", gameId);
}

// Keep old duel stubs so exports don't break — redirect to roulette
function createDuelGame(i, o, b)   { return createRouletteGame(i, o, b); }
function getDuelGame(id)            { return getRouletteGame(id); }
function getDuelGameByUser(uid)     { return getRouletteGameByUser(uid); }
function getOpenDuelGames()         { return getOpenRouletteGames(); }
function acceptDuelGame(id, oid)    { return acceptRouletteGame(id, oid); }
function cancelDuelGame(id)         { return cancelRouletteGame(id); }
function setDuelMsgId(gameId, field, msgId) {
  // roulette_games doesn't have msg fields yet — safe no-op
}

module.exports = {
  initDB,
  ensureUser, getUser, getAllUsers, addCoins, spendCoins, adminAddCoins, adminSetScore, claimDailyBonus,
  createSession, getActiveSession, updateSession, setSessionTimerMsg, finishSession,
  getLeaderboard,
  buyRainbowNick, buyTimerBonus, useTimerBonus, throwPoop, burnCoins, getPoopCount,
  createDiceGame, getDiceGame, getDiceGameByUser, getOpenDiceGames, acceptDiceGame, setDiceRoll,
  finishDiceGame, cancelDiceGame, setDiceMsgId,
  createMineGame, getMineGame, getActiveMineGame, revealMineCell, cashoutMine, setMineMsgId,
  MINE_TOTAL, MINE_SAFE,
  createDuelGame, getDuelGame, getDuelGameByUser, getOpenDuelGames, acceptDuelGame,
  cancelDuelGame, setDuelMsgId, pullTrigger,
  cancelDuelGame, setDuelMsgId, pullTrigger,
};
