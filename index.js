const puppeteer = require("puppeteer");
const axios = require("axios");
require("dotenv").config();

const OPENROUTER_API_KEYS = process.env.API_KEYS.split(",");
let currentKeyIndex = 0;
const BOT_NAME = process.env.BOT_NAME || "Hậu Hậu";
const GROUP_ID = process.env.GROUP_ID;
const MESSAGE_HISTORY = [];
const FB_COOKIES = JSON.parse(process.env.COOKIES);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getGPTReply = async (userInput) => {
  const apiKey = OPENROUTER_API_KEYS[currentKeyIndex];

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openchat/openchat-3.5-0106",
        messages: [
          ...MESSAGE_HISTORY.slice(-5),
          { role: "user", content: userInput },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "http://localhost",
          "Content-Type": "application/json",
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    MESSAGE_HISTORY.push({ role: "user", content: userInput });
    MESSAGE_HISTORY.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    console.error("❌ Lỗi gọi API:", err.message);
    return "😢 Lỗi gọi API hoặc key không hợp lệ.";
  }
};

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process"
    ]
  });

  const page = await browser.newPage();
  await page.setCookie(...FB_COOKIES);
  await page.goto("https://www.facebook.com", { waitUntil: "networkidle2" });

  if (page.url().includes("login")) {
    console.log("🔒 Cookie sai hoặc hết hạn.");
    await browser.close();
    return;
  }

  console.log("✅ Đăng nhập thành công!");

  await page.goto(`https://www.facebook.com/messages/t/${GROUP_ID}`, {
    waitUntil: "networkidle2",
  });

  console.log("⌛ Đang chờ khung nhập tin nhắn...");

  try {
    await page.waitForSelector('[contenteditable="true"]', { timeout: 60000 });
    console.log("📥 Đã tìm thấy khung nhập tin nhắn!");
  } catch (err) {
    console.error("❌ Không tìm thấy khung nhập, bot dừng lại.");
    await browser.close();
    return;
  }

  console.log("🤖 Bot đang theo dõi nhóm chat...");

  let lastProcessedText = "";

  setInterval(async () => {
    try {
      const messages = await page.$$eval(
        'div[role="row"]',
        (rows) =>
          rows.map((row) => row.innerText.trim()).filter(Boolean)
      );

      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || lastMessage === lastProcessedText) return;

      const isCallingBot = lastMessage.toLowerCase().includes(BOT_NAME.toLowerCase());
      const isCommand = lastMessage.trim().startsWith("!");

      if (isCallingBot || isCommand) {
        let prompt = lastMessage;
        if (isCallingBot) {
          prompt = prompt.replace(new RegExp(`@?\\s*${BOT_NAME}\\s*`, "gi"), "").trim();
        }

        const command = prompt.toLowerCase().trim();
        let reply = "";

        if (command === "!help") {
          reply = `🤖 Các lệnh bạn có thể dùng:\n\n• !help – Danh sách lệnh\n• !info – Giới thiệu nhóm\n• !rule – Nội quy nhóm\n• !admin – Gọi admin\n👉 Hoặc gọi "${BOT_NAME} [câu hỏi]" để dùng AI!`;
        } else if (command === "!info") {
          reply = `ℹ️ Nhóm này là nơi chia sẻ kiến thức, thảo luận và chill vui vẻ!\nTham gia nhiệt tình nha bạn!`;
        } else if (command === "!rule") {
          reply = `📜 Nội quy nhóm:\n1. Không spam/ quảng cáo\n2. Tôn trọng người khác\n3. Không vi phạm chính sách Facebook\n4. Giữ vibe vui vẻ hoà đồng 🧃`;
        } else if (command === "!admin") {
          reply = `📞 Ping admin...\nTag: @Admin, vui lòng hỗ trợ!`;
        } else {
          if (prompt.length < 2) {
            console.log("⚠️ Prompt quá ngắn, bỏ qua.");
            lastProcessedText = lastMessage;
            return;
          }

          console.log("✉️ Gửi GPT:", prompt);
          reply = await getGPTReply(prompt);
          console.log("🤖 GPT trả lời:", reply);
        }

        await delay(1000);
        await page.click('[contenteditable="true"]');
        await page.keyboard.type(reply);
        await page.keyboard.press("Enter");
        lastProcessedText = lastMessage;
      }
    } catch (e) {
      console.error("❌ Lỗi ngoài:", e.message);
    }
  }, 5000);
})();
