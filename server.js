import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentWallet,
  SaturnAgent,
  DEVNET_CONFIG,
  MAINNET_CONFIG,
} from "saturn-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── In-memory state ──────────────────────────────────────────────────────────
let state = {
  claude: null, // Anthropic client
  wallet: null, // AgentWallet
  agent: null, // SaturnAgent
  network: "devnet",
  apiKey: "",
  wif: "",
  jobs: [], // { id, pair, interval, unit, active, timer, history[] }
  logs: [],
};

function log(msg, level = "info") {
  const entry = { ts: Date.now(), msg, level };
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  console.log(`[${level}] ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function unitToMs(value, unit) {
  const multipliers = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
    weeks: 604_800_000,
    months: 2_592_000_000,
  };
  return value * (multipliers[unit] || 60_000);
}

function buildSystemPrompt(portfolio, tokens, pair, quote) {
  return `You are a trading agent on SaturnX DEX (Phantasma blockchain).

Current portfolio:
${JSON.stringify(portfolio, null, 2)}

Available tokens: ${tokens.map((t) => t.symbol).join(", ")}

Active pair: ${pair[0]} → ${pair[1]}

Current quote for swapping 1 ${pair[0]} → ${pair[1]}:
${JSON.stringify(quote, null, 2)}

Based on this data, decide whether to TRADE or HOLD.
If TRADE, respond with JSON: {"action":"trade","amount":<number>,"reason":"<why>"}
If HOLD, respond with JSON: {"action":"hold","reason":"<why>"}

Respond ONLY with the JSON object, no markdown fences or extra text.`;
}

async function runTradeDecision(job) {
  if (!state.agent || !state.claude) return;
  const [tokenIn, tokenOut] = job.pair;
  try {
    log(`[${tokenIn}-${tokenOut}] Gathering market data…`);
    const [portfolio, tokens, quote] = await Promise.all([
      state.agent.getPortfolio(),
      state.agent.getTokens(),
      state.agent.quote(tokenIn, tokenOut, 1).catch(() => null),
    ]);

    if (!quote) {
      log(`[${tokenIn}-${tokenOut}] Could not get quote, skipping cycle.`, "warn");
      job.history.push({ ts: Date.now(), action: "skip", reason: "No quote available" });
      return;
    }

    const prompt = buildSystemPrompt(portfolio, tokens, job.pair, quote);
    const resp = await state.claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text = resp.content[0].text.trim();
    let decision;
    try {
      decision = JSON.parse(text);
    } catch {
      log(`[${tokenIn}-${tokenOut}] Claude returned unparseable response: ${text}`, "warn");
      job.history.push({ ts: Date.now(), action: "error", reason: "Bad AI response" });
      return;
    }

    if (decision.action === "trade" && decision.amount > 0) {
      log(`[${tokenIn}-${tokenOut}] AI says TRADE ${decision.amount} — ${decision.reason}`);
      const result = await state.agent.swap(tokenIn, tokenOut, decision.amount);
      log(`[${tokenIn}-${tokenOut}] Swap executed: ${result.txHash} (${result.status})`);
      job.history.push({
        ts: Date.now(),
        action: "trade",
        amount: decision.amount,
        txHash: result.txHash,
        status: result.status,
        reason: decision.reason,
      });
    } else {
      log(`[${tokenIn}-${tokenOut}] AI says HOLD — ${decision.reason}`);
      job.history.push({ ts: Date.now(), action: "hold", reason: decision.reason });
    }
  } catch (err) {
    log(`[${tokenIn}-${tokenOut}] Error: ${err.message}`, "error");
    job.history.push({ ts: Date.now(), action: "error", reason: err.message });
  }
}

// ── API Routes ───────────────────────────────────────────────────────────────

// Setup: save API key + wallet
app.post("/api/setup", async (req, res) => {
  try {
    const { apiKey, wif, network } = req.body;
    if (!apiKey) return res.status(400).json({ error: "Claude API key required" });

    state.apiKey = apiKey;
    state.network = network || "devnet";
    state.claude = new Anthropic({ apiKey });

    // Verify key works
    await state.claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });

    const netConfig = state.network === "mainnet" ? MAINNET_CONFIG : DEVNET_CONFIG;

    if (wif) {
      state.wallet = await AgentWallet.fromWIF(wif);
      state.wif = wif;
    } else {
      state.wallet = await AgentWallet.generate();
      state.wif = state.wallet.getWIF();
    }

    state.agent = new SaturnAgent(state.wallet, { network: netConfig });
    log(`Setup complete. Wallet: ${state.wallet.address} | Network: ${state.network}`);

    res.json({
      address: state.wallet.address,
      wif: state.wif,
      network: state.network,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get wallet portfolio
app.get("/api/portfolio", async (_req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    const portfolio = await state.agent.getPortfolio();
    res.json(portfolio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available tokens
app.get("/api/tokens", async (_req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    const tokens = await state.agent.getTokens();
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get quote
app.get("/api/quote", async (req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    const { tokenIn, tokenOut, amount } = req.query;
    const quote = await state.agent.quote(tokenIn, tokenOut, Number(amount) || 1);
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create scheduled job
app.post("/api/jobs", (req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  const { tokenIn, tokenOut, interval, unit } = req.body;
  if (!tokenIn || !tokenOut) return res.status(400).json({ error: "Pair required" });

  const id = Date.now().toString(36);
  const ms = unitToMs(Number(interval) || 1, unit || "minutes");
  const job = {
    id,
    pair: [tokenIn, tokenOut],
    interval: Number(interval) || 1,
    unit: unit || "minutes",
    active: true,
    timer: null,
    history: [],
  };

  // Run immediately, then on schedule
  runTradeDecision(job);
  job.timer = setInterval(() => runTradeDecision(job), ms);

  state.jobs.push(job);
  log(`Job ${id} created: ${tokenIn}-${tokenOut} every ${interval} ${unit}`);
  res.json({ id, pair: job.pair, interval: job.interval, unit: job.unit, active: true });
});

// List jobs
app.get("/api/jobs", (_req, res) => {
  res.json(
    state.jobs.map((j) => ({
      id: j.id,
      pair: j.pair,
      interval: j.interval,
      unit: j.unit,
      active: j.active,
      history: j.history.slice(-20),
    }))
  );
});

// Toggle job
app.post("/api/jobs/:id/toggle", (req, res) => {
  const job = state.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (job.active) {
    clearInterval(job.timer);
    job.timer = null;
    job.active = false;
    log(`Job ${job.id} paused`);
  } else {
    const ms = unitToMs(job.interval, job.unit);
    runTradeDecision(job);
    job.timer = setInterval(() => runTradeDecision(job), ms);
    job.active = true;
    log(`Job ${job.id} resumed`);
  }
  res.json({ id: job.id, active: job.active });
});

// Delete job
app.delete("/api/jobs/:id", (req, res) => {
  const idx = state.jobs.findIndex((j) => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Job not found" });
  clearInterval(state.jobs[idx].timer);
  state.jobs.splice(idx, 1);
  log(`Job ${req.params.id} deleted`);
  res.json({ ok: true });
});

// Logs
app.get("/api/logs", (_req, res) => {
  res.json(state.logs.slice(-100));
});

// Manual swap
app.post("/api/swap", async (req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    const { tokenIn, tokenOut, amount, slippage } = req.body;
    const result = await state.agent.swap(tokenIn, tokenOut, Number(amount), slippage || 3);
    log(`Manual swap: ${amount} ${tokenIn} → ${tokenOut} | tx: ${result.txHash}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SaturnDexClaw running → http://localhost:${PORT}`));
