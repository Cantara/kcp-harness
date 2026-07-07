// Dashboard UI — single-page HTML/CSS/JS served as a template string.
//
// No build step, no framework, no external dependencies. The dashboard
// fetches data from the API endpoints and renders it in the browser.

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KCP Harness — Compliance Dashboard</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e1e4ed; --muted: #8b8fa3; --accent: #e94560;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24; --blue: #60a5fa;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header .badge { font-size: 11px; background: var(--accent); color: white; padding: 2px 8px; border-radius: 10px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat .value.green { color: var(--green); }
  .stat .value.red { color: var(--red); }
  .stat .value.yellow { color: var(--yellow); }
  .stat .value.blue { color: var(--blue); }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .panel-header h2 { font-size: 14px; font-weight: 600; }
  .panel-body { padding: 0; max-height: 500px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 16px; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; background: var(--surface); }
  td { padding: 8px 16px; border-top: 1px solid var(--border); }
  .outcome { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .outcome-approved { background: rgba(74,222,128,0.15); color: var(--green); }
  .outcome-blocked { background: rgba(248,113,113,0.15); color: var(--red); }
  .outcome-pass-through { background: rgba(96,165,250,0.15); color: var(--blue); }
  .outcome-error { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .type-badge { font-size: 11px; color: var(--muted); }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .filters { display: flex; gap: 8px; align-items: center; }
  .filters select, .filters input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 4px; font-size: 12px; }
  .sessions-list { list-style: none; }
  .sessions-list li { padding: 10px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .sessions-list li:first-child { border-top: none; }
  .session-id { font-family: monospace; font-size: 12px; color: var(--blue); cursor: pointer; }
  .session-meta { font-size: 11px; color: var(--muted); }
  footer { text-align: center; color: var(--muted); font-size: 11px; margin-top: 24px; padding: 16px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>KCP Harness</h1>
    <span class="badge">Compliance Dashboard</span>
    <span style="margin-left:auto;font-size:12px;color:var(--muted)"><span class="live-dot"></span> Live</span>
  </header>

  <div class="stats" id="stats">
    <div class="stat"><div class="label">Sessions</div><div class="value blue" id="s-sessions">-</div></div>
    <div class="stat"><div class="label">Events</div><div class="value" id="s-events">-</div></div>
    <div class="stat"><div class="label">Governed</div><div class="value green" id="s-governed">-</div></div>
    <div class="stat"><div class="label">Blocked</div><div class="value red" id="s-blocked">-</div></div>
    <div class="stat"><div class="label">Budget Exceeded</div><div class="value yellow" id="s-budget">-</div></div>
    <div class="stat"><div class="label">Drifts</div><div class="value yellow" id="s-drifts">-</div></div>
    <div class="stat"><div class="label">Sig. Blocked</div><div class="value red" id="s-sig">-</div></div>
  </div>

  <div class="panel">
    <div class="panel-header">
      <h2>Sessions</h2>
    </div>
    <div class="panel-body">
      <ul class="sessions-list" id="sessions-list"></ul>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header">
      <h2>Event Log</h2>
      <div class="filters">
        <select id="f-type"><option value="">All types</option>
          <option value="tool_call">tool_call</option>
          <option value="session_start">session_start</option>
          <option value="session_end">session_end</option>
          <option value="budget_spend">budget_spend</option>
          <option value="budget_exceeded">budget_exceeded</option>
          <option value="temporal_drift">temporal_drift</option>
        </select>
        <select id="f-outcome"><option value="">All outcomes</option>
          <option value="approved">approved</option>
          <option value="blocked">blocked</option>
          <option value="pass-through">pass-through</option>
          <option value="error">error</option>
        </select>
      </div>
    </div>
    <div class="panel-body">
      <table>
        <thead><tr><th>Time</th><th>Session</th><th>Type</th><th>Tool</th><th>Outcome</th><th>Reason</th></tr></thead>
        <tbody id="events-body"></tbody>
      </table>
    </div>
  </div>

  <footer>kcp-harness compliance dashboard &middot; all data local &middot; no external connections</footer>
</div>

<script>
const API = '';
let allEvents = [];

async function load() {
  const [summary, sessions, events] = await Promise.all([
    fetch(API + '/api/summary').then(r => r.json()),
    fetch(API + '/api/sessions').then(r => r.json()),
    fetch(API + '/api/events').then(r => r.json()),
  ]);
  updateStats(summary);
  renderSessions(sessions.sessions || []);
  allEvents = events;
  renderEvents(events);
}

function updateStats(s) {
  document.getElementById('s-sessions').textContent = s.sessions ?? 0;
  document.getElementById('s-events').textContent = s.events ?? 0;
  document.getElementById('s-governed').textContent = s.governed ?? 0;
  document.getElementById('s-blocked').textContent = s.blocked ?? 0;
  document.getElementById('s-budget').textContent = s.budgetExceeded ?? 0;
  document.getElementById('s-drifts').textContent = s.drifts ?? 0;
  document.getElementById('s-sig').textContent = s.signatureBlocked ?? 0;
}

function renderSessions(sessions) {
  const ul = document.getElementById('sessions-list');
  if (!sessions.length) { ul.innerHTML = '<li style="color:var(--muted)">No sessions yet</li>'; return; }
  ul.innerHTML = sessions.map(s =>
    '<li><div><span class="session-id" onclick="filterSession(\\'' + s.id + '\\')">' + s.id.slice(0,12) + '</span>' +
    '<div class="session-meta">' + s.events + ' events, ' + s.governed + ' governed, ' + s.blocked + ' blocked</div></div>' +
    '<div class="session-meta">' + new Date(s.startedAt).toLocaleString() + '</div></li>'
  ).join('');
}

function renderEvents(events) {
  const type = document.getElementById('f-type').value;
  const outcome = document.getElementById('f-outcome').value;
  let filtered = events;
  if (type) filtered = filtered.filter(e => e.type === type);
  if (outcome) filtered = filtered.filter(e => e.outcome === outcome);
  const last200 = filtered.slice(-200);
  const tbody = document.getElementById('events-body');
  tbody.innerHTML = last200.map(e =>
    '<tr><td style="font-size:11px;white-space:nowrap">' + new Date(e.timestamp).toLocaleTimeString() + '</td>' +
    '<td style="font-family:monospace;font-size:11px">' + (e.sessionId||'').slice(0,8) + '</td>' +
    '<td><span class="type-badge">' + e.type + '</span></td>' +
    '<td>' + (e.toolCall?.name || '-') + '</td>' +
    '<td><span class="outcome outcome-' + e.outcome + '">' + e.outcome + '</span></td>' +
    '<td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (e.governance?.reason || e.error || e.type) + '</td></tr>'
  ).join('');
}

function filterSession(id) {
  const filtered = allEvents.filter(e => e.sessionId === id);
  renderEvents(filtered);
}

document.getElementById('f-type').onchange = () => renderEvents(allEvents);
document.getElementById('f-outcome').onchange = () => renderEvents(allEvents);

// SSE live updates
const sse = new EventSource(API + '/api/events/stream');
sse.onmessage = (msg) => {
  try {
    const event = JSON.parse(msg.data);
    allEvents.push(event);
    renderEvents(allEvents);
    fetch(API + '/api/summary').then(r => r.json()).then(updateStats);
  } catch {}
};
sse.onerror = () => {};

load();
</script>
</body>
</html>`;
}
