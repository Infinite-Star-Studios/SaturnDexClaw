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
  const tag = `[${tokenIn}-${tokenOut}]`;
  try {
    log(`${tag} Gathering market data from Saturn DEX…`);

    log(`${tag} Fetching portfolio, tokens, and quote in parallel…`);
    const [portfolio, tokens, quote] = await Promise.all([
      state.agent.getPortfolio(),
      state.agent.getTokens(),
      state.agent.quote(tokenIn, tokenOut, 1).catch((e) => {
        log(`${tag} Quote request failed: ${e.message}`, "warn");
        return null;
      }),
    ]);

    const balances = portfolio.balances?.fungible || [];
    log(`${tag} Portfolio: ${balances.map((b) => `${b.symbol}=${b.amount}`).join(", ") || "empty"}`);
    log(`${tag} Available tokens: ${tokens.length}`);

    if (!quote) {
      log(`${tag} No quote available — skipping this cycle`, "warn");
      job.history.push({ ts: Date.now(), action: "skip", reason: "No quote available" });
      return;
    }

    log(`${tag} Quote: 1 ${tokenIn} = ${quote.quote.amountOut} ${tokenOut} | Rate: ${quote.quote.rate} | Route: ${quote.quote.route.join(" → ")} | Impact: ${quote.priceImpact}%`);

    log(`${tag} Sending market data to Claude AI for analysis…`);
    const prompt = buildSystemPrompt(portfolio, tokens, job.pair, quote);
    const resp = await state.claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text = resp.content[0].text.trim();
    log(`${tag} Claude response: ${text}`);

    let decision;
    try {
      decision = JSON.parse(text);
    } catch {
      log(`${tag} Claude returned unparseable response — skipping`, "warn");
      job.history.push({ ts: Date.now(), action: "error", reason: "Bad AI response" });
      return;
    }

    if (decision.action === "trade" && decision.amount > 0) {
      log(`${tag} AI DECISION: TRADE ${decision.amount} ${tokenIn} → ${tokenOut}`);
      log(`${tag} Reason: ${decision.reason}`);
      log(`${tag} Executing swap via Saturn DEX SDK…`);
      const result = await state.agent.swap(tokenIn, tokenOut, decision.amount);
      log(`${tag} Swap confirmed! TX: ${result.txHash} | Status: ${result.status} | Out: ${result.amountOut} ${tokenOut}`);
      job.history.push({
        ts: Date.now(),
        action: "trade",
        amount: decision.amount,
        txHash: result.txHash,
        status: result.status,
        reason: decision.reason,
      });
    } else {
      log(`${tag} AI DECISION: HOLD`);
      log(`${tag} Reason: ${decision.reason}`);
      job.history.push({ ts: Date.now(), action: "hold", reason: decision.reason });
    }
  } catch (err) {
    log(`${tag} Error in trade cycle: ${err.message}`, "error");
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
    log(`Setting up with network: ${state.network}`);

    state.claude = new Anthropic({ apiKey });
    log("Verifying Claude API key…");

    await state.claude.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });
    log("Claude API key verified successfully");

    const netConfig = state.network === "mainnet" ? MAINNET_CONFIG : DEVNET_CONFIG;
    log(`Saturn API: ${netConfig.saturnApiUrl}`);

    if (wif) {
      log("Importing wallet from WIF…");
      state.wallet = await AgentWallet.fromWIF(wif);
      state.wif = wif;
    } else {
      log("Generating new wallet…");
      state.wallet = await AgentWallet.generate();
      state.wif = state.wallet.getWIF();
      log("New wallet generated — save your WIF key!");
    }

    state.agent = new SaturnAgent(state.wallet, { network: netConfig });
    log(`Setup complete. Wallet: ${state.wallet.address} | Network: ${state.network}`);

    res.json({
      address: state.wallet.address,
      wif: state.wif,
      network: state.network,
    });
  } catch (err) {
    log(`Setup failed: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

// Get wallet portfolio
app.get("/api/portfolio", async (_req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    log("Fetching portfolio from Saturn API…");
    const portfolio = await state.agent.getPortfolio();
    const fungible = portfolio.balances?.fungible || [];
    log(`Portfolio loaded: ${fungible.length} tokens | Stake: ${portfolio.stake} SOUL | Unclaimed: ${portfolio.unclaimed} KCAL`);
    fungible.forEach((b) => log(`  ${b.symbol}: ${b.amount}`));
    res.json(portfolio);
  } catch (err) {
    log(`Portfolio fetch failed: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

// Get available tokens
app.get("/api/tokens", async (_req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    log("Fetching token list from Saturn DEX API…");
    const tokens = await state.agent.getTokens();
    log(`Loaded ${tokens.length} tokens from Saturn: ${tokens.map((t) => t.symbol).join(", ")}`);
    res.json(tokens);
  } catch (err) {
    log(`Token fetch failed: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

// Get quote
app.get("/api/quote", async (req, res) => {
  if (!state.agent) return res.status(400).json({ error: "Not set up" });
  try {
    const { tokenIn, tokenOut, amount } = req.query;
    log(`Requesting quote: ${amount} ${tokenIn} → ${tokenOut} from Saturn API…`);
    const data = await state.agent.quote(tokenIn, tokenOut, Number(amount) || 1);
    log(`Quote received: ${data.quote.amountIn} ${tokenIn} → ${data.quote.amountOut} ${tokenOut} | Rate: ${data.quote.rate} | Route: ${data.quote.route.join(" → ")} | Impact: ${data.priceImpact}% | Fee: ${data.fee.totalPercent}%`);
    res.json(data);
  } catch (err) {
    log(`Quote failed: ${err.message}`, "error");
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

  state.jobs.push(job);
  log(`Job ${id} created: ${tokenIn} → ${tokenOut} every ${interval} ${unit} (${ms}ms interval)`);

  // Run immediately, then on schedule
  log(`Job ${id}: Running first trade cycle now…`);
  runTradeDecision(job);
  job.timer = setInterval(() => {
    log(`Job ${id}: Scheduled cycle triggered for ${tokenIn} → ${tokenOut}`);
    runTradeDecision(job);
  }, ms);

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
    log(`Manual swap requested: ${amount} ${tokenIn} → ${tokenOut} (slippage: ${slippage || 3}%)`);
    log("Executing swap via Saturn DEX SDK (quote → safety → sign → broadcast → confirm)…");
    const result = await state.agent.swap(tokenIn, tokenOut, Number(amount), slippage || 3);
    log(`Manual swap confirmed! TX: ${result.txHash} | Status: ${result.status} | In: ${result.amountIn} ${tokenIn} | Out: ${result.amountOut} ${tokenOut}`);
    res.json(result);
  } catch (err) {
    log(`Manual swap failed: ${err.message}`, "error");
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SaturnDexClaw running → http://localhost:${PORT}`));
