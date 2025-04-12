# Facebook Messenger Bot

Bot chat thông minh tích hợp AI cho nhóm Minecraft trên Facebook Messenger.

## Tính năng

- Chat với AI thông minh
- Các lệnh game (TicTacToe, Quiz, Roll dice, 8ball)
- Xem thông tin Minecraft (Skin, Mob, Block, Music)
- Hệ thống level và xếp hạng
- Tạo sticker và QR code
- Xem thông tin nhạc từ YouTube
- Quản lý nhóm (Info, Rules)

## Cài đặt

1. Clone repository:
```bash
git clone https://github.com/your-username/fb-bot.git
cd fb-bot
```

2. Cài đặt dependencies:
```bash
npm install
```

3. Tạo file .env và thêm các biến môi trường:
```env
OPENROUTER_API_KEY=your_api_key
GROUP_ID=your_group_id
COOKIES=your_fb_cookies
MY_USER_ID=your_user_id
```

4. Chạy bot:
```bash
npm start
```

## Deploy

Bot có thể được deploy lên Railway.app:

1. Fork repository này
2. Tạo tài khoản Railway.app
3. Tạo project mới từ GitHub repo
4. Thêm các biến môi trường
5. Bot sẽ tự động deploy

## Lưu ý

- Bot cần Facebook cookie để hoạt động
- Đảm bảo cookie và API key được bảo mật
- Không chia sẻ file .env
- Kiểm tra log thường xuyên

## License

MIT License 