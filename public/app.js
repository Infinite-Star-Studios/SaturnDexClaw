/* SaturnDexClaw — Frontend */
const $ = (s) => document.querySelector(s);
const api = (path, opts) =>
  fetch(path, opts).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });

let tokens = [];
let pollTimer = null;

// ── Setup ────────────────────────────────────────────────────────────────────
$("#btn-setup").onclick = async () => {
  const btn = $("#btn-setup");
  const out = $("#setup-result");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  out.classList.remove("hidden");
  out.style.color = "var(--muted)";
  out.textContent = "Verifying Claude API key & connecting to Saturn DEX…";

  try {
    const res = await api("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: $("#api-key").value.trim(),
        wif: $("#wif").value.trim() || undefined,
        network: $("#network").value,
      }),
    });

    out.textContent = `Connected!\nAddress: ${res.address}\nNetwork: ${res.network}`;
    if (!$("#wif").value.trim()) {
      out.textContent += `\n\nGenerated WIF (save this!):\n${res.wif}`;
    }
    out.style.color = "var(--green)";

    // Show dashboard
    $("#setup-panel").style.opacity = ".5";
    $("#dashboard").classList.remove("hidden");
    $("#wallet-info").textContent = `Address: ${res.address}`;

    // Start log polling first so user sees token loading activity
    startLogPolling();
    await loadTokens();
    refreshJobs();
  } catch (err) {
    out.textContent = `Error: ${err.message}`;
    out.style.color = "var(--red)";
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
};

// ── Tokens ───────────────────────────────────────────────────────────────────
async function loadTokens() {
  try {
    tokens = await api("/api/tokens");
    const selects = document.querySelectorAll(".token-select");
    selects.forEach((sel) => {
      sel.innerHTML = tokens
        .map((t) => `<option value="${t.symbol}">${t.symbol}</option>`)
        .join("");
    });
    // Set sensible defaults
    if (tokens.length >= 2) {
      const soulIdx = tokens.findIndex((t) => t.symbol === "SOUL");
      const kcalIdx = tokens.findIndex((t) => t.symbol === "KCAL");
      if (soulIdx >= 0) {
        $("#qt-in").selectedIndex = soulIdx;
        $("#job-in").selectedIndex = soulIdx;
      }
      if (kcalIdx >= 0) {
        $("#qt-out").selectedIndex = kcalIdx;
        $("#job-out").selectedIndex = kcalIdx;
      }
    }
  } catch (err) {
    console.error("Failed to load tokens:", err);
  }
}

// ── Portfolio ────────────────────────────────────────────────────────────────
$("#btn-portfolio").onclick = async () => {
  $("#portfolio").textContent = "Loading…";
  try {
    const p = await api("/api/portfolio");
    const fungible = p.balances?.fungible || [];
    if (!fungible.length) {
      $("#portfolio").textContent = "No token balances found for this wallet.";
      return;
    }
    $("#portfolio").textContent = fungible
      .map((b) => `${b.symbol}: ${b.amount}`)
      .join("\n");
  } catch (err) {
    $("#portfolio").textContent = `Error: ${err.message}`;
  }
};

// ── Quick Trade ──────────────────────────────────────────────────────────────
$("#btn-quote").onclick = async () => {
  const out = $("#quote-result");
  out.style.color = "var(--muted)";
  out.textContent = "Fetching quote from Saturn DEX…";
  try {
    const data = await api(
      `/api/quote?tokenIn=${$("#qt-in").value}&tokenOut=${$("#qt-out").value}&amount=${$("#qt-amount").value || 1}`
    );
    // QuoteResponse has nested structure: { quote: { amountIn, amountOut, rate, route, hops }, fee: { totalPercent, legs }, priceImpact }
    const q = data.quote;
    const fee = data.fee;
    out.textContent = [
      `In: ${q.amountIn} ${q.tokenIn}  →  Out: ${q.amountOut} ${q.tokenOut}`,
      `Rate: ${q.rate}  |  Reverse: ${q.reverseRate}`,
      `Route: ${q.route.join(" → ")} (${q.hops} hop${q.hops !== 1 ? "s" : ""})`,
      `Price Impact: ${data.priceImpact}%`,
      `Fee: ${fee.totalPercent}% — ${fee.description}`,
      fee.legs.map((l) => `  ${l.leg}: ${l.percent}%`).join("\n"),
    ].join("\n");
    out.style.color = "var(--text)";
  } catch (err) {
    out.textContent = `Error: ${err.message}`;
    out.style.color = "var(--red)";
  }
};

$("#btn-swap").onclick = async () => {
  if (!confirm("Execute this swap?")) return;
  const out = $("#quote-result");
  out.style.color = "var(--muted)";
  out.textContent = "Executing swap (quote → safety checks → sign → broadcast → confirm)…";
  try {
    const r = await api("/api/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenIn: $("#qt-in").value,
        tokenOut: $("#qt-out").value,
        amount: Number($("#qt-amount").value),
      }),
    });
    out.textContent = `Swap confirmed!\nTX: ${r.txHash}\nStatus: ${r.status}\nIn: ${r.amountIn} ${r.tokenIn}  →  Out: ${r.amountOut} ${r.tokenOut}`;
    out.style.color = "var(--green)";
  } catch (err) {
    out.textContent = `Swap failed: ${err.message}`;
    out.style.color = "var(--red)";
  }
};

// ── Scheduled Jobs ───────────────────────────────────────────────────────────
$("#btn-add-job").onclick = async () => {
  try {
    await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenIn: $("#job-in").value,
        tokenOut: $("#job-out").value,
        interval: Number($("#job-interval").value),
        unit: $("#job-unit").value,
      }),
    });
    refreshJobs();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

async function refreshJobs() {
  try {
    const jobs = await api("/api/jobs");
    const container = $("#jobs-list");
    if (!jobs.length) {
      container.innerHTML = '<p style="color:var(--muted);font-size:.8rem">No active jobs. Add one above.</p>';
      return;
    }
    container.innerHTML = jobs
      .map((j) => {
        const last = j.history.length ? j.history[j.history.length - 1] : null;
        const lastText = last
          ? `Last: <strong>${last.action}</strong>${last.reason ? ` — ${last.reason}` : ""}${last.txHash ? ` (TX: ${last.txHash.slice(0, 12)}…)` : ""}`
          : "Waiting for first cycle…";
        return `
      <div class="job-card">
        <div>
          <span class="pair">${j.pair[0]} → ${j.pair[1]}</span>
          <span class="schedule">every ${j.interval} ${j.unit}</span>
          <span class="status ${j.active ? "status-active" : "status-paused"}">${j.active ? "Active" : "Paused"}</span>
          <div class="job-history">${lastText} (${j.history.length} cycles)</div>
        </div>
        <div class="job-actions">
          <button class="btn-toggle" onclick="toggleJob('${j.id}')">${j.active ? "Pause" : "Resume"}</button>
          <button class="btn-danger" onclick="deleteJob('${j.id}')">Delete</button>
        </div>
      </div>`;
      })
      .join("");
  } catch (err) {
    console.error(err);
  }
}

window.toggleJob = async (id) => {
  await api(`/api/jobs/${id}/toggle`, { method: "POST" });
  refreshJobs();
};

window.deleteJob = async (id) => {
  if (!confirm("Delete this job?")) return;
  await api(`/api/jobs/${id}`, { method: "DELETE" });
  refreshJobs();
};

// ── Log Polling ──────────────────────────────────────────────────────────────
function startLogPolling() {
  if (pollTimer) return;
  const poll = async () => {
    try {
      const logs = await api("/api/logs");
      const area = $("#log-area");
      area.innerHTML = logs
        .map(
          (l) =>
            `<div class="log-${l.level}">[${new Date(l.ts).toLocaleTimeString()}] ${l.msg}</div>`
        )
        .join("");
      area.scrollTop = area.scrollHeight;
    } catch {}
    refreshJobs();
  };
  poll(); // Run immediately
  pollTimer = setInterval(poll, 2000);
}
