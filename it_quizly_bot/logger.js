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
  return `${name} (id:${from.id})`;
}

function write(line) {
  const entry = `[${timestamp()}] ${line}\n`;
  process.stdout.write(entry);
  fs.appendFileSync(LOG_PATH, entry, "utf8");
}

function logMessage(from, text) {
  write(`💬 ${formatUser(from)}: ${text || "(не текст)"}`);
}

function logButton(from, data) {
  const labels = {
    "menu_main":        "🏠 Главное меню",
    "menu_play":        "🎮 Начать викторину",
    "menu_leaderboard": "🏆 Таблица лидеров",
    "menu_profile":     "📊 Мой профиль",
    "menu_rules":       "ℹ️ Правила",
  };

  let action;
  if (labels[data]) {
    action = labels[data];
  } else if (data.startsWith("cat_")) {
    action = `🗂 Выбрал тему: ${data.replace("cat_", "")}`;
  } else if (data.startsWith("ans_")) {
    const idx = data.replace("ans_", "");
    action = `✏️ Ответил: вариант ${["A","B","C","D"][idx] || idx}`;
  } else {
    action = data;
  }

  write(`🖱 ${formatUser(from)} → ${action}`);
}

function logGameResult(from, score, total, category) {
  const pct = Math.round((score / total) * 100);
  write(`🏁 ${formatUser(from)} завершил игру [${category}]: ${score}/${total} (${pct}%)`);
}

function logStart(from) {
  write(`🚀 ${formatUser(from)} запустил бота`);
}

module.exports = { logMessage, logButton, logGameResult, logStart };
