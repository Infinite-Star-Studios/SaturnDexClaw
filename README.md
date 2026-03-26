# SaturnDexClaw

Claude-powered AI trading agent for [SaturnX.cc](https://saturnx.cc) DEX on Phantasma blockchain.

## Features

- **Claude AI Agent** — Uses Claude to analyze market data and make trade/hold decisions
- **Visual Dashboard** — Web UI for setup, trading, and monitoring
- **Scheduled Jobs** — Automate trades on intervals (seconds → months)
- **Quick Trade** — Manual swap with quote preview
- **Safety Guards** — Built-in price impact, fee, and balance validation via SDK

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Setup

1. Enter your **Claude API key** (`sk-ant-...`)
2. Optionally paste a **WIF private key** (or generate a new wallet)
3. Select **Devnet** (testnet) or **Mainnet**
4. Click **Connect**

## Scheduling

Add agent jobs that run on a timer. The AI agent will:
1. Fetch your portfolio and current market quote
2. Ask Claude whether to TRADE or HOLD
3. Execute the swap if Claude decides to trade

Intervals: seconds, minutes, hours, days, weeks, or months.

## Tech Stack

- [SaturnDexAgentSDK](https://github.com/Infinite-Star-Studios/SaturnDexAgentSDK) — DEX trading
- [Claude API](https://docs.anthropic.com) — AI decision engine
- Express — Lightweight server
- Vanilla HTML/CSS/JS — Zero-dependency frontend
