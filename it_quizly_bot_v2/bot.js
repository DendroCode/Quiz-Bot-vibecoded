require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const allQuestions = require("./questions");
const log = require("./logger");

const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0");

if (!TOKEN) { console.error("❌ BOT_TOKEN не задан в .env!"); process.exit(1); }

// ── HTML escaping ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Quiz constants ────────────────────────────────────────────────────────────
const QUESTIONS_PER_GAME  = 7;
const POINTS_PER_CORRECT  = 10;
const ANSWER_TIMEOUT_SEC  = 35;
const SVO_PER_CORRECT     = 1;
const SVO_PERFECT_BONUS   = 5;

const CATEGORIES = {
  algorithms: { label: "🧮 Алгоритмы и структуры данных" },
  interview:  { label: "💼 Вопросы с собеседований" },
  databases:  { label: "🗄️ Базы данных / SQL" },
  devops:     { label: "🌐 Сети / DevOps" },
  guess_lang: { label: "🔍 Угадай язык по коду" },
  web:        { label: "🌍 Web / Frontend" },
  random:     { label: "🎲 Случайные темы" },
};

// ── Double-click protection ───────────────────────────────────────────────────
// Fix: prevents processing same callback twice before DB write completes
const processingCallbacks = new Set();

// ── Quiz timer storage ────────────────────────────────────────────────────────
// Fix: store both timeout and interval so both are cleared on answer
const timers = {}; // userId → { timeout, interval }

// ── Helpers ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getQuestions(category) {
  const pool = category === "random" ? allQuestions : allQuestions.filter(q => q.category === category);
  return shuffle(pool).slice(0, QUESTIONS_PER_GAME);
}

function progressBar(current, total) {
  const filled = Math.round((current / total) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function timerBar(secondsLeft, totalTime) {
  const filled = Math.round((secondsLeft / totalTime) * 10);
  return `${"🟩".repeat(filled)}${"⬜".repeat(10 - filled)} ${secondsLeft}с`;
}

function calcSvo(correctCount, total) {
  return correctCount * SVO_PER_CORRECT + (correctCount === total ? SVO_PERFECT_BONUS : 0);
}

// ── KEYBOARDS ─────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎮 Начать викторину", callback_data: "menu_play" }],
      [
        { text: "🏆 Таблица лидеров", callback_data: "menu_leaderboard" },
        { text: "📊 Мой профиль",     callback_data: "menu_profile" },
      ],
      [
        { text: "🎲 Игры",            callback_data: "menu_games" },
        { text: "🛒 Магазин",         callback_data: "menu_shop" },
      ],
      [{ text: "🎁 Ежедневный бонус", callback_data: "menu_daily" }],
      [{ text: "ℹ️ Правила",          callback_data: "menu_rules" }],
    ],
  };
}

function categoryKeyboard() {
  const rows = Object.entries(CATEGORIES).map(([key, val]) => [
    { text: val.label, callback_data: `cat_${key}` },
  ]);
  rows.push([{ text: "⬅️ Назад", callback_data: "menu_main" }]);
  return { inline_keyboard: rows };
}

function answerKeyboard(options) {
  const labels = ["A", "B", "C", "D"];
  return {
    inline_keyboard: options.map((opt, i) => [
      { text: `${labels[i]}. ${String(opt).replace(/</g,"‹").replace(/>/g,"›")}`, callback_data: `ans_${i}` },
    ]),
  };
}

function gamesMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎲 Кости",        callback_data: "dice_menu" }],
      [{ text: "💣 Минное поле",  callback_data: "mine_menu" }],
      [{ text: "⚔️ Дуэль",        callback_data: "duel_menu" }],
      [{ text: "⬅️ Назад",        callback_data: "menu_main" }],
    ],
  };
}

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
const RAINBOW_FRAMES = [
  ["🔴","🟠","🟡","🟢","🔵","🟣"],
  ["🟣","🔴","🟠","🟡","🟢","🔵"],
  ["🔵","🟣","🔴","🟠","🟡","🟢"],
  ["🟢","🔵","🟣","🔴","🟠","🟡"],
  ["🟡","🟢","🔵","🟣","🔴","🟠"],
  ["🟠","🟡","🟢","🔵","🟣","🔴"],
];
const rainbowIntervals = {};

function buildLeaderboardText(leaders, mode, frame) {
  const f = (frame || 0) % RAINBOW_FRAMES.length;
  const dots = RAINBOW_FRAMES[f].join("");
  const medals = ["🥇","🥈","🥉"];
  if (leaders.length === 0) return "Пока никто не играл. Будь первым! 🚀";

  return leaders.map((u, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const rawName = u.username ? `@${u.username}` : "Аноним";
    const link = u.username ? `<a href="https://t.me/${u.username}">${rawName}</a>` : rawName;
    const uname = u.rainbow_nick ? `${dots} ${link}` : `<b>${link}</b>`;
    const poops = mode === "quiz" ? db.getPoopCount(u.telegram_id) : 0;
    const poopStr = poops > 0 ? ` ${"💩".repeat(Math.min(poops, 3))}` : "";

    if (mode === "dice") {
      return `${icon} ${uname} — ${u.dice_wins}W/${u.dice_losses}L | +${u.dice_earned}💵`;
    }
    if (mode === "duel") {
      return `${icon} ${uname} — ${u.duel_wins}W/${u.duel_losses}L | +${u.duel_earned}💵`;
    }
    return `${icon} ${uname} — ${u.total_score} очков | 💵 ${u.svodollars || 0}${poopStr}`;
  }).join("\n");
}

function leaderboardKeyboard(leaders, mode) {
  const buttons = [];
  if (mode === "quiz") {
    leaders.filter(u => u.username).forEach(u => {
      buttons.push([
        { text: `✉️ @${u.username}`, url: `https://t.me/${u.username}` },
        { text: `💩 Кинуть`, callback_data: `poop_${u.telegram_id}_${u.username || "user"}` },
      ]);
    });
  }
  const modeButtons = [
    { text: mode === "quiz" ? "✅ Квиз" : "Квиз",  callback_data: "lb_quiz" },
    { text: mode === "dice" ? "✅ Кости" : "Кости", callback_data: "lb_dice" },
    { text: mode === "duel" ? "✅ Дуэль" : "Дуэль", callback_data: "lb_duel" },
  ];
  buttons.push(modeButtons);
  buttons.push([{ text: "⬅️ Назад", callback_data: "menu_main" }]);
  return { inline_keyboard: buttons };
}

function startRainbowAnimation(bot, chatId, messageId, leaders, mode) {
  const key = `${chatId}_${messageId}`;
  if (rainbowIntervals[key]) return;
  if (!leaders.some(u => u.rainbow_nick)) return;
  let frame = 0;
  rainbowIntervals[key] = setInterval(async () => {
    frame++;
    try {
      await bot.editMessageText(
        `🏆 <b>Таблица лидеров</b>\n\n${buildLeaderboardText(leaders, mode || "quiz", frame)}`,
        { chat_id: chatId, message_id: messageId, reply_markup: leaderboardKeyboard(leaders, mode || "quiz"),
          parse_mode: "HTML", disable_web_page_preview: true }
      );
    } catch(e) {
      clearInterval(rainbowIntervals[key]);
      delete rainbowIntervals[key];
    }
  }, 1500);
  setTimeout(() => {
    if (rainbowIntervals[key]) { clearInterval(rainbowIntervals[key]); delete rainbowIntervals[key]; }
  }, 30000);
}

// ── SHOP ──────────────────────────────────────────────────────────────────────
function shopText(user) {
  const svo = user.svodollars || 0;
  const hasRainbow = user.rainbow_nick ? "✅ Куплено" : "15 💵";
  return (
    `🛒 <b>Магазин SVOкоинов</b>\n\n` +
    `💵 Твой баланс: <b>${svo} SVOкоинов</b>\n\n` +
    `🌈 <b>Переливающийся ник</b> в лидерборде — ${hasRainbow}\n` +
    `⏱ <b>+5 сек к таймеру</b> (на 1 игру) — 10 💵 | есть: ${user.timer_bonus || 0}\n` +
    `💩 <b>Кинуть какашку</b> — 5 💵 (через лидерборд)\n` +
    `🔥 <b>Сжечь SVOкоины</b> — 1 💵 за 1\n\n` +
    `_За 3-4 игры зарабатываешь ~15-20 коинов_`
  );
}

function shopKeyboard(user) {
  return {
    inline_keyboard: [
      [{ text: user.rainbow_nick ? "🌈 Ник уже переливается!" : "🌈 Купить ник (15 💵)", callback_data: "shop_rainbow" }],
      [{ text: "⏱ Купить +5 сек (10 💵)", callback_data: "shop_timer" }],
      [
        { text: "🔥 Сжечь 1 SVOкоин",  callback_data: "shop_burn_1" },
        { text: "🔥🔥 Сжечь 5",         callback_data: "shop_burn_5" },
      ],
      [{ text: "⬅️ Назад", callback_data: "menu_main" }],
    ],
  };
}

// ── QUIZ: timer ───────────────────────────────────────────────────────────────
function clearQuizTimer(userId) {
  if (timers[userId]) {
    // Fix: clear BOTH the timeout and the interval
    clearTimeout(timers[userId].timeout);
    clearInterval(timers[userId].interval);
    delete timers[userId];
  }
}

async function startQuestionTimer(bot, chatId, userId, session) {
  clearQuizTimer(userId);

  const user = db.getUser(userId);
  let timerBonus = 0;
  if (user && user.timer_bonus > 0) {
    timerBonus = 5;
    db.useTimerBonus(userId);
  }
  const totalTime = ANSWER_TIMEOUT_SEC + timerBonus;
  const bonusLabel = timerBonus > 0 ? ` <b>+${timerBonus}с бонус!</b>` : "";

  const timerMsg = await bot.sendMessage(chatId, `⏱ ${timerBar(totalTime, totalTime)}${bonusLabel}`, { parse_mode: "HTML" });
  db.setSessionTimerMsg(session.id, timerMsg.message_id);

  let secondsLeft = totalTime;
  const interval = setInterval(async () => {
    secondsLeft -= 5;
    if (secondsLeft <= 0) { clearInterval(interval); return; }
    try {
      await bot.editMessageText(`⏱ ${timerBar(secondsLeft, totalTime)}`, {
        chat_id: chatId, message_id: timerMsg.message_id,
      });
    } catch(e) {}
  }, 5000);

  const timeout = setTimeout(async () => {
    clearInterval(interval);
    const activeSession = db.getActiveSession(userId);
    if (!activeSession) return;

    const q = activeSession.questions[activeSession.current_index];
    const newIndex = activeSession.current_index + 1;

    try {
      await bot.editMessageText(
        `⏱ ${timerBar(0, totalTime)}\n\n⌛ <b>Время вышло!</b>\n\nПравильный ответ: <b>${esc(q.options[q.answer])}</b>\n\n💡 ${esc(q.explanation)}`,
        { chat_id: chatId, message_id: timerMsg.message_id, parse_mode: "HTML" }
      );
    } catch(e) {}

    if (newIndex >= activeSession.questions.length) {
      const svo = calcSvo(activeSession.score, activeSession.questions.length);
      db.finishSession(activeSession.id, userId, activeSession.score * POINTS_PER_CORRECT, activeSession.score, false, svo);
      log.logGameResult({ id: userId }, activeSession.score, activeSession.questions.length, activeSession.category);
      await sendResults(bot, chatId, activeSession.score, activeSession.questions.length, activeSession.category, svo);
    } else {
      db.updateSession(activeSession.id, newIndex, activeSession.score);
      setTimeout(() => sendQuestion(bot, chatId, userId, { ...activeSession, current_index: newIndex }), 1000);
    }
  }, totalTime * 1000);

  timers[userId] = { timeout, interval };
}

// ── QUIZ: question/results ────────────────────────────────────────────────────
async function sendQuestion(bot, chatId, userId, session) {
  const q = session.questions[session.current_index];
  const num = session.current_index + 1;
  const total = session.questions.length;
  await bot.sendMessage(chatId,
    `<b>${q.label} • Вопрос ${num}/${total}</b>\n${progressBar(num - 1, total)}\n\n❓ ${esc(q.question)}`,
    { reply_markup: answerKeyboard(q.options), parse_mode: "HTML" }
  );
  await startQuestionTimer(bot, chatId, userId, session);
}

async function sendResults(bot, chatId, score, total, category, svoEarned) {
  const pct = Math.round((score / total) * 100);
  const medal = pct >= 90 ? "🥇" : pct >= 70 ? "🥈" : pct >= 50 ? "🥉" : "😬";
  const isPerfect = score === total;
  await bot.sendMessage(chatId,
    `${medal} <b>Игра завершена!</b>\n\n` +
    `📚 Тема: ${CATEGORIES[category]?.label || category}\n` +
    `✅ Правильных: ${score}/${total}\n` +
    `📈 Результат: ${pct}%\n` +
    `⭐ Очки: +${score * POINTS_PER_CORRECT}\n` +
    `💵 SVOллары: +${svoEarned}${isPerfect ? ` (включая бонус +${SVO_PERFECT_BONUS} 🎯)` : ""}\n\n` +
    (isPerfect ? "🔥 Идеальный результат!" : pct >= 70 ? "👍 Отличный результат!" : "💪 Есть куда расти!"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Ещё раз",     callback_data: `cat_${category}` },
            { text: "🎲 Другая тема", callback_data: "menu_play" },
          ],
          [{ text: "🏠 Главное меню", callback_data: "menu_main" }],
        ],
      },
      parse_mode: "HTML",
    }
  );
}

// ── DICE: keyboards & text ────────────────────────────────────────────────────
function diceLobbyKeyboard(users, openGames) {
  const rows = [];
  // Active open challenges to join
  if (openGames && openGames.length > 0) {
    rows.push([{ text: "━━━ Открытые вызовы ━━━", callback_data: "dice_noop" }]);
    for (const g of openGames) {
      const initiator = db.getUser(g.initiator_id);
      const name = initiator?.username ? `@${initiator.username}` : `id:${g.initiator_id}`;
      rows.push([{ text: `✅ Вступить — ${name} (ставка ${g.bet}💵)`, callback_data: `dice_accept_${g.id}` }]);
    }
    rows.push([{ text: "━━━ Новый вызов ━━━", callback_data: "dice_noop" }]);
  }
  // Players to challenge directly
  const knownUsers = users.slice(0, 6);
  for (const u of knownUsers) {
    const name = u.username ? `@${u.username}` : `id:${u.telegram_id}`;
    rows.push([{ text: `👤 ${name}`, callback_data: `dice_challenge_${u.telegram_id}` }]);
  }
  rows.push([{ text: "🌍 Открытый вызов (всем)", callback_data: "dice_challenge_open" }]);
  rows.push([{ text: "⬅️ Назад", callback_data: "menu_games" }]);
  return { inline_keyboard: rows };
}

function diceBetKeyboard(opponentData) {
  const suffix = opponentData || "open";
  return {
    inline_keyboard: [
      [
        { text: "5 💵",  callback_data: `dice_bet_5_${suffix}` },
        { text: "10 💵", callback_data: `dice_bet_10_${suffix}` },
        { text: "25 💵", callback_data: `dice_bet_25_${suffix}` },
      ],
      [
        { text: "50 💵", callback_data: `dice_bet_50_${suffix}` },
        { text: "100 💵",callback_data: `dice_bet_100_${suffix}` },
      ],
      [{ text: "⬅️ Назад", callback_data: "dice_menu" }],
    ],
  };
}

function diceAcceptKeyboard(gameId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Принять",  callback_data: `dice_accept_${gameId}` },
        { text: "❌ Отказать", callback_data: `dice_decline_${gameId}` },
      ],
    ],
  };
}

function diceRollKeyboard(gameId) {
  return {
    inline_keyboard: [[{ text: "🎲 Бросить кубик!", callback_data: `dice_roll_${gameId}` }]],
  };
}

function diceRematchKeyboard(opponentId, bet) {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Реванш (та же ставка)", callback_data: `dice_rematch_${opponentId}_${bet}` },
        { text: "💰 Другая ставка",          callback_data: `dice_challenge_${opponentId}` },
      ],
      [{ text: "🎲 В меню игр", callback_data: "menu_games" }],
    ],
  };
}

// ── MINESWEEPER: keyboard & text ──────────────────────────────────────────────
function mineBoardKeyboard(game) {
  const rows = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const idx = r * 4 + c;
      let text;
      if (game.revealed[idx]) {
        text = game.board[idx] ? "💥" : "✅";
      } else {
        text = "⬜";
      }
      row.push({ text, callback_data: game.revealed[idx] ? `mine_noop` : `mine_reveal_${game.id}_${idx}` });
    }
    rows.push(row);
  }
  // Cashout button (only if at least 1 safe found and game still active)
  if (game.status === "active" && game.safe_found > 0) {
    const mult = 1.5;
    const payout = Math.floor(game.bet * mult);
    rows.push([{ text: `💰 Забрать ${payout}💵 (x${mult})`, callback_data: `mine_cashout_${game.id}` }]);
  }
  rows.push([{ text: "⬅️ В меню игр", callback_data: "menu_games" }]);
  return { inline_keyboard: rows };
}

function mineBetKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "5 💵",  callback_data: "mine_bet_5" },
        { text: "10 💵", callback_data: "mine_bet_10" },
        { text: "25 💵", callback_data: "mine_bet_25" },
      ],
      [
        { text: "50 💵", callback_data: "mine_bet_50" },
        { text: "100 💵",callback_data: "mine_bet_100" },
      ],
      [{ text: "⬅️ Назад", callback_data: "menu_games" }],
    ],
  };
}

// ── DUEL: keyboards & text ────────────────────────────────────────────────────
function duelLobbyKeyboard(users, openGames) {
  const rows = [];
  if (openGames && openGames.length > 0) {
    rows.push([{ text: "━━━ Открытые вызовы ━━━", callback_data: "duel_noop" }]);
    for (const g of openGames) {
      const initiator = db.getUser(g.initiator_id);
      const name = initiator?.username ? `@${initiator.username}` : `id:${g.initiator_id}`;
      rows.push([{ text: `✅ Вступить — ${name} (ставка ${g.bet}💵)`, callback_data: `duel_accept_${g.id}` }]);
    }
    rows.push([{ text: "━━━ Новый вызов ━━━", callback_data: "duel_noop" }]);
  }
  const knownUsers = users.slice(0, 6);
  for (const u of knownUsers) {
    const name = u.username ? `@${u.username}` : `id:${u.telegram_id}`;
    rows.push([{ text: `👤 ${name}`, callback_data: `duel_challenge_${u.telegram_id}` }]);
  }
  rows.push([{ text: "🌍 Открытый вызов (всем)", callback_data: "duel_challenge_open" }]);
  rows.push([{ text: "⬅️ Назад", callback_data: "menu_games" }]);
  return { inline_keyboard: rows };
}

function duelBetKeyboard(opponentData) {
  const suffix = opponentData || "open";
  return {
    inline_keyboard: [
      [
        { text: "5 💵",  callback_data: `duel_bet_5_${suffix}` },
        { text: "10 💵", callback_data: `duel_bet_10_${suffix}` },
        { text: "25 💵", callback_data: `duel_bet_25_${suffix}` },
      ],
      [
        { text: "50 💵", callback_data: `duel_bet_50_${suffix}` },
        { text: "100 💵",callback_data: `duel_bet_100_${suffix}` },
      ],
      [{ text: "⬅️ Назад", callback_data: "duel_menu" }],
    ],
  };
}

function duelAcceptKeyboard(gameId) {
  return {
    inline_keyboard: [[
      { text: "⚔️ Принять вызов!", callback_data: `duel_accept_${gameId}` },
      { text: "❌ Отказать",        callback_data: `duel_decline_${gameId}` },
    ]],
  };
}

function duelActionKeyboard(gameId) {
  return {
    inline_keyboard: [[{ text: "🔫 Нажать на курок", callback_data: `duel_pull_${gameId}` }]],
  };
}

function duelRematchKeyboard(opponentId, bet) {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Реванш (та же ставка)", callback_data: `duel_rematch_${opponentId}_${bet}` },
        { text: "💰 Другая ставка",          callback_data: `duel_challenge_${opponentId}` },
      ],
      [{ text: "⚔️ В меню игр", callback_data: "menu_games" }],
    ],
  };
}

function hpBar(hp, maxHp = 3) {
  return "❤️".repeat(Math.max(hp, 0)) + "🖤".repeat(Math.max(maxHp - hp, 0));
}

function actionEmoji(action) {
  return { attack: "⚔️", defend: "🛡", pierce: "💥" }[action] || "?";
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💵 Начислить коины пользователю", callback_data: "admin_addcoins" }],
      [{ text: "📢 Рассылка (используй /broadcast)", callback_data: "admin_noop" }],
      [{ text: "📋 Список пользователей",           callback_data: "admin_userlist" }],
      [{ text: "⬅️ Назад",                          callback_data: "menu_main" }],
    ],
  };
}

// ── BOT START ─────────────────────────────────────────────────────────────────
db.initDB();
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 IT-Quiz бот запущен!");

// Pending state for multi-step admin inputs: adminId → { action, step, data }
const adminState = {};
// Pending bet state for games: userId → { game, opponentId, bet }
const betState = {};

bot.on("message", async (msg) => {
  log.logMessage(msg.from, msg.text);

  // Fix: block forwarded messages from being used as game interactions
  if (msg.forward_date || msg.forward_from) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text   = msg.text || "";

  // Admin multi-step input handler
  if (adminState[userId] && userId === ADMIN_ID) {
    const state = adminState[userId];

    if (state.action === "addcoins_id") {
      const targetId = parseInt(text);
      if (isNaN(targetId)) {
        await bot.sendMessage(chatId, "❌ Неверный ID. Попробуй снова или /cancel");
        return;
      }
      adminState[userId] = { action: "addcoins_amount", targetId };
      await bot.sendMessage(chatId, "Сколько коинов начислить? Введи число:");
      return;
    }

    if (state.action === "addcoins_amount") {
      const amount = parseInt(text);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Неверная сумма. Попробуй снова:");
        return;
      }
      db.adminAddCoins(state.targetId, amount);
      log.logAdmin(userId, `начислил ${amount} коинов → id:${state.targetId}`);
      delete adminState[userId];
      await bot.sendMessage(chatId, `✅ Начислено ${amount} 💵 пользователю id:${state.targetId}`);
      return;
    }
  }
});

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { id: chatId, username, first_name } = msg.from;
  db.ensureUser(chatId, username || first_name);
  log.logStart(msg.from);
  await bot.sendMessage(chatId,
    `👋 Привет, <b>${esc(first_name || username || "друг")}</b>!\n\n` +
    `🤓 Добро пожаловать в <b>IT-викторину</b>!\n\n` +
    `Темы: алгоритмы, SQL, сети, DevOps, frontend и другое.\n` +
    `За правильные ответы получай <b>очки</b> и <b>💵 SVOллары</b>.\n` +
    `На каждый вопрос — <b>${ANSWER_TIMEOUT_SEC} секунд</b>. ⏱\n` +
    `В разделе <b>🎲 Игры</b> — кости, минное поле, дуэли! ⚔️\n\n` +
    `Готов? 🚀`,
    { reply_markup: mainMenuKeyboard(), parse_mode: "HTML" }
  );
});

// ── /broadcast ────────────────────────────────────────────────────────────────
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⛔ Нет прав.");
  const text = match[1];
  const users = db.getAllUsers();
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.telegram_id, `📢 <b>Сообщение от администратора:</b>\n\n${text}`, { parse_mode: "HTML" });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  await bot.sendMessage(msg.chat.id, `✅ Рассылка завершена: отправлено ${sent}, ошибок ${failed}.`);
  log.logAdmin(msg.from.id, `broadcast: ${text}`);
});

bot.onText(/\/play/, async (msg) => {
  db.ensureUser(msg.from.id, msg.from.username || msg.from.first_name);
  await bot.sendMessage(msg.from.id, "🎮 <b>Выбери тему:</b>", { reply_markup: categoryKeyboard(), parse_mode: "HTML" });
});

bot.onText(/\/top/, async (msg) => {
  const leaders = db.getLeaderboard("quiz");
  const sent = await bot.sendMessage(msg.from.id,
    `🏆 <b>Топ-10</b>\n\n${buildLeaderboardText(leaders, "quiz")}`,
    { reply_markup: leaderboardKeyboard(leaders, "quiz"), parse_mode: "HTML", disable_web_page_preview: true }
  );
  startRainbowAnimation(bot, msg.from.id, sent.message_id, leaders, "quiz");
});

bot.onText(/\/profile/, async (msg) => {
  const user = db.getUser(msg.from.id);
  if (!user) { await bot.sendMessage(msg.from.id, "Сначала начни игру: /start"); return; }
  const accuracy = user.games_played > 0
    ? Math.round((user.correct_answers / (user.games_played * QUESTIONS_PER_GAME)) * 100) : 0;
  await bot.sendMessage(msg.from.id,
    `👤 @${user.username || "Аноним"}\n⭐ Очки: ${user.total_score}\n💵 SVOллары: ${user.svodollars || 0}\n` +
    `🎮 Игр: ${user.games_played}\n🎯 Точность: ${accuracy}%\n🔥 Стрик: ${user.streak}`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/admin/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⛔ Нет прав.");
  await bot.sendMessage(msg.chat.id,
    `🔧 <b>Панель администратора</b>\n\n` +
    `Ты можешь управлять ботом через кнопки ниже.\n\n` +
    `<b>Как добавить нового администратора:</b>\n` +
    `В файле <code>.env</code> установи переменную <code>ADMIN_ID=ТВОй_TELEGRAM_ID</code>.\n` +
    `Свой ID можно узнать у @userinfobot.`,
    { reply_markup: adminKeyboard(), parse_mode: "HTML" }
  );
});

// ── CALLBACK HANDLER ──────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const { id: queryId, message, data, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;

  // Fix: double-click protection
  const callbackKey = `${userId}_${data}_${message.message_id}`;
  if (processingCallbacks.has(callbackKey)) {
    try { await bot.answerCallbackQuery(queryId); } catch(_) {}
    return;
  }
  processingCallbacks.add(callbackKey);
  setTimeout(() => processingCallbacks.delete(callbackKey), 2000);

  // Fix: single answerCallbackQuery upfront; use show_alert variants only where needed
  // (called inline per-branch below)

  try {
    log.logButton(from, data);

    // ── Main menu ─────────────────────────────────────────────────────────────
    if (data === "menu_main") {
      await bot.answerCallbackQuery(queryId);
      return bot.sendMessage(chatId, "🏠 Главное меню:", { reply_markup: mainMenuKeyboard(), parse_mode: "HTML" });
    }

    if (data === "menu_play") {
      await bot.answerCallbackQuery(queryId);
      return bot.editMessageText("🎮 <b>Выбери тему:</b>", {
        chat_id: chatId, message_id: message.message_id,
        reply_markup: categoryKeyboard(), parse_mode: "HTML",
      });
    }

    if (data === "menu_rules") {
      await bot.answerCallbackQuery(queryId);
      return bot.editMessageText(
        `📖 <b>Правила игры:</b>\n\n` +
        `• ${QUESTIONS_PER_GAME} вопросов за игру, 4 варианта ответа\n` +
        `• На каждый вопрос — <b>${ANSWER_TIMEOUT_SEC} секунд</b> ⏱\n` +
        `• За правильный ответ: +${POINTS_PER_CORRECT} очков и +${SVO_PER_CORRECT} 💵\n` +
        `• Бонус за идеальную игру (7/7): +${SVO_PERFECT_BONUS} SVOлларов 🎯\n` +
        `• SVOллары тратятся в магазине и на ставки в играх`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
          parse_mode: "HTML",
        }
      );
    }

    if (data === "menu_daily") {
      const result = db.claimDailyBonus(userId);
      if (result.ok) {
        const user = db.getUser(userId);
        await bot.answerCallbackQuery(queryId, { text: "🎁 +100 SVOлларов получено!", show_alert: true });
        return bot.editMessageText(
          `🎁 <b>Ежедневный бонус получен!</b>\n\n` +
          `+<b>100 💵 SVOлларов</b> начислено!\n\n` +
          `Твой баланс: <b>${user.svodollars} 💵</b>\n\n` +
          `Следующий бонус через 24 часа ⏰`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
            parse_mode: "HTML",
          }
        );
      } else {
        await bot.answerCallbackQuery(queryId, { text: `⏳ Следующий бонус через ${result.hoursLeft} ч.`, show_alert: true });
        return bot.editMessageText(
          `⏳ <b>Ежедневный бонус уже получен!</b>\n\n` +
          `Следующий бонус будет доступен через <b>${result.hoursLeft} ч.</b>`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
            parse_mode: "HTML",
          }
        );
      }
    }

    if (data === "menu_profile") {
      await bot.answerCallbackQuery(queryId);
      const user = db.getUser(userId);
      if (!user) return bot.sendMessage(chatId, "Сначала напиши /start");
      const accuracy = user.games_played > 0
        ? Math.round((user.correct_answers / (user.games_played * QUESTIONS_PER_GAME)) * 100) : 0;
      return bot.editMessageText(
        `👤 <b>Профиль: @${esc(user.username || "Аноним")}</b>${user.rainbow_nick ? " 🌈" : ""}\n\n` +
        `⭐ Очки: <b>${user.total_score}</b>\n` +
        `💵 SVOкоины: <b>${user.svodollars || 0}</b>\n` +
        `⏱ Бонусы таймера: <b>${user.timer_bonus || 0}</b>\n` +
        `💩 Получено какашек: <b>${db.getPoopCount(userId)}</b>\n` +
        `🎮 Игр (квиз): <b>${user.games_played}</b>\n` +
        `✅ Правильных: <b>${user.correct_answers}</b>\n` +
        `🎯 Точность: <b>${accuracy}%</b>\n` +
        `🔥 Стрик: <b>${user.streak}</b> / лучший: <b>${user.best_streak}</b>\n\n` +
        `🎲 Кости: <b>${user.dice_wins}W / ${user.dice_losses}L</b>\n` +
        `⚔️ Дуэли: <b>${user.duel_wins}W / ${user.duel_losses}L</b>\n` +
        `💣 Минное поле: <b>${user.mine_wins}W / ${user.mine_losses}L</b>`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
          parse_mode: "HTML",
        }
      );
    }

    if (data === "menu_leaderboard" || data === "lb_quiz") {
      await bot.answerCallbackQuery(queryId);
      const leaders = db.getLeaderboard("quiz");
      return bot.editMessageText(
        `🏆 <b>Таблица лидеров — Квиз</b>\n\n${buildLeaderboardText(leaders, "quiz")}`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: leaderboardKeyboard(leaders, "quiz"),
          parse_mode: "HTML", disable_web_page_preview: true,
        }
      );
    }

    if (data === "lb_dice") {
      await bot.answerCallbackQuery(queryId);
      const leaders = db.getLeaderboard("dice");
      return bot.editMessageText(
        `🏆 <b>Таблица лидеров — Кости</b>\n\n${buildLeaderboardText(leaders, "dice")}`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: leaderboardKeyboard(leaders, "dice"),
          parse_mode: "HTML", disable_web_page_preview: true,
        }
      );
    }

    if (data === "lb_duel") {
      await bot.answerCallbackQuery(queryId);
      const leaders = db.getLeaderboard("duel");
      return bot.editMessageText(
        `🏆 <b>Таблица лидеров — Дуэль</b>\n\n${buildLeaderboardText(leaders, "duel")}`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: leaderboardKeyboard(leaders, "duel"),
          parse_mode: "HTML", disable_web_page_preview: true,
        }
      );
    }

    // ── Shop ──────────────────────────────────────────────────────────────────
    if (data === "menu_shop") {
      await bot.answerCallbackQuery(queryId);
      const user = db.getUser(userId);
      if (!user) return;
      return bot.editMessageText(shopText(user), {
        chat_id: chatId, message_id: message.message_id,
        reply_markup: shopKeyboard(user), parse_mode: "HTML",
      });
    }

    if (data === "shop_rainbow") {
      const user = db.getUser(userId);
      if (user?.rainbow_nick) {
        return bot.answerCallbackQuery(queryId, { text: "🌈 Ник уже переливается!", show_alert: true });
      }
      if ((user?.svodollars || 0) < 15) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно 15 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId, { text: "🌈 Ник теперь переливается в лидерборде!", show_alert: true });
      db.buyRainbowNick(userId);
      const updated = db.getUser(userId);
      return bot.editMessageText(shopText(updated), {
        chat_id: chatId, message_id: message.message_id,
        reply_markup: shopKeyboard(updated), parse_mode: "HTML",
      });
    }

    if (data === "shop_timer") {
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < 10) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно 10 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId, { text: "⏱ Куплено! На следующий вопрос будет +5 секунд.", show_alert: true });
      db.buyTimerBonus(userId);
      const updated = db.getUser(userId);
      return bot.editMessageText(shopText(updated), {
        chat_id: chatId, message_id: message.message_id,
        reply_markup: shopKeyboard(updated), parse_mode: "HTML",
      });
    }

    if (data === "shop_burn_1" || data === "shop_burn_5") {
      const amount = data === "shop_burn_1" ? 1 : 5;
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < amount) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${amount} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      db.burnCoins(userId, amount);
      const flames = ["🔥","🔥🔥","💀🔥","🌋","☄️"];
      await bot.answerCallbackQuery(queryId, {
        text: `${flames[Math.floor(Math.random() * flames.length)]} ${amount} SVOкоин(ов) сгорело!`,
        show_alert: true,
      });
      const updated = db.getUser(userId);
      return bot.editMessageText(shopText(updated), {
        chat_id: chatId, message_id: message.message_id,
        reply_markup: shopKeyboard(updated), parse_mode: "HTML",
      });
    }

    // ── Poop ─────────────────────────────────────────────────────────────────
    if (data.startsWith("poop_")) {
      const parts = data.split("_");
      const targetId = parseInt(parts[1]);
      const targetName = parts[2] || "пользователя";
      if (targetId === userId) {
        return bot.answerCallbackQuery(queryId, { text: "💩 Нельзя кинуть в себя!", show_alert: true });
      }
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < 5) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно 5 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      db.throwPoop(userId, targetId);
      await bot.answerCallbackQuery(queryId, { text: `💩 Попал! @${targetName} теперь в дерьме!`, show_alert: true });
      try {
        const attackerName = from.username ? `@${from.username}` : from.first_name;
        await bot.sendMessage(targetId,
          `💩 <b>${esc(attackerName)} кинул в тебя какашку!</b>\n\nТеперь она красуется рядом с твоим именем в лидерборде 😂`,
          { parse_mode: "HTML" }
        );
      } catch(_) {}
      const leaders = db.getLeaderboard("quiz");
      return bot.editMessageText(
        `🏆 <b>Таблица лидеров</b>\n\n${buildLeaderboardText(leaders, "quiz")}`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: leaderboardKeyboard(leaders, "quiz"), parse_mode: "HTML" }
      );
    }

    // ── Quiz category ─────────────────────────────────────────────────────────
    if (data.startsWith("cat_")) {
      await bot.answerCallbackQuery(queryId);
      const category = data.replace("cat_", "");
      db.ensureUser(userId, from.username || from.first_name);
      const questions = getQuestions(category);
      if (!questions || questions.length === 0) {
        return bot.sendMessage(chatId, "😕 Вопросы для этой темы пока не добавлены.");
      }
      db.createSession(userId, category, questions);
      const session = db.getActiveSession(userId);
      await bot.editMessageText(
        `🎮 <b>Тема: ${CATEGORIES[category]?.label}</b>\n\nПоехали! 👇`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }
      );
      return sendQuestion(bot, chatId, userId, session);
    }

    // ── Quiz answer ───────────────────────────────────────────────────────────
    if (data.startsWith("ans_")) {
      await bot.answerCallbackQuery(queryId);
      const answerIndex = parseInt(data.replace("ans_", ""));
      const session = db.getActiveSession(userId);
      if (!session) {
        return bot.sendMessage(chatId, "❌ Активная игра не найдена. Начни новую!", { reply_markup: mainMenuKeyboard() });
      }
      clearQuizTimer(userId);
      const q = session.questions[session.current_index];
      const isCorrect = answerIndex === q.answer;
      const newScore = session.score + (isCorrect ? 1 : 0);
      const newIndex = session.current_index + 1;
      await bot.editMessageText(
        isCorrect
          ? `✅ <b>Правильно!</b>\n\n💡 ${esc(q.explanation)}`
          : `❌ <b>Неправильно.</b>\n\nПравильный ответ: <b>${esc(q.options[q.answer])}</b>\n\n💡 ${esc(q.explanation)}`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }
      );
      if (session.timer_message_id) {
        try { await bot.deleteMessage(chatId, session.timer_message_id); } catch(_) {}
      }
      if (newIndex >= session.questions.length) {
        const svo = calcSvo(newScore, session.questions.length);
        db.finishSession(session.id, userId, newScore * POINTS_PER_CORRECT, newScore, newScore === session.questions.length, svo);
        log.logGameResult(from, newScore, session.questions.length, session.category);
        return sendResults(bot, chatId, newScore, session.questions.length, session.category, svo);
      } else {
        db.updateSession(session.id, newIndex, newScore);
        setTimeout(() => sendQuestion(bot, chatId, userId, { ...session, current_index: newIndex, score: newScore }), 800);
      }
      return;
    }

    // ── Games menu ────────────────────────────────────────────────────────────
    if (data === "menu_games") {
      await bot.answerCallbackQuery(queryId);
      return bot.editMessageText(
        `🎲 <b>Раздел Игры</b>\n\nВсе игры идут на <b>💵 SVOллары</b>. Выбирай:`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: gamesMenuKeyboard(), parse_mode: "HTML" }
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // ── DICE ─────────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════

    if (data === "dice_menu" || data === "dice_noop") {
      await bot.answerCallbackQuery(queryId);
      if (data === "dice_noop") return;
      const users = db.getAllUsers()
        .map(u => db.getUser(u.telegram_id))
        .filter(u => u && u.telegram_id !== userId);
      const openGames = db.getOpenDiceGames().filter(g => g.initiator_id !== userId);
      return bot.editMessageText(
        `🎲 <b>Кости</b>\n\nВступи в открытый вызов или создай свой:\n\nПравила: оба бросают кубик, больше — побеждает. При ничьей ставки возвращаются.`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: diceLobbyKeyboard(users, openGames), parse_mode: "HTML" }
      );
    }

    // Challenge specific user or open
    if (data.startsWith("dice_challenge_")) {
      await bot.answerCallbackQuery(queryId);
      const opponentData = data.replace("dice_challenge_", "");
      const opponentId = opponentData === "open" ? null : parseInt(opponentData);
      const opponentUser = opponentId ? db.getUser(opponentId) : null;
      const label = opponentUser?.username ? `@${opponentUser.username}` : "любого игрока";
      return bot.editMessageText(
        `🎲 Вызов: ${label}\n\nВыбери ставку:`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: diceBetKeyboard(opponentData), parse_mode: "HTML" }
      );
    }

    // Bet chosen
    if (data.startsWith("dice_bet_")) {
      const parts = data.split("_"); // dice_bet_<amount>_<opponentData>
      const bet = parseInt(parts[2]);
      const opponentData = parts.slice(3).join("_");
      const opponentId = opponentData === "open" ? null : parseInt(opponentData);

      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${bet} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);

      const gameId = db.createDiceGame(userId, opponentId, bet);
      if (!gameId) {
        return bot.sendMessage(chatId, "❌ Не удалось создать игру.");
      }

      if (opponentId) {
        // Private challenge
        const opponentUser = db.getUser(opponentId);
        const initiatorName = from.username ? `@${from.username}` : from.first_name;
        // Notify opponent
        try {
          const oppMsg = await bot.sendMessage(opponentId,
            `🎲 <b>${esc(initiatorName)} вызывает тебя на кости!</b>\n\nСтавка: <b>${bet} 💵</b>\n\nПримешь вызов?`,
            { reply_markup: diceAcceptKeyboard(gameId), parse_mode: "HTML" }
          );
          db.setDiceMsgId(gameId, "opponent_msg_id", oppMsg.message_id);
        } catch(_) {}
        // Confirm to initiator
        await bot.editMessageText(
          `🎲 Вызов отправлен <b>@${esc(opponentUser?.username || "игроку")}</b>!\n\nСтавка: <b>${bet} 💵</b>\nОжидаем ответа... ⏳`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `dice_cancel_${gameId}` }]] } }
        );
      } else {
        // Open challenge — broadcast to all
        const initiatorName = from.username ? `@${from.username}` : from.first_name;
        const allUsers = db.getAllUsers();
        for (const u of allUsers) {
          if (u.telegram_id === userId) continue;
          try {
            await bot.sendMessage(u.telegram_id,
              `🎲 <b>${esc(initiatorName)} бросает открытый вызов на кости!</b>\n\nСтавка: <b>${bet} 💵</b>`,
              { reply_markup: diceAcceptKeyboard(gameId), parse_mode: "HTML" }
            );
          } catch(_) {}
          await new Promise(r => setTimeout(r, 30));
        }
        await bot.editMessageText(
          `🎲 Открытый вызов разослан!\n\nСтавка: <b>${bet} 💵</b>\nОжидаем принятия... ⏳`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `dice_cancel_${gameId}` }]] } }
        );
      }
      return;
    }

    // Dice rematch
    if (data.startsWith("dice_rematch_")) {
      const parts = data.split("_"); // dice_rematch_<opponentId>_<bet>
      const opponentId = parseInt(parts[2]);
      const bet = parseInt(parts[3]);
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Недостаточно SVOлларов!`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);
      const gameId = db.createDiceGame(userId, opponentId, bet);
      const opponentUser = db.getUser(opponentId);
      const initiatorName = from.username ? `@${from.username}` : from.first_name;
      try {
        await bot.sendMessage(opponentId,
          `🔄 <b>${esc(initiatorName)} хочет реванш на кости!</b>\n\nСтавка: <b>${bet} 💵</b>`,
          { reply_markup: diceAcceptKeyboard(gameId), parse_mode: "HTML" }
        );
      } catch(_) {}
      return bot.editMessageText(
        `🔄 Запрос реванша отправлен!\n\nСтавка: <b>${bet} 💵</b>`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `dice_cancel_${gameId}` }]] } }
      );
    }

    // Accept dice
    if (data.startsWith("dice_accept_")) {
      const gameId = parseInt(data.replace("dice_accept_", ""));
      const game = db.getDiceGame(gameId);
      if (!game || game.status !== "pending") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Игра уже недоступна.", show_alert: true });
      }
      if (game.initiator_id === userId) {
        return bot.answerCallbackQuery(queryId, { text: "❌ Нельзя принять собственный вызов!", show_alert: true });
      }
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < game.bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${game.bet} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      const ok = db.acceptDiceGame(gameId, userId);
      if (!ok) return bot.answerCallbackQuery(queryId, { text: "❌ Ошибка принятия игры.", show_alert: true });

      await bot.answerCallbackQuery(queryId, { text: "✅ Принято! Бросай кубик!" });

      // Edit accept message → roll button
      await bot.editMessageText(
        `🎲 <b>Игра в кости началась!</b>\n\nСтавка: <b>${game.bet} 💵</b>\n\nНажми кнопку, чтобы бросить кубик 👇`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: diceRollKeyboard(gameId), parse_mode: "HTML" }
      );

      // Notify initiator
      const opponentName = from.username ? `@${from.username}` : from.first_name;
      try {
        const initMsg = await bot.sendMessage(game.initiator_id,
          `✅ <b>${esc(opponentName)} принял твой вызов!</b>\n\nСтавка: <b>${game.bet} 💵</b>\n\nБросай кубик! 🎲`,
          { reply_markup: diceRollKeyboard(gameId), parse_mode: "HTML" }
        );
        db.setDiceMsgId(gameId, "initiator_msg_id", initMsg.message_id);
      } catch(_) {}
      return;
    }

    // Decline dice
    if (data.startsWith("dice_decline_")) {
      const gameId = parseInt(data.replace("dice_decline_", ""));
      const game = db.getDiceGame(gameId);
      if (!game) return bot.answerCallbackQuery(queryId);
      await bot.answerCallbackQuery(queryId, { text: "❌ Вызов отклонён." });
      db.cancelDiceGame(gameId);
      await bot.editMessageText("❌ Ты отклонил вызов.", { chat_id: chatId, message_id: message.message_id });
      try {
        const declinerName = from.username ? `@${from.username}` : from.first_name;
        await bot.sendMessage(game.initiator_id, `😔 <b>${esc(declinerName)}</b> отклонил твой вызов. Ставка возвращена.`, { parse_mode: "HTML" });
      } catch(_) {}
      return;
    }

    // Cancel dice
    if (data.startsWith("dice_cancel_")) {
      const gameId = parseInt(data.replace("dice_cancel_", ""));
      const game = db.getDiceGame(gameId);
      if (!game || game.initiator_id !== userId) return bot.answerCallbackQuery(queryId);
      db.cancelDiceGame(gameId);
      await bot.answerCallbackQuery(queryId, { text: "🚫 Вызов отменён." });
      return bot.editMessageText("🚫 Вызов отменён. Ставка возвращена.", { chat_id: chatId, message_id: message.message_id });
    }

    // Roll dice
    if (data.startsWith("dice_roll_")) {
      const gameId = parseInt(data.replace("dice_roll_", ""));
      const game = db.getDiceGame(gameId);
      if (!game || game.status !== "waiting_rolls") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Игра недоступна.", show_alert: true });
      }
      const isInitiator = game.initiator_id === userId;
      const isOpponent  = game.opponent_id  === userId;
      if (!isInitiator && !isOpponent) {
        return bot.answerCallbackQuery(queryId, { text: "❌ Ты не участник этой игры.", show_alert: true });
      }
      // Check if already rolled
      if ((isInitiator && game.initiator_roll !== null) || (isOpponent && game.opponent_roll !== null)) {
        return bot.answerCallbackQuery(queryId, { text: "⏳ Ты уже бросил кубик. Ждём соперника...", show_alert: true });
      }

      const roll = Math.floor(Math.random() * 6) + 1;
      const diceEmojis = ["⚀","⚁","⚂","⚃","⚄","⚅"];
      const rollEmoji = diceEmojis[roll - 1];

      await bot.answerCallbackQuery(queryId, { text: `${rollEmoji} Ты выбросил ${roll}!`, show_alert: true });

      const updated = db.setDiceRoll(gameId, userId, roll);

      // Remove roll button for this player
      await bot.editMessageText(
        `🎲 Ты выбросил <b>${rollEmoji} ${roll}</b>!\n\n⏳ Ждём броска соперника...`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }
      );

      // If both rolled — resolve
      if (updated.initiator_roll !== null && updated.opponent_roll !== null) {
        const result = db.finishDiceGame(gameId);
        const iRoll = result.initiator_roll;
        const oRoll = result.opponent_roll;
        const iEmoji = diceEmojis[iRoll - 1];
        const oEmoji = diceEmojis[oRoll - 1];

        const initiatorUser = db.getUser(result.initiator_id);
        const opponentUser  = db.getUser(result.opponent_id);
        const iName = initiatorUser?.username ? `@${initiatorUser.username}` : "Игрок 1";
        const oName = opponentUser?.username  ? `@${opponentUser.username}`  : "Игрок 2";

        let outcomeText;
        if (result.isDraw) {
          outcomeText = `🤝 <b>Ничья!</b> Ставки возвращены.`;
        } else {
          const winnerUser = db.getUser(result.winnerId);
          const winnerName = winnerUser?.username ? `@${winnerUser.username}` : "победитель";
          outcomeText = `🏆 <b>Победил ${esc(winnerName)}!</b>\nПрибыль: +${result.bet} 💵`;
        }

        log.logDiceResult(result.initiator_id, result.opponent_id, result.bet, iRoll, oRoll, result.winnerId);

        const resultText =
          `🎲 <b>Результат!</b>\n\n` +
          `${esc(iName)}: ${iEmoji} <b>${iRoll}</b>\n` +
          `${esc(oName)}: ${oEmoji} <b>${oRoll}</b>\n\n` +
          outcomeText;

        // Send results to both players with correct rematch opponentId for each
        try { await bot.sendMessage(result.initiator_id, resultText, { reply_markup: diceRematchKeyboard(result.opponent_id, result.bet), parse_mode: "HTML" }); } catch(_) {}
        try { await bot.sendMessage(result.opponent_id,  resultText, { reply_markup: diceRematchKeyboard(result.initiator_id, result.bet), parse_mode: "HTML" }); } catch(_) {}
      }
      return;
    }

    // ════════════════════════════════════════════════════════════════════
    // ── MINESWEEPER ───────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════

    if (data === "mine_menu") {
      await bot.answerCallbackQuery(queryId);
      // Check for active game
      const active = db.getActiveMineGame(userId);
      if (active) {
        return bot.editMessageText(
          `💣 <b>Минное поле</b>\n\nСтавка: <b>${active.bet} 💵</b> | Безопасных найдено: <b>${active.safe_found}/2</b>\n\nНайди оба безопасных клетки, чтобы выиграть x2!\nОткрой 1 безопасную и забери x1.5 в любой момент.`,
          { chat_id: chatId, message_id: message.message_id, reply_markup: mineBoardKeyboard(active), parse_mode: "HTML" }
        );
      }
      return bot.editMessageText(
        `💣 <b>Минное поле 4×4</b>\n\n` +
        `16 клеток, 14 мин, 2 безопасные. Очень сложно!\n\n` +
        `• Найди обе безопасные → выигрываешь <b>x2</b> 🏆\n` +
        `• Открой 1 безопасную → можешь забрать <b>x1.5</b> 💰\n` +
        `• Нажмёшь на мину → теряешь всё 💥\n\n` +
        `Выбери ставку:`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: mineBetKeyboard(), parse_mode: "HTML" }
      );
    }

    if (data.startsWith("mine_bet_")) {
      const bet = parseInt(data.replace("mine_bet_", ""));
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < bet) {
        // show_alert must be BEFORE any other answerCallbackQuery call
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${bet} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);
      const gameId = db.createMineGame(userId, bet);
      if (!gameId) return bot.sendMessage(chatId, "❌ Ошибка создания игры.");
      const game = db.getMineGame(gameId);
      const msg = await bot.editMessageText(
        `💣 <b>Минное поле</b>\n\nСтавка: <b>${bet} 💵</b>\n\nНайди оба безопасных клетки! Удачи... 🍀`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: mineBoardKeyboard(game), parse_mode: "HTML" }
      );
      db.setMineMsgId(gameId, message.message_id);
      return;
    }

    if (data === "mine_noop") {
      return bot.answerCallbackQuery(queryId, { text: "Эта клетка уже открыта." });
    }

    if (data.startsWith("mine_reveal_")) {
      const parts = data.split("_"); // mine_reveal_<gameId>_<cellIndex>
      const gameId = parseInt(parts[2]);
      const cellIndex = parseInt(parts[3]);
      const game = db.getMineGame(gameId);

      if (!game || game.telegram_id !== userId || game.status !== "active") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Игра недоступна.", show_alert: true });
      }

      const result = db.revealMineCell(gameId, cellIndex);
      await bot.answerCallbackQuery(queryId);

      if (result.hitMine) {
        log.logMineResult(userId, game.bet, "lost", result.safe_found);
        // Show full board: revealed cells + all mines exposed
        const lostBoard = {
          id: game.id,
          bet: game.bet,
          board: result.board,
          revealed: result.board.map((isMine, i) => isMine || result.revealed[i]), // show all mines + already revealed
          safe_found: result.safe_found,
          status: "lost",
        };
        try {
          await bot.editMessageText(
            `💥 <b>БУМ! Ты нашёл мину!</b>\n\nСтавка <b>${game.bet} 💵</b> потеряна.\n\n💡 Вот где были все мины (💥) и безопасные клетки (✅):`,
            {
              chat_id: chatId, message_id: message.message_id,
              reply_markup: mineBoardKeyboard(lostBoard),
              parse_mode: "HTML",
            }
          );
        } catch(_) {}
        await bot.sendMessage(chatId, "😢 Не повезло! Попробуешь ещё раз?", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Играть снова", callback_data: `mine_bet_${game.bet}` }],
              [{ text: "🎲 В меню игр",   callback_data: "menu_games" }],
            ],
          },
        });
      } else if (result.status === "won") {
        log.logMineResult(userId, game.bet, "won", result.safe_found);
        const payout = game.bet * 2;
        await bot.editMessageText(
          `🏆 <b>ПОБЕДА! Ты нашёл все безопасные клетки!</b>\n\nВыигрыш: <b>+${payout} 💵</b> (x2)`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Играть снова", callback_data: `mine_bet_${game.bet}` }],
                [{ text: "🎲 В меню игр",   callback_data: "menu_games" }],
              ],
            },
            parse_mode: "HTML",
          }
        );
      } else {
        // Still active — update board
        const updatedGame = db.getMineGame(gameId);
        await bot.editMessageText(
          `💣 <b>Минное поле</b>\n\nСтавка: <b>${game.bet} 💵</b> | Безопасных: <b>${result.safe_found}/2</b>\n\nОсталась 1 безопасная клетка! Рискнёшь или заберёшь x1.5?`,
          { chat_id: chatId, message_id: message.message_id, reply_markup: mineBoardKeyboard(updatedGame), parse_mode: "HTML" }
        );
      }
      return;
    }

    if (data.startsWith("mine_cashout_")) {
      const gameId = parseInt(data.replace("mine_cashout_", ""));
      const game = db.getMineGame(gameId);
      if (!game || game.telegram_id !== userId || game.status !== "active") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Невозможно забрать.", show_alert: true });
      }
      const result = db.cashoutMine(gameId);
      if (!result) return bot.answerCallbackQuery(queryId, { text: "❌ Ошибка при выплате.", show_alert: true });
      // Single answerCallbackQuery call for success path
      await bot.answerCallbackQuery(queryId, { text: `💰 Забрал ${result.payout} 💵!`, show_alert: true });
      log.logMineResult(userId, game.bet, "cashed", game.safe_found);
      return bot.editMessageText(
        `💰 <b>Ты забрал выигрыш!</b>\n\nСтавка: ${game.bet} 💵 → Выигрыш: <b>${result.payout} 💵</b> (x${result.multiplier})`,
        {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Играть снова", callback_data: `mine_bet_${game.bet}` }],
              [{ text: "🎲 В меню игр",   callback_data: "menu_games" }],
            ],
          },
          parse_mode: "HTML",
        }
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // ── DUEL ──────────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════

    if (data === "duel_menu" || data === "duel_noop") {
      await bot.answerCallbackQuery(queryId);
      if (data === "duel_noop") return;
      const users = db.getAllUsers()
        .map(u => db.getUser(u.telegram_id))
        .filter(u => u && u.telegram_id !== userId);
      const openGames = db.getOpenDuelGames().filter(g => g.initiator_id !== userId);
      return bot.editMessageText(
        `🔫 <b>Русская рулетка</b>\n\nВступи в открытый вызов или создай свой:\n\n` +
        `• Барабан на 6 патронов, 1 заряжен\n` +
        `• Игроки нажимают на курок по очереди\n` +
        `• Вероятность выстрела растёт с каждым ходом\n` +
        `• Кто получил пулю — проиграл 💀\n` +
        `• Победитель забирает весь банк!`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: duelLobbyKeyboard(users, openGames), parse_mode: "HTML" }
      );
    }

    if (data.startsWith("duel_challenge_")) {
      await bot.answerCallbackQuery(queryId);
      const opponentData = data.replace("duel_challenge_", "");
      const opponentId = opponentData === "open" ? null : parseInt(opponentData);
      const opponentUser = opponentId ? db.getUser(opponentId) : null;
      const label = opponentUser?.username ? `@${opponentUser.username}` : "любого";
      return bot.editMessageText(
        `⚔️ Вызов: ${label}\n\nВыбери ставку:`,
        { chat_id: chatId, message_id: message.message_id, reply_markup: duelBetKeyboard(opponentData), parse_mode: "HTML" }
      );
    }

    if (data.startsWith("duel_bet_")) {
      const parts = data.split("_"); // duel_bet_<amount>_<opponentData>
      const bet = parseInt(parts[2]);
      const opponentData = parts.slice(3).join("_");
      const opponentId = opponentData === "open" ? null : parseInt(opponentData);

      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${bet} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);

      const gameId = db.createDuelGame(userId, opponentId, bet);
      if (!gameId) return bot.sendMessage(chatId, "❌ Не удалось создать дуэль.");

      const initiatorName = from.username ? `@${from.username}` : from.first_name;

      if (opponentId) {
        const opponentUser = db.getUser(opponentId);
        try {
          await bot.sendMessage(opponentId,
            `⚔️ <b>${esc(initiatorName)} вызывает тебя на дуэль!</b>\n\nСтавка: <b>${bet} 💵</b>\n\nПравила: 3 HP, выбираешь атаку/защиту/уклон каждый раунд.\nПримешь вызов?`,
            { reply_markup: duelAcceptKeyboard(gameId), parse_mode: "HTML" }
          );
        } catch(_) {}
        return bot.editMessageText(
          `⚔️ Вызов отправлен <b>@${esc(opponentUser?.username || "игроку")}</b>!\n\nСтавка: <b>${bet} 💵</b>\nОжидаем ответа... ⏳`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `duel_cancel_${gameId}` }]] } }
        );
      } else {
        const allUsers = db.getAllUsers();
        for (const u of allUsers) {
          if (u.telegram_id === userId) continue;
          try {
            await bot.sendMessage(u.telegram_id,
              `⚔️ <b>${esc(initiatorName)} бросает открытый вызов на дуэль!</b>\n\nСтавка: <b>${bet} 💵</b>`,
              { reply_markup: duelAcceptKeyboard(gameId), parse_mode: "HTML" }
            );
          } catch(_) {}
          await new Promise(r => setTimeout(r, 30));
        }
        return bot.editMessageText(
          `⚔️ Открытый вызов разослан!\n\nСтавка: <b>${bet} 💵</b>\nОжидаем принятия... ⏳`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `duel_cancel_${gameId}` }]] } }
        );
        return;
      }
    }

    // Duel rematch
    if (data.startsWith("duel_rematch_")) {
      const parts = data.split("_"); // duel_rematch_<opponentId>_<bet>
      const opponentId = parseInt(parts[2]);
      const bet = parseInt(parts[3]);
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Недостаточно SVOлларов!`, show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);
      const gameId = db.createDuelGame(userId, opponentId, bet);
      const initiatorName = from.username ? `@${from.username}` : from.first_name;
      try {
        await bot.sendMessage(opponentId,
          `🔄 <b>${esc(initiatorName)} хочет реванш!</b>\n\nСтавка: <b>${bet} 💵</b>`,
          { reply_markup: duelAcceptKeyboard(gameId), parse_mode: "HTML" }
        );
      } catch(_) {}
      return bot.editMessageText(
        `🔄 Запрос реванша отправлен!\n\nСтавка: <b>${bet} 💵</b>`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "❌ Отменить", callback_data: `duel_cancel_${gameId}` }]] } }
      );
    }

    // Accept roulette challenge
    if (data.startsWith("duel_accept_")) {
      const gameId = parseInt(data.replace("duel_accept_", ""));
      const game = db.getDuelGame(gameId);
      if (!game || game.status !== "pending") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Вызов уже недоступен.", show_alert: true });
      }
      if (game.initiator_id === userId) {
        return bot.answerCallbackQuery(queryId, { text: "❌ Нельзя принять собственный вызов!", show_alert: true });
      }
      const user = db.getUser(userId);
      if ((user?.svodollars || 0) < game.bet) {
        return bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${game.bet} 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
      }
      const ok = db.acceptDuelGame(gameId, userId);
      if (!ok) return bot.answerCallbackQuery(queryId, { text: "❌ Ошибка принятия.", show_alert: true });

      await bot.answerCallbackQuery(queryId, { text: "🔫 Принято! Рулетка начинается!" });

      const initiatorUser = db.getUser(game.initiator_id);
      const opponentUser  = db.getUser(userId);
      const iName = initiatorUser?.username ? `@${initiatorUser.username}` : "Игрок 1";
      const oName = opponentUser?.username  ? `@${opponentUser.username}`  : "Игрок 2";

      const startText =
        `🔫 <b>Русская рулетка началась!</b>\n\n` +
        `${esc(iName)} vs ${esc(oName)}\n` +
        `Ставка: <b>${game.bet} 💵</b>\n\n` +
        `Барабан заряжен. 6 патронов, 1 настоящий.\n` +
        `Первым крутит ${esc(iName)} 🎯`;

      try { await bot.sendMessage(game.initiator_id, startText, { reply_markup: duelActionKeyboard(gameId), parse_mode: "HTML" }); } catch(_) {}
      try { await bot.sendMessage(userId, startText, { parse_mode: "HTML" }); } catch(_) {}
      await bot.editMessageText("🔫 Рулетка началась!", { chat_id: chatId, message_id: message.message_id });
      return;
    }

    // Decline roulette
    if (data.startsWith("duel_decline_")) {
      const gameId = parseInt(data.replace("duel_decline_", ""));
      const game = db.getDuelGame(gameId);
      if (!game) return bot.answerCallbackQuery(queryId);
      await bot.answerCallbackQuery(queryId, { text: "❌ Вызов отклонён." });
      db.cancelDuelGame(gameId);
      await bot.editMessageText("❌ Ты отклонил вызов.", { chat_id: chatId, message_id: message.message_id });
      try {
        const declinerName = from.username ? `@${from.username}` : from.first_name;
        await bot.sendMessage(game.initiator_id, `😔 <b>${esc(declinerName)}</b> отклонил твой вызов. Ставка возвращена.`, { parse_mode: "HTML" });
      } catch(_) {}
      return;
    }

    // Cancel roulette
    if (data.startsWith("duel_cancel_")) {
      const gameId = parseInt(data.replace("duel_cancel_", ""));
      const game = db.getDuelGame(gameId);
      if (!game || game.initiator_id !== userId) return bot.answerCallbackQuery(queryId);
      db.cancelDuelGame(gameId);
      await bot.answerCallbackQuery(queryId, { text: "🚫 Вызов отменён." });
      return bot.editMessageText("🚫 Вызов отменён. Ставка возвращена.", { chat_id: chatId, message_id: message.message_id });
    }

    // Pull the trigger
    if (data.startsWith("duel_pull_")) {
      const gameId = parseInt(data.replace("duel_pull_", ""));
      const game = db.getRouletteGame(gameId);

      if (!game || game.status !== "active") {
        return bot.answerCallbackQuery(queryId, { text: "❌ Игра недоступна.", show_alert: true });
      }
      if (game.current_turn !== userId) {
        return bot.answerCallbackQuery(queryId, { text: "⏳ Сейчас не твой ход!", show_alert: true });
      }

      const initiatorUser = db.getUser(game.initiator_id);
      const opponentUser  = db.getUser(game.opponent_id);
      const iName = initiatorUser?.username ? `@${initiatorUser.username}` : "Игрок 1";
      const oName = opponentUser?.username  ? `@${opponentUser.username}`  : "Игрок 2";
      const myName = userId === game.initiator_id ? iName : oName;
      const nextName = userId === game.initiator_id ? oName : iName;

      await bot.answerCallbackQuery(queryId, { text: "🔫 Крутишь барабан..." });

      // Edit to show suspense
      await bot.editMessageText(
        `🔫 <b>${esc(myName)} нажимает на курок...</b>\n\n` +
        `Патрон ${game.chamber + 1} из 6\n` +
        `Вероятность выстрела: <b>${game.chamber + 1}/6</b> 😰`,
        { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }
      );

      // Small delay for suspense
      await new Promise(r => setTimeout(r, 1500));

      const result = db.pullTrigger(gameId, userId);
      if (!result) return;

      if (result.fired) {
        // BANG
        const loserUser  = db.getUser(result.loserId);
        const winnerUser = db.getUser(result.winnerId);
        const loserName  = loserUser?.username  ? `@${loserUser.username}`  : "Игрок";
        const winnerName = winnerUser?.username ? `@${winnerUser.username}` : "Игрок";

        log.logDuelResult(game.initiator_id, game.opponent_id, game.bet, result.winnerId, game.chamber + 1);

        const finalText =
          `💥 <b>БАХ!</b>\n\n` +
          `<b>${esc(loserName)}</b> получил пулю! 💀\n\n` +
          `🏆 Победил <b>${esc(winnerName)}</b>!\n` +
          `Выигрыш: <b>+${game.bet} 💵</b>`;

        const rematchKbForInitiator = duelRematchKeyboard(game.opponent_id, game.bet);
        const rematchKbForOpponent  = duelRematchKeyboard(game.initiator_id, game.bet);

        try { await bot.editMessageText(finalText, { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }); } catch(_) {}
        try { await bot.sendMessage(game.initiator_id, finalText, { reply_markup: rematchKbForInitiator, parse_mode: "HTML" }); } catch(_) {}
        try { await bot.sendMessage(game.opponent_id,  finalText, { reply_markup: rematchKbForOpponent,  parse_mode: "HTML" }); } catch(_) {}

      } else {
        // Safe — next player's turn
        const safeText =
          `😮‍💨 <b>Осечка!</b> ${esc(myName)} выжил.\n\n` +
          `Патронов проверено: ${result.chamber + 1}/6\n` +
          `Теперь очередь <b>${esc(nextName)}</b> 🎯`;

        await bot.editMessageText(safeText, { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" });

        // Send trigger button to next player
        try {
          await bot.sendMessage(result.nextTurn, safeText, { reply_markup: duelActionKeyboard(gameId), parse_mode: "HTML" });
        } catch(_) {}
      }
      return;
    }

    // ════════════════════════════════════════════════════════════════════
    // ── ADMIN PANEL ───────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════

    if (data.startsWith("admin_")) {
      if (userId !== ADMIN_ID) {
        return bot.answerCallbackQuery(queryId, { text: "⛔ Нет прав.", show_alert: true });
      }
      await bot.answerCallbackQuery(queryId);

      if (data === "admin_noop") return;

      if (data === "admin_addcoins") {
        adminState[userId] = { action: "addcoins_id" };
        return bot.sendMessage(chatId, "💵 Введи Telegram ID пользователя, которому начислить коины:");
      }

      if (data === "admin_userlist") {
        const users = db.getAllUsers().map(u => db.getUser(u.telegram_id)).filter(Boolean);
        const list = users.map(u =>
          `• ${u.username ? `@${u.username}` : "Аноним"} (id:${u.telegram_id}) — ${u.svodollars}💵 ${u.total_score}pts`
        ).join("\n");
        return bot.sendMessage(chatId,
          `📋 <b>Все пользователи (${users.length}):</b>\n\n${list || "Нет пользователей"}`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // Unknown callback — just ack
    await bot.answerCallbackQuery(queryId);

  } catch (error) {
    // Fix: log full stack, not just message
    log.logError(from, error);
    try { await bot.answerCallbackQuery(queryId); } catch(_) {}
    try { await bot.sendMessage(chatId, "😕 Произошла внутренняя ошибка. Попробуй ещё раз."); } catch(_) {}
  }
});
