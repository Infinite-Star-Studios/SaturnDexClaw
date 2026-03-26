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

    await loadTokens();
    startLogPolling();
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
  try {
    const p = await api("/api/portfolio");
    const balances = p.balances?.fungible || p.balances || p;
    $("#portfolio").textContent = JSON.stringify(balances, null, 2);
  } catch (err) {
    $("#portfolio").textContent = `Error: ${err.message}`;
  }
};

// ── Quick Trade ──────────────────────────────────────────────────────────────
$("#btn-quote").onclick = async () => {
  try {
    const q = await api(
      `/api/quote?tokenIn=${$("#qt-in").value}&tokenOut=${$("#qt-out").value}&amount=${$("#qt-amount").value || 1}`
    );
    $("#quote-result").textContent =
      `Out: ${q.amountOut}  |  Rate: ${q.exchangeRate}  |  Impact: ${q.priceImpact}%  |  Fees: ${JSON.stringify(q.fees)}`;
  } catch (err) {
    $("#quote-result").textContent = `Error: ${err.message}`;
  }
};

$("#btn-swap").onclick = async () => {
  if (!confirm("Execute this swap?")) return;
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
    $("#quote-result").textContent = `Swap done! TX: ${r.txHash} (${r.status})`;
    $("#quote-result").style.color = "var(--green)";
  } catch (err) {
    $("#quote-result").textContent = `Error: ${err.message}`;
    $("#quote-result").style.color = "var(--red)";
  }
};

// ── Scheduled Jobs ───────────────────────────────────────────────────────────
$("#btn-add-job").onclick = async () => {
  try {
    const job = await api("/api/jobs", {
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
      .map(
        (j) => `
      <div class="job-card">
        <div>
          <span class="pair">${j.pair[0]} → ${j.pair[1]}</span>
          <span class="schedule">every ${j.interval} ${j.unit}</span>
          <span class="status ${j.active ? "status-active" : "status-paused"}">${j.active ? "Active" : "Paused"}</span>
          ${j.history.length ? `<div class="job-history">Last: ${j.history[j.history.length - 1].action} — ${j.history[j.history.length - 1].reason || ""}</div>` : ""}
        </div>
        <div class="job-actions">
          <button class="btn-toggle" onclick="toggleJob('${j.id}')">${j.active ? "Pause" : "Resume"}</button>
          <button class="btn-danger" onclick="deleteJob('${j.id}')">Delete</button>
        </div>
      </div>`
      )
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
  pollTimer = setInterval(async () => {
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
  }, 3000);
}
