const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "logs.txt");

function timestamp() {
  return new Date().toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatUser(from) {
  const name = from.username ? `@${from.username}` : (from.first_name || "Аноним");
  return `${name} (id:${from.id || from})`;
}

function write(line) {
  const entry = `[${timestamp()}] ${line}\n`;
  process.stdout.write(entry);
  fs.appendFileSync(LOG_PATH, entry, "utf8");
}

function logMessage(from, text) {
  write(`💬 ${formatUser(from)}: ${text || "(не текст)"}`);
}

const BUTTON_LABELS = {
  "menu_main":        "🏠 Главное меню",
  "menu_play":        "🎮 Начать викторину",
  "menu_leaderboard": "🏆 Таблица лидеров",
  "menu_profile":     "📊 Мой профиль",
  "menu_rules":       "ℹ️ Правила",
  "menu_shop":        "🛒 Магазин",
  "menu_games":       "🎲 Раздел Игры",
  "shop_rainbow":     "🌈 Купить ник",
  "shop_timer":       "⏱ Купить таймер",
  "shop_burn_1":      "🔥 Сжечь 1 коин",
  "shop_burn_5":      "🔥 Сжечь 5 коинов",
};

function logButton(from, data) {
  let action;
  if (BUTTON_LABELS[data]) {
    action = BUTTON_LABELS[data];
  } else if (data.startsWith("cat_")) {
    action = `🗂 Выбрал тему: ${data.replace("cat_", "")}`;
  } else if (data.startsWith("ans_")) {
    const idx = parseInt(data.replace("ans_", ""));
    action = `✏️ Ответил: вариант ${["A","B","C","D"][idx] ?? idx}`;
  } else if (data.startsWith("poop_")) {
    action = `💩 Кинул какашку → id:${data.split("_")[1]}`;
  } else if (data.startsWith("dice_")) {
    action = `🎲 Кости: ${data}`;
  } else if (data.startsWith("mine_")) {
    action = `💣 Минное поле: ${data}`;
  } else if (data.startsWith("duel_")) {
    action = `⚔️ Дуэль: ${data}`;
  } else if (data.startsWith("admin_")) {
    action = `🔧 Админ: ${data}`;
  } else {
    action = data;
  }
  write(`🖱 ${formatUser(from)} → ${action}`);
}

function logGameResult(from, score, total, category) {
  const pct = Math.round((score / total) * 100);
  write(`🏁 ${formatUser(from)} завершил квиз [${category}]: ${score}/${total} (${pct}%)`);
}

function logStart(from) {
  write(`🚀 ${formatUser(from)} запустил бота`);
}

function logDiceResult(initiatorId, opponentId, bet, iRoll, oRoll, winnerId) {
  const result = winnerId ? `победил id:${winnerId}` : "ничья";
  write(`🎲 Кости: id:${initiatorId} [${iRoll}] vs id:${opponentId} [${oRoll}] ставка:${bet} → ${result}`);
}

function logMineResult(userId, bet, status, safeFound) {
  write(`💣 Минное поле: id:${userId} ставка:${bet} безопасных:${safeFound} → ${status}`);
}

function logDuelResult(initiatorId, opponentId, bet, winnerId, rounds) {
  const result = winnerId ? `победил id:${winnerId}` : "ничья";
  write(`⚔️ Дуэль: id:${initiatorId} vs id:${opponentId} ставка:${bet} раундов:${rounds} → ${result}`);
}

function logAdmin(adminId, action) {
  write(`🔧 ADMIN id:${adminId}: ${action}`);
}

function logError(from, error) {
  const userStr = from ? formatUser(from) : "system";
  write(`❌ ERROR [${userStr}]: ${error.message}\n${error.stack}`);
}

module.exports = {
  logMessage, logButton, logGameResult, logStart,
  logDiceResult, logMineResult, logDuelResult,
  logAdmin, logError,
};
