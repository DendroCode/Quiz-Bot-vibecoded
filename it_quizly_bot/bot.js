require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const allQuestions = require("./questions");
const log = require("./logger");
// const { generateQuestions } = require("./ai_questions");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0");

if (!TOKEN) { console.error("❌ BOT_TOKEN не задан в .env!"); process.exit(1); }

// Экранирует HTML-теги перед отправкой в Telegram
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Константы ────────────────────────────────────────────────────────────────
const QUESTIONS_PER_GAME = 7;
const POINTS_PER_CORRECT = 10;
const ANSWER_TIMEOUT_SEC = 35;

// SVOллары: за каждый правильный ответ + бонус за полное прохождение
const SVO_PER_CORRECT   = 1;
const SVO_PERFECT_BONUS = 5;  // бонус за 7/7

const CATEGORIES = {
  algorithms: { label: "🧮 Алгоритмы и структуры данных" },
  interview:  { label: "💼 Вопросы с собеседований" },
  databases:  { label: "🗄️ Базы данных / SQL" },
  devops:     { label: "🌐 Сети / DevOps" },
  guess_lang: { label: "🔍 Угадай язык по коду" },
  web:        { label: "🌍 Web / Frontend" },
  random:     { label: "🎲 Случайные темы" },
};

// Хранилище активных таймеров: userId → timeoutId
const timers = {};

// ── Вспомогательные функции ──────────────────────────────────────────────────
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
  const total = totalTime || ANSWER_TIMEOUT_SEC;
  const filled = Math.round((secondsLeft / total) * 10);
  const bar = "🟩".repeat(filled) + "⬜".repeat(10 - filled);
  return `${bar} ${secondsLeft}с`;
}

function calcSvo(correctCount, total) {
  const base = correctCount * SVO_PER_CORRECT;
  const bonus = correctCount === total ? SVO_PERFECT_BONUS : 0;
  return base + bonus;
}

// ── Клавиатуры ───────────────────────────────────────────────────────────────
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎮 Начать викторину", callback_data: "menu_play" }],
      [
        { text: "🏆 Таблица лидеров", callback_data: "menu_leaderboard" },
        { text: "📊 Мой профиль",     callback_data: "menu_profile" },
      ],
      [
        { text: "🛒 Магазин",         callback_data: "menu_shop" },
        { text: "ℹ️ Правила",         callback_data: "menu_rules" },
      ],
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

// ── Таймер вопроса ───────────────────────────────────────────────────────────
function clearTimer(userId) {
  if (timers[userId]) { clearTimeout(timers[userId]); delete timers[userId]; }
}

async function startQuestionTimer(bot, chatId, userId, session) {
  clearTimer(userId);

  // Проверяем бонус к таймеру
  const user = db.getUser(userId);
  let timerBonus = 0;
  if (user && user.timer_bonus > 0) {
    timerBonus = 5;
    db.useTimerBonus(userId);
  }
  const totalTime = ANSWER_TIMEOUT_SEC + timerBonus;
  const bonusLabel = timerBonus > 0 ? ` <b>+${timerBonus}с бонус!</b>` : "";

  // Отправляем таймер отдельным сообщением
  const timerMsg = await bot.sendMessage(chatId, `⏱ ${timerBar(totalTime, totalTime)}${bonusLabel}`, { parse_mode: "HTML" });
  db.setSessionTimerMsg(session.id, timerMsg.message_id);

  // Обновляем каждые 5 секунд
  let secondsLeft = totalTime;
  const interval = setInterval(async () => {
    secondsLeft -= 5;
    if (secondsLeft <= 0) { clearInterval(interval); return; }
    try {
      await bot.editMessageText(`⏱ ${timerBar(secondsLeft, totalTime)}`, {
        chat_id: chatId,
        message_id: timerMsg.message_id,
      });
    } catch(e) {}
  }, 5000);

  // Основной таймаут — время вышло
  timers[userId] = setTimeout(async () => {
    clearInterval(interval);
    const activeSession = db.getActiveSession(userId);
    if (!activeSession) return;

    const q = activeSession.questions[activeSession.current_index];
    const labels = ["A", "B", "C", "D"];
    const newIndex = activeSession.current_index + 1;

    try {
      await bot.editMessageText(
        `⏱ ${timerBar(0, totalTime)}\n\n⌛ <b>Время вышло!</b>\n\nПравильный ответ: <b>${escHtml(q.options[q.answer])}</b>\n\n💡 ${escHtml(q.explanation)}`,
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
      const updated = { ...activeSession, current_index: newIndex };
      setTimeout(() => sendQuestion(bot, chatId, userId, updated), 1000);
    }
  }, totalTime * 1000);
}

// ── Отправка вопроса ─────────────────────────────────────────────────────────
async function sendQuestion(bot, chatId, userId, session) {
  const q = session.questions[session.current_index];
  const num = session.current_index + 1;
  const total = session.questions.length;

  const text =
    `<b>${q.label} • Вопрос ${num}/${total}</b>\n` +
    `${progressBar(num - 1, total)}\n\n` +
    `❓ ${escHtml(q.question)}`;

  await bot.sendMessage(chatId, text, {
    reply_markup: answerKeyboard(q.options),
    parse_mode: "HTML",
  });

  await startQuestionTimer(bot, chatId, userId, session);
}

// ── Итоги игры ───────────────────────────────────────────────────────────────
async function sendResults(bot, chatId, score, total, category, svoEarned) {
  const pct = Math.round((score / total) * 100);
  let medal = "😬";
  if (pct >= 90) medal = "🥇";
  else if (pct >= 70) medal = "🥈";
  else if (pct >= 50) medal = "🥉";

  const pts = score * POINTS_PER_CORRECT;
  const catLabel = CATEGORIES[category]?.label || category;
  const isPerfect = score === total;

  const text =
    `${medal} <b>Игра завершена!</b>\n\n` +
    `📚 Тема: ${catLabel}\n` +
    `✅ Правильных: ${score}/${total}\n` +
    `📈 Результат: ${pct}%\n` +
    `⭐ Очки: +${pts}\n` +
    `💵 SVOллары: +${svoEarned}${isPerfect ? ` (включая бонус +${SVO_PERFECT_BONUS} за идеал 🎯)` : ""}\n\n` +
    (isPerfect
      ? "🔥 Идеальный результат! Ты настоящий эксперт!"
      : pct >= 70
      ? "👍 Отличный результат! Продолжай в том же духе."
      : "💪 Есть куда расти. Попробуй ещё раз!");

  await bot.sendMessage(chatId, text, {
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
  });
}

// ── Лидерборд ─────────────────────────────────────────────────────────────────
const RAINBOW_FRAMES = [
  ["🔴","🟠","🟡","🟢","🔵","🟣"],
  ["🟣","🔴","🟠","🟡","🟢","🔵"],
  ["🔵","🟣","🔴","🟠","🟡","🟢"],
  ["🟢","🔵","🟣","🔴","🟠","🟡"],
  ["🟡","🟢","🔵","🟣","🔴","🟠"],
  ["🟠","🟡","🟢","🔵","🟣","🔴"],
];
const rainbowIntervals = {};

function buildLeaderboardText(leaders, frame) {
  const f = (frame || 0) % RAINBOW_FRAMES.length;
  const dots = RAINBOW_FRAMES[f].join("");
  const medals = ["🥇", "🥈", "🥉"];
  if (leaders.length === 0) return "Пока никто не играл. Будь первым! 🚀";
  return leaders.map((u, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const rawName = u.username ? `@${u.username}` : "Аноним";
    const link = u.username ? `<a href="https://t.me/${u.username}">${rawName}</a>` : rawName;
    // Цветные точки ПЕРЕД ссылкой — имя внутри <a> остаётся чистым и кликабельным
    const uname = u.rainbow_nick ? `${dots} ${link}` : `<b>${link}</b>`;
    const poops = db.getPoopCount(u.telegram_id);
    const poopStr = poops > 0 ? ` ${"💩".repeat(Math.min(poops, 3))}` : "";
    return `${icon} ${uname} — ${u.total_score} очков | 💵 ${u.svodollars || 0} SVOлларов${poopStr}`;
  }).join("\n");
}

function startRainbowAnimation(bot, chatId, messageId, leaders) {
  const key = `${chatId}_${messageId}`;
  if (rainbowIntervals[key]) return;
  if (!leaders.some(u => u.rainbow_nick)) return;
  let frame = 0;
  rainbowIntervals[key] = setInterval(async () => {
    frame++;
    try {
      await bot.editMessageText(
        `🏆 <b>Таблица лидеров</b>\n\n${buildLeaderboardText(leaders, frame)}`,
        { chat_id: chatId, message_id: messageId, reply_markup: leaderboardKeyboard(leaders), parse_mode: "HTML", disable_web_page_preview: true }
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

function leaderboardKeyboard(leaders) {
  const buttons = [];
  leaders.filter(u => u.username).forEach(u => {
    buttons.push([
      { text: `✉️ @${u.username}`, url: `https://t.me/${u.username}` },
      { text: `💩 Кинуть`, callback_data: `poop_${u.telegram_id}_${u.username || "user"}` },
    ]);
  });
  buttons.push([{ text: "⬅️ Назад", callback_data: "menu_main" }]);
  return { inline_keyboard: buttons };
}

// ── Магазин ───────────────────────────────────────────────────────────────────
function shopText(user) {
  const svo = user.svodollars || 0;
  const hasRainbow = user.rainbow_nick ? "✅ Куплено" : "15 💵";
  const timerBonuses = user.timer_bonus || 0;
  return (
    `🛒 <b>Магазин SVOкоинов</b>\n\n` +
    `💵 Твой баланс: <b>${svo} SVOкоинов</b>\n\n` +
    `🌈 <b>Переливающийся ник</b> в лидерборде — ${hasRainbow}\n` +
    `⏱ <b>+5 сек к таймеру</b> (на 1 игру) — 10 💵 | есть: ${timerBonuses}\n` +
    `💩 <b>Кинуть какашку</b> — 5 💵 (через лидерборд)\n` +
    `🔥 <b>Сжечь SVOкоины</b> — 1 💵 за 1\n\n` +
    `_За 3-4 игры зарабатываешь ~15-20 коинов_`
  );
}

function shopKeyboard(user) {
  const svo = user.svodollars || 0;
  const hasRainbow = !!user.rainbow_nick;
  return {
    inline_keyboard: [
      [{ text: hasRainbow ? "🌈 Ник уже переливается!" : `🌈 Купить ник (15 💵)`, callback_data: "shop_rainbow" }],
      [{ text: `⏱ Купить +5 сек (10 💵)`, callback_data: "shop_timer" }],
      [{ text: `🔥 Сжечь 1 SVOкоин`, callback_data: "shop_burn_1" },
       { text: `🔥🔥 Сжечь 5`, callback_data: "shop_burn_5" }],
      [{ text: "⬅️ Назад", callback_data: "menu_main" }],
    ],
  };
}

// ── ЗАПУСК ────────────────────────────────────────────────────────────────────
db.initDB().then(() => {
  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("🤖 IT-Quiz бот запущен!");

  // Логируем все входящие текстовые сообщения
  bot.on("message", (msg) => { log.logMessage(msg.from, msg.text); });

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const { id: chatId, username, first_name } = msg.from;
    db.ensureUser(chatId, username || first_name);
    log.logStart(msg.from);
    const name = first_name || username || "друг";
    await bot.sendMessage(chatId,
      `👋 Привет, <b>${name}</b>!\n\n` +
      `🤓 Добро пожаловать в <b>IT-викторину</b>!\n\n` +
      `Темы: алгоритмы, SQL, сети, DevOps, frontend и другое.\n` +
      `За правильные ответы получай <b>очки</b> и <b>💵 SVOллары</b>.\n` +
      `На каждый вопрос — <b>${ANSWER_TIMEOUT_SEC} секунд</b>. ⏱\n\n` +
      `Готов? 🚀`,
      { reply_markup: mainMenuKeyboard(), parse_mode: "HTML" }
    );
  });

  // ── /broadcast (только для админа) ────────────────────────────────────────
  bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (msg.from.id !== ADMIN_ID) {
      return bot.sendMessage(msg.chat.id, "⛔ У тебя нет прав для этой команды.");
    }
    const text = match[1];
    const users = db.getAllUsers();
    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        await bot.sendMessage(u.telegram_id, `📢 <b>Сообщение от администратора:</b>\n\n${text}`, { parse_mode: "HTML" });
        sent++;
      } catch(e) { failed++; }
      await new Promise(r => setTimeout(r, 50)); // небольшая задержка чтобы не словить rate limit
    }
    await bot.sendMessage(msg.chat.id, `✅ Рассылка завершена: отправлено ${sent}, ошибок ${failed}.`);
    log.logMessage(msg.from, `[BROADCAST] ${text}`);
  });

  // ── Callback handler ───────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    try {
      const { id: queryId, message, data, from } = query;
      const chatId = message.chat.id;
      const userId = from.id;

      // Пытаемся ответить на callback, игнорируем ошибки (устаревший query)
      try {
        await bot.answerCallbackQuery(queryId);
      } catch (e) {
        // Просто логируем, не даём боту упасть
        log.logMessage(from, `[answerCallbackQuery error] ${e.message}`);
      }

      // Логируем нажатие кнопки
      try {
        log.logButton(from, data);
      } catch (e) {}

      // Главное меню
      if (data === "menu_main") {
        return bot.sendMessage(chatId, "🏠 Главное меню:", { reply_markup: mainMenuKeyboard(), parse_mode: "HTML" });
      }

      if (data === "menu_play") {
        await bot.editMessageText("🎮 <b>Выбери тему:</b>", {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: categoryKeyboard(), parse_mode: "HTML",
        });
        return;
      }

      if (data === "menu_rules") {
        await bot.editMessageText(
          `📖 <b>Правила игры:</b>\n\n` +
          `• ${QUESTIONS_PER_GAME} вопросов за игру, 4 варианта ответа\n` +
          `• На каждый вопрос — <b>${ANSWER_TIMEOUT_SEC} секунд</b> ⏱\n` +
          `• За правильный ответ: +${POINTS_PER_CORRECT} очков\n` +
          `• За правильный ответ: +${SVO_PER_CORRECT} 💵 SVOллар\n` +
          `• Бонус за идеальную игру (7/7): +${SVO_PERFECT_BONUS} SVOлларов 🎯\n` +
          `• Очки идут в таблицу лидеров\n` +
          `• Стрик — серия игр без единой ошибки\n\nУдачи! 🍀`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
            parse_mode: "HTML",
          }
        );
        return;
      }

      if (data === "menu_profile") {
        const user = db.getUser(userId);
        if (!user) return bot.sendMessage(chatId, "Сначала напиши /start");
        const accuracy = user.games_played > 0
          ? Math.round((user.correct_answers / (user.games_played * QUESTIONS_PER_GAME)) * 100) : 0;
        await bot.editMessageText(
          `👤 <b>Профиль: @${user.username || "Аноним"}</b>${user.rainbow_nick ? " 🌈" : ""}\n\n` +
          `⭐ Очки: <b>${user.total_score}</b>\n` +
          `💵 SVOкоины: <b>${user.svodollars || 0}</b>\n` +
          `⏱ Бонусы таймера: <b>${user.timer_bonus || 0}</b>\n` +
          `💩 Получено какашек: <b>${db.getPoopCount(userId)}</b>\n` +
          `🎮 Игр сыграно: <b>${user.games_played}</b>\n` +
          `✅ Правильных ответов: <b>${user.correct_answers}</b>\n` +
          `🎯 Точность: <b>${accuracy}%</b>\n` +
          `🔥 Текущий стрик: <b>${user.streak}</b>\n` +
          `🏆 Лучший стрик: <b>${user.best_streak}</b>`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "menu_main" }]] },
            parse_mode: "HTML",
          }
        );
        return;
      }

      if (data === "menu_leaderboard") {
        const leaders = db.getLeaderboard();
        await bot.editMessageText(
          `🏆 <b>Таблица лидеров</b>\n\n${buildLeaderboardText(leaders)}`,
          {
            chat_id: chatId, message_id: message.message_id,
            reply_markup: leaderboardKeyboard(leaders),
            parse_mode: "HTML",
          }
        );
        return;
      }

      // Магазин
      if (data === "menu_shop") {
        const user = db.getUser(userId);
        if (!user) return;
        await bot.editMessageText(shopText(user), {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: shopKeyboard(user), parse_mode: "HTML",
        });
        return;
      }

      if (data === "shop_rainbow") {
        const user = db.getUser(userId);
        if (!user) return;
        if (user.rainbow_nick) {
          await bot.answerCallbackQuery(queryId, { text: "🌈 Ник уже переливается!", show_alert: true });
          return;
        }
        if ((user.svodollars || 0) < 15) {
          await bot.answerCallbackQuery(queryId, { text: `❌ Нужно 15 💵, у тебя ${user.svodollars || 0}`, show_alert: true });
          return;
        }
        db.buyRainbowNick(userId);
        await bot.answerCallbackQuery(queryId, { text: "🌈 Ник теперь переливается в лидерборде!", show_alert: true });
        const updated = db.getUser(userId);
        await bot.editMessageText(shopText(updated), {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: shopKeyboard(updated), parse_mode: "HTML",
        });
        return;
      }

      if (data === "shop_timer") {
        const user = db.getUser(userId);
        if (!user) return;
        if ((user.svodollars || 0) < 10) {
          await bot.answerCallbackQuery(queryId, { text: `❌ Нужно 10 💵, у тебя ${user.svodollars || 0}`, show_alert: true });
          return;
        }
        db.buyTimerBonus(userId);
        await bot.answerCallbackQuery(queryId, { text: "⏱ Куплено! На следующий вопрос будет +5 секунд.", show_alert: true });
        const updated = db.getUser(userId);
        await bot.editMessageText(shopText(updated), {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: shopKeyboard(updated), parse_mode: "HTML",
        });
        return;
      }

      if (data === "shop_burn_1" || data === "shop_burn_5") {
        const amount = data === "shop_burn_1" ? 1 : 5;
        const user = db.getUser(userId);
        if (!user) return;
        if ((user.svodollars || 0) < amount) {
          await bot.answerCallbackQuery(queryId, { text: `❌ Нужно ${amount} 💵, у тебя ${user.svodollars || 0}`, show_alert: true });
          return;
        }
        db.burnCoins(userId, amount);
        const flames = ["🔥","🔥🔥","💀🔥","🌋","☄️"];
        const msg = flames[Math.floor(Math.random() * flames.length)];
        await bot.answerCallbackQuery(queryId, { text: `${msg} ${amount} SVOкоин(ов) сгорело в огне истории!`, show_alert: true });
        const updated = db.getUser(userId);
        await bot.editMessageText(shopText(updated), {
          chat_id: chatId, message_id: message.message_id,
          reply_markup: shopKeyboard(updated), parse_mode: "HTML",
        });
        return;
      }

      // 💩 Кинуть какашку
      if (data.startsWith("poop_")) {
        const parts = data.split("_");
        const targetId = parseInt(parts[1]);
        const targetName = parts[2] || "пользователя";

        if (targetId === userId) {
          await bot.answerCallbackQuery(queryId, { text: "💩 Нельзя кинуть какашку в себя!", show_alert: true });
          return;
        }
        const user = db.getUser(userId);
        if (!user || (user.svodollars || 0) < 5) {
          await bot.answerCallbackQuery(queryId, { text: `❌ Нужно 5 💵, у тебя ${user?.svodollars || 0}`, show_alert: true });
          return;
        }
        db.throwPoop(userId, targetId);
        await bot.answerCallbackQuery(queryId, { text: `💩 Попал! @${targetName} теперь в дерьме!`, show_alert: true });

        // Уведомить жертву
        try {
          const attacker = db.getUser(userId);
          const attackerName = from.username ? `@${from.username}` : from.first_name;
          await bot.sendMessage(targetId,
            `💩 <b>${attackerName} кинул в тебя какашку!</b>\n\nТеперь она красуется рядом с твоим именем в лидерборде 😂`,
            { parse_mode: "HTML" }
          );
        } catch(e) {}

        // Обновить лидерборд
        const leaders = db.getLeaderboard();
        await bot.editMessageText(
          `🏆 <b>Таблица лидеров</b>\n\n${buildLeaderboardText(leaders)}`,
          { chat_id: chatId, message_id: message.message_id, reply_markup: leaderboardKeyboard(leaders), parse_mode: "HTML" }
        );
        return;
      }

      // Выбор категории — всегда используем статические вопросы
      if (data.startsWith("cat_")) {
        const category = data.replace("cat_", "");
        db.ensureUser(userId, from.username || from.first_name);

        // Получаем вопросы статически
        const questions = getQuestions(category);

        if (!questions || questions.length === 0) {
          await bot.sendMessage(chatId, "😕 Вопросы для этой темы пока не добавлены.");
          return;
        }

        db.createSession(userId, category, questions);
        const session = db.getActiveSession(userId);

        // Редактируем сообщение с выбором темы на стартовое
        await bot.editMessageText(
          `🎮 <b>Тема: ${CATEGORIES[category]?.label}</b>\n\nПоехали! 👇`,
          { chat_id: chatId, message_id: message.message_id, parse_mode: "HTML" }
        );

        await sendQuestion(bot, chatId, userId, session);
        return;
      }

      // Ответ на вопрос
      if (data.startsWith("ans_")) {
        const answerIndex = parseInt(data.replace("ans_", ""));
        const session = db.getActiveSession(userId);
        if (!session) {
          await bot.sendMessage(chatId, "❌ Активная игра не найдена. Начни новую!", { reply_markup: mainMenuKeyboard() });
          return;
        }

        clearTimer(userId); // останавливаем таймер

        const q = session.questions[session.current_index];
        const isCorrect = answerIndex === q.answer;
        const newScore = session.score + (isCorrect ? 1 : 0);
        const newIndex = session.current_index + 1;
        const labels = ["A", "B", "C", "D"];

        const resultText = isCorrect
          ? `✅ <b>Правильно!</b>\n\n💡 ${escHtml(q.explanation)}`
          : `❌ <b>Неправильно.</b>\n\nПравильный ответ: <b>${escHtml(q.options[q.answer])}</b>\n\n💡 ${escHtml(q.explanation)}`;

        await bot.editMessageText(resultText, {
          chat_id: chatId, message_id: message.message_id, parse_mode: "HTML",
        });

        // Удаляем сообщение с таймером
        if (session.timer_message_id) {
          try { await bot.deleteMessage(chatId, session.timer_message_id); } catch(e) {}
        }

        if (newIndex >= session.questions.length) {
          const svo = calcSvo(newScore, session.questions.length);
          db.finishSession(session.id, userId, newScore * POINTS_PER_CORRECT, newScore, newScore === session.questions.length, svo);
          log.logGameResult(from, newScore, session.questions.length, session.category);
          await sendResults(bot, chatId, newScore, session.questions.length, session.category, svo);
        } else {
          db.updateSession(session.id, newIndex, newScore);
          const updated = { ...session, current_index: newIndex, score: newScore };
          setTimeout(() => sendQuestion(bot, chatId, userId, updated), 800);
        }
      }
    } catch (error) {
      // Глобальная обработка ошибок в callback-обработчике
      log.logMessage(query.from, `[Callback Global Error] ${error.message}`);
      try {
        await bot.sendMessage(query.message.chat.id, "😕 Произошла внутренняя ошибка. Пожалуйста, попробуйте ещё раз.");
      } catch (e) {}
    }
  });

  // ── Текстовые команды ──────────────────────────────────────────────────────
  bot.onText(/\/play/, async (msg) => {
    db.ensureUser(msg.from.id, msg.from.username || msg.from.first_name);
    await bot.sendMessage(msg.from.id, "🎮 <b>Выбери тему:</b>", { reply_markup: categoryKeyboard(), parse_mode: "HTML" });
  });

  bot.onText(/\/top/, async (msg) => {
    const leaders = db.getLeaderboard();
    const sentTop = await bot.sendMessage(msg.from.id,
      `🏆 <b>Топ-10</b>\n\n${buildLeaderboardText(leaders)}`,
      { reply_markup: leaderboardKeyboard(leaders), parse_mode: "HTML", disable_web_page_preview: true }
    );
    startRainbowAnimation(bot, msg.from.id, sentTop.message_id, leaders);
  });

  bot.onText(/\/profile/, async (msg) => {
    const user = db.getUser(msg.from.id);
    if (!user) { await bot.sendMessage(msg.from.id, "Сначала начни игру: /start"); return; }
    const accuracy = user.games_played > 0
      ? Math.round((user.correct_answers / (user.games_played * QUESTIONS_PER_GAME)) * 100) : 0;
    await bot.sendMessage(msg.from.id,
      `👤 @${user.username || "Аноним"}\n⭐ Очки: ${user.total_score}\n💵 SVOллары: ${user.svodollars || 0}\n🎮 Игр: ${user.games_played}\n🎯 Точность: ${accuracy}%\n🔥 Стрик: ${user.streak}`,
      { parse_mode: "HTML" }
    );
  });

}).catch(err => {
  console.error("❌ Ошибка инициализации БД:", err);
  process.exit(1);
});