# Solana Copy Trading Bot

A lightweight, secure copy trading bot for Solana memecoins with Telegram interface. Track alpha wallets and automatically copy their trades with customizable settings.

## 🚀 Features

- **Real-time Copy Trading**: Instantly copy trades from alpha wallets
- **Telegram Interface**: Modern, button-based UI for easy management
- **Helius Integration**: Free tier compatible webhook monitoring
- **Security First**: Encrypted private key storage
- **Customizable Settings**: Slippage, trade amounts, take profit, stop loss
- **Portfolio Tracking**: Monitor your trades and performance
- **Rate Limiting**: Respects API limits for stable operation

## 📋 Prerequisites

- Node.js 16+ 
- Telegram Bot Token
- Helius API Key (Free tier)
- Solana wallet for trading

## ⚡ Quick Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd solana-copytrading-bot
npm install
```

### 2. Environment Configuration

```bash
cp .env.template .env
```

Edit `.env` file:

```env
# Telegram Bot Configuration
BOT_TOKEN=your_telegram_bot_token_here

# Solana Configuration
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com

# Helius API Configuration
HELIUS_API_KEY=your_helius_api_key_here
HELIUS_WEBHOOK_URL=https://api.helius.xyz/v0/webhooks

# Server Configuration
PORT=3000
WEBHOOK_PORT=3001

# Security
WEBHOOK_SECRET=your_random_secret_here

# Rate Limiting
MAX_REQUESTS_PER_MINUTE=100
WEBHOOK_RATE_LIMIT=50
```

### 3. Get Required API Keys

**Telegram Bot Token:**
1. Message @BotFather on Telegram
2. Use `/newbot` command
3. Follow instructions to create your bot
4. Copy the bot token

**Helius API Key:**
1. Visit [Helius.xyz](https://helius.xyz)
2. Sign up for free account
3. Create API key in dashboard
4. Copy the API key

### 4. Run the Bot

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

## 🎯 User Guide

### Getting Started

1. **Start the bot**: Send `/start` to your Telegram bot
2. **Connect wallet**: Click "👛 Connect Wallet" and enter your private key
3. **Add alpha wallets**: Click "🎯 Add Alpha Wallets" and enter addresses to track
4. **Configure settings**: Click "⚙️ Trading Settings" to customize your preferences
5. **Start trading**: The bot will automatically copy trades from your alpha wallets

### Telegram Commands

- `/start` - Initialize the bot
- `/help` - Show help information  
- `/status` - Check bot status

### Trading Settings

| Setting | Description | Range |
|---------|-------------|-------|
| Max Trade Amount | Maximum SOL per trade | 0.01 - 10 SOL |
| Slippage | Price slippage tolerance | 1 - 50% |
| Take Profit | Auto-sell profit target | 10 - 1000% |
| Stop Loss | Auto-sell loss limit | 5 - 50% |
| Auto-Sell | Enable/disable auto-selling | On/Off |

### Alpha Wallet Management

- **Add wallets**: Enter single address or comma-separated list
- **Nicknames**: Use `ADDRESS:nickname` format for easy identification
- **Limit**: Maximum 3 alpha wallets per user
- **Validation**: Automatic wallet address validation

## 🔒 Security Features

- **Encrypted Storage**: Private keys encrypted before storage
- **Secure Communication**: HTTPS webhooks with secret validation
- **Rate Limiting**: Protection against API abuse
- **Graceful Error Handling**: Prevents crashes and data loss

## 📊 Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Telegram Bot  │    │  Webhook Server │    │  Trading Engine │
│   (Grammy)      │◄───┤   (Express)     │◄───┤   (Copy Logic)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   SQLite DB     │    │  Helius Service │    │  Solana Service │
│   (User Data)   │    │   (Webhooks)    │    │   (Blockchain)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🛠️ API Integration

### Helius Webhooks

The bot uses Helius webhooks to monitor alpha wallet transactions:

- **Real-time monitoring**: Instant transaction notifications
- **Enhanced webhooks**: Detailed transaction data
- **Rate limiting**: Respects free tier limits (100 req/min)
- **Automatic parsing**: Extracts swap details from transactions

### Solana Integration

- **RPC calls**: Balance checks, transaction simulation
- **Transaction parsing**: Extracts token swap information  
- **Wallet validation**: Ensures valid Solana addresses
- **Rate limiting**: Prevents RPC overload

## 🔧 Development

### Project Structure

```
src/
├── index.js              # Main application entry
├── telegramBot.js        # Telegram bot with Grammy
├── webhook.js           # Webhook server for Helius
├── database.js          # SQLite database management
└── services/
    ├── solanaService.js # Solana blockchain interactions
    ├── heliusService.js # Helius webhook management
    └── tradingEngine.js # Copy trading logic
```

### Database Schema

- **users**: User accounts and settings
- **alpha_wallets**: Tracked alpha wallet addresses  
- **trades**: Trade history and P&L tracking
- **webhooks**: Webhook management

### Testing Webhooks

Use the test endpoint during development:

```bash
curl -X POST http://localhost:3001/test-webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "webhook data"}'
```

## 📈 Performance Optimization

- **Connection pooling**: Efficient database connections
- **Rate limiting**: Bottleneck library for API calls
- **Caching**: In-memory user session caching
- **Async processing**: Non-blocking webhook processing

## ⚠️ Limitations & Disclaimers

- **Free Tier Limits**: Helius free tier has rate limits
- **Mock Trading**: Some functions use mock implementations for demo
- **Security**: Use dedicated trading wallets with limited funds
- **No Financial Advice**: Educational purposes only

## 🆘 Troubleshooting

### Common Issues

**Bot doesn't respond:**
- Check BOT_TOKEN is correct
- Verify bot is started with `/start` command

**Webhooks not working:**
- Confirm HELIUS_API_KEY is valid
- Check webhook server is running on correct port
- Verify WEBHOOK_SECRET matches

**Trades not executing:**
- Ensure wallet has sufficient SOL balance
- Check slippage settings aren't too restrictive
- Verify alpha wallet addresses are correct

### Debug Mode

Enable debug logging:

```bash
DEBUG=* npm run dev
```

## 📞 Support

For issues and questions:

1. Check the troubleshooting section
2. Review console logs for errors
3. Verify environment configuration
4. Test with small amounts first

## 📄 License

MIT License - see LICENSE file for details

## ⚡ Quick Commands

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Start production
npm start

# Run webhook server only
npm run webhook
```

---

**⚠️ Risk Warning**: Copy trading involves financial risk. Only trade with funds you can afford to lose. This bot is for educational purposes.
