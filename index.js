const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const QRCode = require('qrcode');
const moment = require('moment-timezone');
const cloudinary = require('cloudinary').v2;
const ytdl = require('ytdl-core');
const { Client } = require('genius-lyrics');
require("dotenv").config();

// Khởi tạo Express server
const app = express();
const port = 3000;

// Phục vụ file HTML
app.get('/help', async (req, res) => {
  try {
    const htmlContent = await fs.readFile('help.html', 'utf8');
    res.send(htmlContent);
  } catch (error) {
    res.status(500).send('Error loading help page');
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`🌐 Help server running at http://localhost:${port}/help`);
});

// --- Game States ---
let activeGames = {
  tictactoe: {}, // {groupId: {board: [], currentPlayer: 'X', gameStarted: false}}
  quiz: {}, // {groupId: {question: '', answer: '', asked: false}}
  eightball: {} // {groupId: {lastQuestion: '', timestamp: 0}}
};

// Quiz questions database
const quizQuestions = [
  {
    question: "Cần bao nhiêu viên kim cương để chế tạo một bộ giáp đầy đủ?",
    answer: "24"
  },
  {
    question: "Creeper sợ nhất loài vật nào?",
    answer: "mèo"
  },
  {
    question: "Nether Portal cần tối thiểu bao nhiêu khối Obsidian?",
    answer: "10"
  },
  {
    question: "Zombie có sợ ánh sáng mặt trời không?",
    answer: "có"
  },
  {
    question: "Đêm trong Minecraft kéo dài bao nhiêu phút thực?",
    answer: "7"
  },
  {
    question: "Cần bao nhiêu sắt để chế tạo một cái xô?",
    answer: "3"
  },
  {
    question: "Loại gỗ nào không tồn tại trong Minecraft?",
    answer: "maple"
  },
  {
    question: "Enchantment nào dùng để thở dưới nước?",
    answer: "aqua affinity"
  }
];

// --- Configuration ---
// **QUAN TRỌNG:** Đảm bảo các biến môi trường này được bảo mật!
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROUP_ID = process.env.GROUP_ID;
const FB_COOKIES_STRING = process.env.COOKIES; // Giữ dạng string trước
const MY_USER_ID = process.env.MY_USER_ID; // Lấy từ giá trị c_user trong cookie
const HISTORY_FILE = "conversation_history.json";
const MAX_HISTORY_LENGTH = 50; // Số lượng tin nhắn tối đa lưu trữ

// Thêm biến cho file lưu trữ dữ liệu người dùng
const USER_DATA_FILE = "user_data.json";

// Khởi tạo Map để lưu dữ liệu người dùng
let userData = new Map();

// Hàm tải dữ liệu người dùng từ file
const loadUserData = async () => {
  try {
    const data = await fs.readFile(USER_DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    userData = new Map(Object.entries(parsed));
    console.log(`📚 Đã tải dữ liệu của ${userData.size} người dùng`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📝 Tạo file dữ liệu người dùng mới');
      await saveUserData();
    } else {
      console.error('❌ Lỗi khi đọc dữ liệu người dùng:', error);
    }
  }
};

// Hàm lưu dữ liệu người dùng vào file
const saveUserData = async () => {
  try {
    const data = Object.fromEntries(userData);
    await fs.writeFile(USER_DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Đã lưu dữ liệu của ${userData.size} người dùng`);
  } catch (error) {
    console.error('❌ Lỗi khi lưu dữ liệu người dùng:', error);
  }
};

// Hàm cập nhật XP cho người dùng
const updateUserXP = async (userId) => {
  if (!userData.has(userId)) {
    userData.set(userId, {
      xp: 0,
      level: 1,
      messages: 0
    });
  }

  const user = userData.get(userId);
  const xpGain = Math.floor(Math.random() * 10) + 1; // 1-10 XP per message
  user.xp += xpGain;
  user.messages += 1;

  // Kiểm tra level up
  const nextLevel = Math.floor(Math.sqrt(user.xp / 100)) + 1;
  if (nextLevel > user.level) {
    user.level = nextLevel;
    await saveUserData();
    return createMessageBox(
      '🎉 LEVEL UP!',
      `Chúc mừng! Bạn đã đạt level ${user.level}!
XP hiện tại: ${user.xp}
Tin nhắn: ${user.messages}`,
      '💪 Tiếp tục cố gắng nhé!'
    );
  }

  await saveUserData();
  return null;
};

// --- Input Validation ---
if (!OPENROUTER_API_KEY || !GROUP_ID || !FB_COOKIES_STRING || !MY_USER_ID) {
  console.error(
    "❌ Lỗi: Vui lòng kiểm tra các biến môi trường OPENROUTER_API_KEY, GROUP_ID, COOKIES, MY_USER_ID trong file .env"
  );
  process.exit(1); // Thoát nếu thiếu config
}

let FB_COOKIES;
try {
  FB_COOKIES = JSON.parse(FB_COOKIES_STRING);
  if (!Array.isArray(FB_COOKIES)) throw new Error("Cookies không phải là một mảng JSON hợp lệ.");
} catch (error) {
  console.error("❌ Lỗi phân tích COOKIES JSON:", error.message);
  process.exit(1);
}

// --- Constants ---
const FACEBOOK_URL = "https://www.facebook.com";
const MESSAGES_URL = `${FACEBOOK_URL}/messages/t/${GROUP_ID}`;

// *** SELECTORS ĐÃ CẬP NHẬT (Dựa trên HTML bạn cung cấp) ***
// **CẢNH BÁO:** Các selector này VẪN có thể thay đổi bất cứ lúc nào!
const MESSAGE_LIST_SELECTOR = 'div[role="log"]'; // Vùng chứa danh sách tin nhắn (thường ổn định hơn)
const MESSAGE_ROW_SELECTOR = 'div[role="gridcell"]'; // Selector cho từng dòng tin nhắn (có thể cần điều chỉnh)
const MESSAGE_TEXT_SELECTOR = 'div[dir="auto"]'; // Selector lấy nội dung text (phức tạp hơn để lấy đúng text)
const INPUT_BOX_SELECTOR = 'div[role="textbox"][contenteditable="true"][aria-label*="Tin nhắn"]'; // Selector ô nhập liệu (nên dùng aria-label cho ổn định)

const CHECK_INTERVAL_MS = 5000; // 5 giây
const TYPE_DELAY_MS = 50; // Delay giữa các lần gõ phím
const SEND_DELAY_MS = 1000; // Delay trước khi gửi tin nhắn

// --- Constants & Config ---
const MAX_CONTEXT_LENGTH = 10;
let conversationHistory = [];

// Cập nhật danh sách emoji đơn giản và chắc chắn hiển thị được
const EMOJI_THEMES = {
  positive: ['😊', '😄', '😁', '😃', '😀'],
  negative: ['😢', '😭', '😞', '😔', '😕'],
  funny: ['😂', '🤣', '😅', '😆', '😝'],
  gaming: ['😎', '👾', '🎮', '🎲', '🎯'],
  thinking: ['🤔', '🙄', '😏', '😌', '🧐'],
  love: ['❤️', '💕', '💗', '💓', '💖'],
  food: ['😋', '🍕', '🍔', '🍟', '🍪'],
  music: ['🎵', '🎶', '🎸', '🎤', '🎼'],
  nature: ['🌸', '🌺', '🌼', '🌻', '🌹'],
  tech: ['💻', '📱', '🔌', '💡', '📶']
};

// Cập nhật hàm chọn emoji
const getContextualEmojis = (text) => {
  text = text.toLowerCase();
  let selectedEmojis = [];

  // Chọn chủ đề dựa trên nội dung
  if (text.match(/(haha|lol|cười|vui|funny|joke)/)) {
    selectedEmojis = EMOJI_THEMES.funny;
  }
  else if (text.match(/(game|chơi|play|minecraft)/)) {
    selectedEmojis = EMOJI_THEMES.gaming;
  }
  else if (text.match(/(love|yêu|thương|crush)/)) {
    selectedEmojis = EMOJI_THEMES.love;
  }
  else if (text.match(/(buồn|khóc|sad|huhu)/)) {
    selectedEmojis = EMOJI_THEMES.negative;
  }
  else {
    selectedEmojis = EMOJI_THEMES.positive;
  }

  // Chỉ chọn 2 emoji ngẫu nhiên
  const result = [];
  for (let i = 0; i < 2; i++) {
    const randomIndex = Math.floor(Math.random() * selectedEmojis.length);
    result.push(selectedEmojis[randomIndex]);
  }
  
  return result.join('');
};

// Hàm đọc lịch sử hội thoại từ file
const loadConversationHistory = async () => {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf8');
    conversationHistory = JSON.parse(data);
    console.log(`📚 Đã tải ${conversationHistory.length} tin nhắn từ lịch sử`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📝 Tạo file lịch sử hội thoại mới');
      await saveConversationHistory();
    } else {
      console.error('❌ Lỗi khi đọc lịch sử:', error);
    }
  }
};

// Hàm lưu lịch sử hội thoại vào file
const saveConversationHistory = async () => {
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
    console.log(`💾 Đã lưu ${conversationHistory.length} tin nhắn vào lịch sử`);
  } catch (error) {
    console.error('❌ Lỗi khi lưu lịch sử:', error);
  }
};

// Thêm tin nhắn vào context và lưu vào file
const addToContext = async (role, content) => {
  const message = { role, content, timestamp: Date.now() };
  conversationHistory.push(message);

  // Giữ context trong giới hạn
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH);
  }

  // Lưu vào file
  await saveConversationHistory();
};

// Hàm lấy context liên quan
const getRelevantContext = (userInput) => {
  // Lọc tin nhắn trong vòng 24h gần nhất
  const last24Hours = Date.now() - (24 * 60 * 60 * 1000);
  return conversationHistory
    .filter(msg => msg.timestamp > last24Hours)
    .slice(-10); // Lấy 10 tin nhắn gần nhất
};

// Hàm làm sạch text từ messenger
const cleanMessengerText = (text) => {
  if (!text) return '';
  try {
    // Decode HTML entities nếu có
    text = text.replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x2F;/g, '/');

    // Chuẩn hóa unicode
    text = text.normalize('NFKC');

    // Loại bỏ các ký tự đặc biệt nhưng giữ lại unicode tiếng Việt
    text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, ' ')
      .trim();

    // Loại bỏ khoảng trắng thừa
    text = text.replace(/\s+/g, ' ');

    return text;
  } catch (error) {
    console.error('❌ Lỗi khi làm sạch text:', error);
    return text;
  }
};

// Kiểm tra tin nhắn có hợp lệ không
const isValidMessage = (text) => {
  if (!text) return false;
  const cleanedText = cleanMessengerText(text);
  // Kiểm tra độ dài tối thiểu và có ký tự hợp lệ
  return cleanedText.length >= 2 && /[\p{L}]/u.test(cleanedText);
};

// Cập nhật hàm format tin nhắn
const formatMessage = (text) => {
  // Nếu text chứa URL, trả về nguyên bản không thêm zero-width space
  if (text.includes('http://') || text.includes('https://')) {
    return text;
  }
  // Thêm zero-width space sau mỗi ký tự đặc biệt cho text không chứa URL
  return text.replace(/([!@#$%^&*(),.?":{}|<>])/g, '$1\u200B');
};

// --- Helper Functions ---
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🧠 Gọi AI qua OpenRouter API
const callAI = async (userInput) => {
  console.log("✉️ Gửi AI:", userInput);
  const MODEL_NAME = "google/gemini-pro";
  const API_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

  try {
    const relevantContext = getRelevantContext(userInput);
    await addToContext("user", userInput);

    const systemPrompt = {
      role: "system",
      content: `Bạn là một bot chat thông minh và hài hước trong nhóm chat messenger. Hãy:
- Trả lời ngắn gọn trong 1-2 câu
- Sử dụng ngôn ngữ GenZ đơn giản và dễ hiểu
- Tập trung vào trọng tâm câu hỏi
- Chỉ dùng emoji cơ bản và phổ biến
- Giữ giọng điệu vui vẻ và thân thiện
- Có thể đùa nhẹ nhàng khi phù hợp
- Tránh lan man và dài dòng
- LUÔN trả lời bằng Tiếng Việt có dấu`
    };

    const res = await axios.post(
      API_ENDPOINT,
      {
        model: MODEL_NAME,
        messages: [
          systemPrompt,
          ...relevantContext,
          { role: "user", content: userInput }
        ],
        max_tokens: 150,
        temperature: 0.9,
        presence_penalty: 0.8,
        frequency_penalty: 0.8,
        stream: false
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com",
          "X-Title": "FB Messenger Bot"
        },
        timeout: 30000,
      }
    );

    let text = res.data.choices?.[0]?.message?.content;
    if (!text) {
      text = res.data.choices?.[0]?.text;
    }

    if (text && isValidMessage(text)) {
      text = cleanMessengerText(text);
      await addToContext("assistant", text);

      // Thêm emoji đơn giản
      const contextualEmojis = getContextualEmojis(text + " " + userInput);
      text = `${contextualEmojis} ${text}`;

      console.log(`🤖 AI trả lời:`, text);
      return text;
    } else {
      console.warn(`⚠️ AI trả về nội dung không hợp lệ:`, text);
      throw new Error("Invalid response from AI");
    }
  } catch (err) {
    console.error("DEBUG: Full error:", err);
    const errorMessage = err?.response?.data?.error?.message || err?.response?.data || err.message;
    const errorStatus = err?.response?.status;
    console.error(`❌ OpenRouter Error (Status: ${errorStatus}):`, errorMessage);

    // Xóa tin nhắn lỗi khỏi context
    conversationHistory.pop();

    if (errorStatus === 401) return "😢 Ui, API key không đúng rồi!";
    if (errorStatus === 402) return "😅 Hết tiền rồi, nạp thêm credits đi bạn ơi!";
    if (errorStatus === 429) return "🥵 Nghỉ xíu nha, mình đang hơi quá tải!";
    if (errorStatus === 500 || errorStatus === 503) return `😴 Server đang ngủ, lát nữa thử lại nha!`;
    return `🤔 Oops, có gì đó sai sai. Thử lại nha!`;
  }
};

// 💬 Gửi tin nhắn trong chat
const sendMessage = async (page, message) => {
  try {
    if (!isValidMessage(message)) {
      console.warn("⚠️ Tin nhắn không hợp lệ, bỏ qua");
      return false;
    }

    message = cleanMessengerText(message);
    if (message.length < 2) {
      console.warn("⚠️ Tin nhắn quá ngắn sau khi làm sạch, bỏ qua");
      return false;
    }

    // Format tin nhắn trước khi thêm prefix
    message = formatMessage(message);
    
    // Thêm định dạng font chữ
    message = `${message}`;

    const MAX_LENGTH = 500;
    const messageParts = [];
    for (let i = 0; i < message.length; i += MAX_LENGTH) {
      messageParts.push(message.substring(i, i + MAX_LENGTH));
    }

    for (const part of messageParts) {
      await page.waitForSelector(INPUT_BOX_SELECTOR, { timeout: 10000 });
      await page.click(INPUT_BOX_SELECTOR);
      await delay(200);

      // Sử dụng contentEditable để giữ nguyên format
      await page.evaluate((text) => {
        const el = document.querySelector('div[role="textbox"]');
        if (el) {
          el.innerHTML = '';
          el.focus();
          // Sử dụng execCommand để paste text với format
          document.execCommand('insertText', false, text);
        }
      }, part);

      await delay(SEND_DELAY_MS);
      await page.keyboard.press("Enter");
      console.log("✅ Đã gửi tin nhắn:", part);
      await delay(1500);
    }
    return true;
  } catch (error) {
    console.error(`❌ Lỗi khi gửi tin nhắn:`, error.message);
    try {
      await page.screenshot({ path: `error_send_message_${Date.now()}.png` });
    } catch (screenshotError) {
      console.error("❌ Không thể chụp ảnh màn hình:", screenshotError.message);
    }
    return false;
  }
};

// --- Main Logic ---
(async () => {
  let browser = null;
  try {
    // Tải lịch sử hội thoại khi khởi động
    await loadConversationHistory();

    console.log("🚀 Khởi động trình duyệt...");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-notifications",
        "--mute-audio",
        '--disable-gpu',
        '--window-size=1280,800',
        '--disable-dev-shm-usage',
        '--single-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      userDataDir: './browser_data'
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log("🔑 Đang đặt cookies...");
    await page.setCookie(...FB_COOKIES);

    console.log(`🌐 Đang truy cập ${FACEBOOK_URL}...`);
    await page.goto(FACEBOOK_URL, { waitUntil: "networkidle2", timeout: 60000 });

    if (page.url().includes("/login") || await page.$('form#login_form') || await page.$('[data-testid="royal_login_button"]')) {
      console.error("🔒 Đăng nhập thất bại! Cookie sai, hết hạn hoặc cần xác thực 2 yếu tố.");
      await page.screenshot({ path: 'error_login_page.png' }); // Chụp ảnh màn hình trang login
      console.log("📸 Đã chụp ảnh màn hình lỗi đăng nhập.");
      await browser.close();
      return;
    }
    console.log("✅ Đăng nhập thành công!");

    console.log(`💬 Đang truy cập nhóm chat ${GROUP_ID}...`);
    await page.goto(MESSAGES_URL, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      // Chờ cả ô nhập liệu và danh sách tin nhắn xuất hiện
      await Promise.all([
        page.waitForSelector(INPUT_BOX_SELECTOR, { timeout: 30000 }),
        page.waitForSelector(MESSAGE_ROW_SELECTOR, { timeout: 30000 }) // Chờ cả dòng tin nhắn đầu tiên
      ]);
      console.log("🤖 Đã vào nhóm chat. Bắt đầu theo dõi tin nhắn...");
    } catch (error) {
      console.error(`❌ Không tìm thấy thành phần cần thiết trong nhóm chat (${INPUT_BOX_SELECTOR} hoặc ${MESSAGE_ROW_SELECTOR}). Kiểm tra lại GROUP_ID hoặc selectors.`);
      await page.screenshot({ path: `error_group_load_${Date.now()}.png` });
      console.log("📸 Đã chụp ảnh màn hình lỗi tải nhóm chat.");
      await browser.close();
      return;
    }

    let lastProcessedMessageId = null;
    let lastSentMessageText = "";

    const messageProcessingInterval = setInterval(async () => {
      try {
        console.log("DEBUG: Interval tick - Checking for messages...");

        const messagesData = await page.evaluate((rowSelector, textSelector) => {
          const messageRows = Array.from(document.querySelectorAll(rowSelector)).slice(-10);
          return messageRows.map(row => {
            const textElements = Array.from(row.querySelectorAll(textSelector));
            // Lấy text từ element cuối cùng và làm sạch
            let text = textElements[textElements.length - 1]?.innerText || '';

            // Tạo ID duy nhất cho tin nhắn
            const timestamp = Date.now();
            const randomId = Math.random().toString(36).substring(7);
            const messageId = `msg_${timestamp}_${randomId}`;

            return {
              id: messageId,
              text: text.trim(),
              timestamp: timestamp
            };
          }).filter(msg => msg.text);
        }, MESSAGE_ROW_SELECTOR, MESSAGE_TEXT_SELECTOR);

        console.log("DEBUG: Fetched messagesData count:", messagesData.length);
        if (messagesData.length > 0) {
          console.log("DEBUG: Last message data:", messagesData[messagesData.length - 1]);
        }

        if (!messagesData.length) return;

        const lastMessage = messagesData[messagesData.length - 1];
        const cleanedText = cleanMessengerText(lastMessage.text);

        console.log("DEBUG: lastMessage.id:", lastMessage.id);
        console.log("DEBUG: lastProcessedMessageId:", lastProcessedMessageId);
        console.log("DEBUG: Cleaned message text:", cleanedText);
        console.log("DEBUG: lastSentMessageText:", lastSentMessageText ? lastSentMessageText.substring(0, 50) + "..." : "null");

        // Kiểm tra và xử lý tin nhắn
        if (lastMessage.id === lastProcessedMessageId ||
          cleanedText === lastSentMessageText ||
          !isValidMessage(cleanedText)) {
          console.log("DEBUG: Skipping - Message already processed or invalid");
          return;
        }

        // Xử lý lệnh
        if (cleanedText.startsWith("!")) {
          console.log(`📬 Nhận được lệnh: ${cleanedText}`);
          const command = cleanedText.toLowerCase();

          let reply = "";
          if (command === "!help") {
            reply = handleHelp();
          } else if (command === "!tictactoe") {
            reply = handleTicTacToe(GROUP_ID, null, lastMessage.id.split("_")[2]);
          } else if (command.startsWith("!tictactoe ")) {
            const position = cleanedText.slice(10).trim();
            reply = handleTicTacToe(GROUP_ID, position, lastMessage.id.split("_")[2]);
          } else if (command === "!quiz") {
            reply = handleQuiz(GROUP_ID);
          } else if (command === "!roll") {
            reply = handleRoll();
          } else if (command.startsWith("!8ball ")) {
            const question = cleanedText.slice(7).trim();
            reply = handle8Ball(question);
          } else if (command === "!info") {
            reply = handleInfo();
          } else if (command === "!rule") {
            reply = handleRule();
          } else if (command === "!rank") {
            reply = handleRank(lastMessage.id.split("_")[2]);
          } else if (command === "!top") {
            reply = handleTop();
          } else if (command.startsWith("!play ")) {
            const url = cleanedText.slice(6).trim();
            try {
              reply = await handleMusic(GROUP_ID, url);
            } catch (err) {
              reply = createMessageBox('❌ LỖI', 'Lỗi khi xử lý bài hát!');
            }
          } else if (command.startsWith("!lyrics ")) {
            const song = cleanedText.slice(8).trim();
            reply = await searchLyrics(song);
          } else if (command === "!sticker") {
            if (lastMessage.attachments && lastMessage.attachments.length > 0) {
              reply = await createSticker(lastMessage.attachments[0].url);
            } else {
              reply = createMessageBox('❌ LỖI', 'Vui lòng gửi kèm một ảnh!');
            }
          } else if (command.startsWith("!qr ")) {
            const text = cleanedText.slice(4).trim();
            reply = await handleQR(text);
          } else if (command.startsWith("!mcskin ")) {
            const username = cleanedText.slice(8).trim();
            reply = handleMCSkin(username);
          } else if (command.startsWith("!mcmob ")) {
            const mobName = cleanedText.slice(7).trim();
            reply = handleMCMob(mobName);
          } else if (command.startsWith("!mcblock ")) {
            const blockName = cleanedText.slice(9).trim();
            reply = handleMCBlock(blockName);
          } else if (command === "!mcmeme") {
            reply = handleMCMeme();
          } else if (command === "!mcmusic") {
            reply = handleMCMusic();
          } else {
            const question = cleanedText.slice(1).trim();
            if (question.length < 2) {
              console.log("⚠️ Câu hỏi quá ngắn, bỏ qua.");
              lastProcessedMessageId = lastMessage.id;
              return;
            }

            console.log("DEBUG: Sending question to AI:", question);
            reply = await callAI(question);
          }

          if (reply) {
            const success = await sendMessage(page, reply);
            if (success) {
              lastSentMessageText = reply;
              lastProcessedMessageId = lastMessage.id;
            }
          }
        }

        // Cập nhật XP cho người dùng
        const userId = lastMessage.id.split("_")[2];
        if (userId && !userData.has(userId)) {
          userData.set(userId, {
            xp: 0,
            level: 1,
            messages: 0
          });
          await saveUserData();
        }

      } catch (e) {
        console.error("❌ Lỗi trong vòng lặp theo dõi:", e);
        // Kiểm tra trạng thái trang
        try {
          if (!browser || !browser.isConnected()) {
            console.error("☠️ Trình duyệt đã mất kết nối! Dừng bot.");
            clearInterval(messageProcessingInterval);
            process.exit(1);
          }
          const currentUrl = page.url();
          if (currentUrl.includes("/login") || await page.$('form#login_form')) {
            console.error("☠️ Bị đăng xuất giữa chừng! Dừng bot.");
            await page.screenshot({ path: `error_logged_out_${Date.now()}.png` });
            console.log("📸 Đã chụp ảnh màn hình bị đăng xuất.");
            clearInterval(messageProcessingInterval);
            if (browser) await browser.close();
            process.exit(1);
          }
          if (!await page.$(INPUT_BOX_SELECTOR)) {
            console.error("☠️ Không tìm thấy ô nhập liệu nữa! Trang có thể đã bị lỗi. Thử reload...");
            await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
            await Promise.all([
              page.waitForSelector(INPUT_BOX_SELECTOR, { timeout: 30000 }),
              page.waitForSelector(MESSAGE_ROW_SELECTOR, { timeout: 30000 })
            ]);
            console.log("🔄 Đã reload trang và tìm thấy lại các thành phần.");
          }

        } catch (checkError) {
          console.error("❌ Lỗi nghiêm trọng khi kiểm tra trạng thái page hoặc reload:", checkError.message);
          clearInterval(messageProcessingInterval);
          if (browser) {
            await browser.close();
          }
          process.exit(1);
        }
      }
    }, CHECK_INTERVAL_MS);

    console.log("✨ Bot đang chạy. Nhấn Ctrl+C để dừng.");
    await new Promise(() => { });

  } catch (error) {
    console.error("❌ Lỗi khởi động:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
})();

// Xử lý khi nhấn Ctrl+C
process.on('SIGINT', async () => {
  console.log("\n🛑 Nhận được tín hiệu dừng (Ctrl+C). Đang đóng trình duyệt...");
  console.log("👋 Tạm biệt!");
  process.exit(0);
});

// Khởi tạo các biến cho chức năng mới
let musicQueue = new Map();
let userLevels = new Map();
let gameStates = new Map();

// Hàm lấy thời tiết
const getWeather = (city) => {
  return new Promise((resolve, reject) => {
    weather.find({ search: city, degreeType: 'C' }, (err, result) => {
      if (err) reject(err);
      resolve(result);
    });
  });
};

// Hàm tạo QR code
const generateQR = async (text) => {
  try {
    return await QRCode.toDataURL(text);
  } catch (err) {
    console.error('Lỗi tạo QR:', err);
    return null;
  }
};

// Hàm tìm kiếm Wikipedia
const searchWiki = async (query, lang = 'vi') => {
  try {
    const response = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
    const data = await response.json();
    return data.extract;
  } catch (err) {
    console.error('Lỗi tìm Wikipedia:', err);
    return null;
  }
};

// Hàm tạo khung tin nhắn đẹp
const createMessageBox = (title, content, footer = '') => {
  const width = 35;
  const line = '═'.repeat(width);
  const space = ' '.repeat(width);
  
  let box = `╔${line}╗\n`;
  box += `║${space}║\n`;
  
  // Title
  const paddedTitle = title.padStart((width + title.length) / 2).padEnd(width);
  box += `║${paddedTitle}║\n`;
  box += `║${space}║\n`;
  
  // Content
  const lines = content.split('\n');
  for (const line of lines) {
    const paddedLine = line.padEnd(width);
    box += `║${paddedLine}║\n`;
  }
  
  // Footer
  if (footer) {
    box += `║${space}║\n`;
    const paddedFooter = footer.padStart((width + footer.length) / 2).padEnd(width);
    box += `║${paddedFooter}║\n`;
  }
  
  box += `║${space}║\n`;
  box += `╚${line}╝`;
  
  return box;
};

// Hàm tạo bảng xếp hạng đẹp
const createLeaderboard = (title, entries) => {
  const width = 35;
  const line = '─'.repeat(width - 2);
  
  let board = `┌${line}┐\n`;
  board += `│ ${title.padEnd(width - 3)}│\n`;
  board += `├${line}┤\n`;
  
  for (const [index, entry] of entries.entries()) {
    const rank = `${index + 1}`.padStart(2);
    const text = entry.padEnd(width - 6);
    board += `│ ${rank}. ${text}│\n`;
  }
  
  board += `└${line}┘`;
  
  return board;
};

// Hàm tạo menu trợ giúp
const createHelpMenu = () => {
  return createMessageBox(
    '🎮 MINECRAFT BOT COMMANDS',
    `Game Commands:
!mcskin [tên] - Xem skin
!mcmob [tên] - Xem mob
!mcblock [tên] - Xem block
!mcmeme - Xem meme
!mcmusic - Nghe nhạc
!tictactoe - Chơi cờ caro
!quiz - Câu đố Minecraft
!roll - Tung xúc xắc
!8ball - Bói toán vui

Nhóm Commands:
!info - Thông tin nhóm
!rule - Nội quy nhóm
!rank - Xem cấp độ
!top - Bảng xếp hạng

Tiện ích:
!play [url] - Thông tin nhạc
!lyrics [tên] - Lời bài hát
!sticker - Tạo sticker
!qr [text] - Tạo mã QR`,
    '💡 Gõ lệnh để bắt đầu!'
  );
};

// Hàm tạo bảng cờ caro đẹp
const renderBoard = (board) => {
  const symbols = {
    X: '❌',
    O: '⭕',
    null: '  '
  };
  
  let result = '```\n';
  result += '┌───┬───┬───┐\n';
  for (let i = 0; i < 9; i += 3) {
    result += `│ ${symbols[board[i]] || ' '} │ ${symbols[board[i+1]] || ' '} │ ${symbols[board[i+2]] || ' '} │\n`;
    if (i < 6) result += '├───┼───┼───┤\n';
  }
  result += '└───┴───┴───┘\n';
  result += '```';
  return result;
};

// Cập nhật hàm xử lý phát nhạc với giao diện đẹp
const handleMusic = async (groupId, url) => {
  try {
    const info = await ytdl.getInfo(url);
    const duration = `${Math.floor(info.videoDetails.lengthSeconds / 60)}:${(info.videoDetails.lengthSeconds % 60).toString().padStart(2, '0')}`;
    
    return createMessageBox(
      '🎵 THÔNG TIN BÀI HÁT',
      `Tên: ${info.videoDetails.title}
Kênh: ${info.videoDetails.author.name}
Thời lượng: ${duration}
Lượt xem: ${info.videoDetails.viewCount.toLocaleString()}

${info.videoDetails.description.slice(0, 100)}...`,
      `🔗 ${url}`
    );
  } catch (error) {
    console.error("Lỗi xử lý nhạc:", error);
    return createMessageBox('❌ LỖI', 'Không thể lấy thông tin bài hát này!');
  }
};

// Cập nhật hàm xử lý lyrics với giao diện đẹp
const searchLyrics = async (query) => {
  try {
    const searches = await genius.songs.search(query);
    if (searches.length > 0) {
      const song = searches[0];
      return createMessageBox(
        '🎵 THÔNG TIN BÀI HÁT',
        `Tên: ${song.title}
Ca sĩ: ${song.artist}
Album: ${song.album || 'N/A'}`,
        `🔗 ${song.url}`
      );
    }
    return createMessageBox('❌ KHÔNG TÌM THẤY', 'Không tìm thấy thông tin bài hát!');
  } catch (err) {
    console.error('Lỗi tìm lời bài hát:', err);
    return createMessageBox('❌ LỖI', 'Đã xảy ra lỗi khi tìm kiếm!');
  }
};

// Cập nhật hàm xử lý rank với giao diện đẹp
const handleRank = (userId) => {
  if (!userData.has(userId)) {
    return createMessageBox(
      '📊 THÔNG TIN CẤP ĐỘ',
      'Bạn chưa có cấp độ nào!\nHãy tích cực tham gia trò chuyện!',
      '💡 Gửi tin nhắn để nhận XP'
    );
  }

  const user = userData.get(userId);
  const nextLevelXP = (user.level + 1) * (user.level + 1) * 100;
  
  return createMessageBox(
    '📊 THÔNG TIN CẤP ĐỘ',
    `Cấp độ: ${user.level}
Kinh nghiệm: ${user.xp}/${nextLevelXP}
Tin nhắn: ${user.messages}

Cần thêm ${nextLevelXP - user.xp} XP để lên cấp!`,
    '💪 Cố lên nào!'
  );
};

// Cập nhật hàm xử lý top với giao diện đẹp
const handleTop = () => {
  const sortedUsers = Array.from(userData.entries())
    .sort(([, a], [, b]) => b.xp - a.xp)
    .slice(0, 5)
    .map(([userId, user], index) => {
      const crown = index === 0 ? '👑' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🎮';
      return `${crown} Lv.${user.level} - ${user.xp}XP - ${user.messages} tin`;
    });

  if (sortedUsers.length === 0) {
    return createMessageBox(
      '🏆 BẢNG XẾP HẠNG',
      'Chưa có ai trong bảng xếp hạng!\nHãy là người đầu tiên nhé!',
      '💡 Gửi tin nhắn để góp mặt'
    );
  }

  return createLeaderboard('🏆 BẢNG XẾP HẠNG', sortedUsers);
};

// Cập nhật hàm xử lý game TicTacToe
const handleTicTacToe = (groupId, position, userId) => {
  if (!gameStates.has(groupId)) {
    gameStates.set(groupId, {
      board: Array(9).fill(null),
      currentPlayer: "X",
      players: { X: userId }
    });
    return createMessageBox(
      '🎮 CỜ CARO',
      `Người chơi 1: ❌
Đang chờ người chơi 2...

${renderBoard(Array(9).fill(null))}

Cách chơi: Gõ !tictactoe [1-9]`,
      '💡 Người chơi khác tham gia bằng cách đánh một nước đi'
    );
  }

  const game = gameStates.get(groupId);
  
  if (game.players.O && game.players[game.currentPlayer] !== userId) {
    return createMessageBox('❌ KHÔNG HỢP LỆ', 'Không phải lượt của bạn!');
  }

  if (!game.players.O && userId !== game.players.X) {
    game.players.O = userId;
  }

  position = parseInt(position) - 1;
  if (position < 0 || position > 8 || game.board[position]) {
    return createMessageBox('❌ KHÔNG HỢP LỆ', 'Vị trí không hợp lệ!');
  }

  game.board[position] = game.currentPlayer;
  const winner = checkWinner(game.board);
  
  if (winner) {
    const result = createMessageBox(
      '🎮 KẾT THÚC',
      `Người chơi ${winner} đã thắng!

${renderBoard(game.board)}`,
      '🎉 Chúc mừng!'
    );
    gameStates.delete(groupId);
    return result;
  }

  if (game.board.every(cell => cell !== null)) {
    const result = createMessageBox(
      '🎮 KẾT THÚC',
      `Hòa!

${renderBoard(game.board)}`,
      '🤝 Trận đấu hay!'
    );
    gameStates.delete(groupId);
    return result;
  }

  game.currentPlayer = game.currentPlayer === "X" ? "O" : "X";
  return createMessageBox(
    '🎮 CỜ CARO',
    `Lượt của: ${game.currentPlayer === 'X' ? '❌' : '⭕'}

${renderBoard(game.board)}`,
    '💭 Đang suy nghĩ...'
  );
};

// Hàm kiểm tra người thắng TicTacToe
const checkWinner = (board) => {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Ngang
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Dọc
    [0, 4, 8], [2, 4, 6] // Chéo
  ];

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
};

// Cập nhật hàm dịch văn bản
const translateText = async (text, targetLang = 'vi') => {
  try {
    const [translation] = await translateClient.translate(text, targetLang);
    return translation;
  } catch (err) {
    console.error('Lỗi dịch văn bản:', err);
    return null;
  }
};

// Cập nhật hàm xử lý sticker
const createSticker = async (imageUrl) => {
  try {
    const result = await cloudinary.uploader.upload(imageUrl, {
      transformation: [
        { width: 512, height: 512, crop: "fill" },
        { format: "webp" }
      ]
    });
    return createMessageBox(
      '🎨 STICKER',
      'Sticker của bạn đã sẵn sàng!',
      `🔗 ${result.secure_url}`
    );
  } catch (error) {
    console.error("Lỗi tạo sticker:", error);
    return createMessageBox('❌ LỖI', 'Không thể tạo sticker từ ảnh này!');
  }
};

// Cập nhật hàm xử lý QR
const handleQR = async (text) => {
  try {
    const qrUrl = await QRCode.toDataURL(text);
    return createMessageBox(
      '📱 MÃ QR',
      'Mã QR của bạn đã sẵn sàng!',
      `🔗 ${qrUrl}`
    );
  } catch (err) {
    console.error('Lỗi tạo QR:', err);
    return createMessageBox('❌ LỖI', 'Không thể tạo mã QR!');
  }
};

// Cập nhật hàm xử lý info
const handleInfo = () => {
  return createMessageBox(
    '🏰 MINECRAFT COMMUNITY',
    `Chào mừng đến với cộng đồng Minecraft!

• Chia sẻ kiến thức
• Giao lưu kết bạn
• Cùng nhau phát triển

Tham gia ngay để có những trải nghiệm tuyệt vời!`,
    '💫 Together we build, together we grow!'
  );
};

// Cập nhật hàm xử lý rule
const handleRule = () => {
  return createMessageBox(
    '📜 NỘI QUY NHÓM',
    `1. Tôn trọng mọi người
2. Không spam, quảng cáo
3. Không share nội dung 18+
4. Không chửi thề, toxic
5. Hạn chế viết tắt
6. Dùng tiếng Việt có dấu
7. Giúp đỡ thành viên mới

Vi phạm = Cảnh cáo/Kick`,
    '🤝 Vì một cộng đồng văn minh!'
  );
};

// Cập nhật hàm xử lý lệnh quiz
const handleQuiz = (groupId) => {
  if (!activeGames.quiz[groupId]) {
    const randomQuestion = quizQuestions[Math.floor(Math.random() * quizQuestions.length)];
    activeGames.quiz[groupId] = {
      question: randomQuestion.question,
      answer: randomQuestion.answer.toLowerCase(),
      asked: false
    };
    
    return createMessageBox(
      '❓ CÂU ĐỐ MINECRAFT',
      `Câu hỏi: ${randomQuestion.question}\n\nGõ câu trả lời của bạn!`,
      '💡 Bạn có 30 giây để trả lời!'
    );
  } else {
    return createMessageBox(
      '⚠️ LỖI',
      'Đang có một câu đố đang diễn ra!\nVui lòng đợi câu đố kết thúc.',
      '⏳ Hãy kiên nhẫn!'
    );
  }
};

// Cập nhật hàm xử lý lệnh roll
const handleRoll = () => {
  const roll = Math.floor(Math.random() * 6) + 1;
  const emoji = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][roll - 1];
  
  return createMessageBox(
    '🎲 TUNG XÚC XẮC',
    `Kết quả: ${emoji} ${roll}`,
    '🎯 Chúc may mắn lần sau!'
  );
};

// Cập nhật hàm xử lý lệnh 8ball
const handle8Ball = (question) => {
  const responses = [
    'Chắc chắn rồi!',
    'Không thể nghi ngờ!',
    'Có thể là như vậy.',
    'Tốt hơn là không nói.',
    'Không thể đoán trước.',
    'Hãy hỏi lại sau.',
    'Tốt nhất là không.',
    'Rất nghi ngờ.',
    'Không có cơ hội.',
    'Có thể là không.'
  ];
  
  const response = responses[Math.floor(Math.random() * responses.length)];
  const emoji = ['✨', '🌟', '💫', '⭐', '🌠'][Math.floor(Math.random() * 5)];
  
  return createMessageBox(
    '🎱 8 BALL',
    `Câu hỏi: ${question}\n\nTrả lời: ${emoji} ${response}`,
    '🔮 Hãy tin vào số phận!'
  );
};

// Cập nhật hàm xử lý lệnh mcskin
const handleMCSkin = (username) => {
  return createMessageBox(
    '🎮 MINECRAFT SKIN',
    `Skin của người chơi: ${username}`,
    `🔗 https://mc-heads.net/skin/${encodeURIComponent(username)}`
  );
};

// Cập nhật hàm xử lý lệnh mcmob
const handleMCMob = (mobName) => {
  return createMessageBox(
    '👾 MINECRAFT MOB',
    `Thông tin về mob: ${mobName}`,
    `🔗 https://minecraft.wiki/images/${encodeURIComponent(mobName)}.png`
  );
};

// Cập nhật hàm xử lý lệnh mcblock
const handleMCBlock = (blockName) => {
  return createMessageBox(
    '🧱 MINECRAFT BLOCK',
    `Thông tin về block: ${blockName}`,
    `🔗 https://minecraft.wiki/images/${encodeURIComponent(blockName)}.png`
  );
};

// Cập nhật hàm xử lý lệnh mcmeme
const handleMCMeme = () => {
  const memes = [
    "https://i.redd.it/creepers-are-just-green-tnt-with-legs-v0-5v9y3j9p3z4a1.jpg",
    "https://i.redd.it/when-you-find-diamonds-but-hear-a-creeper-v0-5v9y3j9p3z4a1.jpg",
    "https://i.redd.it/minecraft-memes-v0-5v9y3j9p3z4a1.jpg",
    "https://i.redd.it/minecraft-memes-2023-v0-5v9y3j9p3z4a1.jpg"
  ];
  const randomMeme = memes[Math.floor(Math.random() * memes.length)];
  
  return createMessageBox(
    '😂 MINECRAFT MEME',
    'Meme ngẫu nhiên cho bạn!',
    `🔗 ${randomMeme}`
  );
};

// Cập nhật hàm xử lý lệnh mcmusic
const handleMCMusic = () => {
  const songs = [
    { name: "Sweden - C418", url: "https://www.youtube.com/watch?v=_3ngiSxVCBs" },
    { name: "Wet Hands - C418", url: "https://www.youtube.com/watch?v=mukiMaOSLEs" },
    { name: "Living Mice - C418", url: "https://www.youtube.com/watch?v=oGxQNQtnr6Q" },
    { name: "Mice on Venus - C418", url: "https://www.youtube.com/watch?v=DZ47H84Bc_Q" }
  ];
  const randomSong = songs[Math.floor(Math.random() * songs.length)];
  
  return createMessageBox(
    '🎵 MINECRAFT MUSIC',
    `Bài hát: ${randomSong.name}
Nhạc sĩ: C418

Thưởng thức âm nhạc tuyệt vời của Minecraft!`,
    `🔗 ${randomSong.url}`
  );
};

// Cập nhật hàm xử lý lệnh help
const handleHelp = () => {
  return '🔗 Xem danh sách lệnh tại: https://botchathelp.netlify.app';
};