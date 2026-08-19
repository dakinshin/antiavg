/**
 * Логика окна. Node здесь недоступен — только мост `window.antiavg` из preload.
 */
'use strict';

const api = window.antiavg;
const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  stopped: 'Защита остановлена',
  connecting: 'Подключение…',
  live: 'Поток жив',
  dry: 'Поток жив',
  alarm: 'Сработала защита',
  error: 'Проблема со связью',
};

let events = [];
/** Гистограмма исполнений по минутам: ключ — метка времени. */
const buckets = new Map();

/* ---------------- Форматирование ---------------- */

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 });
const hhmmss = (ms) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hhmm = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function uptime(startedAtMs) {
  if (!startedAtMs) return 'защита не запущена';
  const s = Math.floor((Date.now() - startedAtMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `за сессию · ${h ? h + ' ч ' : ''}${m} мин`;
}

/* ---------------- Отрисовка состояния ---------------- */

function renderState(st) {
  const pill = $('statePill');
  pill.dataset.state = st.state;
  $('stateText').textContent = st.lastError ? `Связь: ${st.lastError}` : STATE_TEXT[st.state];

  const mode = $('modePill');
  if (!st.running) {
    mode.dataset.state = 'stopped';
    $('modeText').textContent = 'не запущено';
  } else if (st.dryRun) {
    mode.dataset.state = 'dry';
    $('modeText').textContent = 'только наблюдение';
  } else {
    mode.dataset.state = 'alarm';
    $('modeText').textContent = 'боевой режим';
  }

  $('btnStart').disabled = st.running;
  $('btnStop').disabled = !st.running;
  $('kUptime').textContent = uptime(st.startedAtMs);

  const e = st.snapshot && st.snapshot.engine;
  $('kDetections').textContent = e ? e.detections : 0;
  $('kFills').textContent = e ? e.fills : 0;
  $('kDuplicates').textContent = e ? `разобрано, дубликатов ${e['дубликатовСделок'] ?? 0}` : 'разобрано';
  $('kDesync').textContent = e ? e.desyncs : 0;

  const positions = (st.snapshot && st.snapshot.positions) || [];
  $('kPositions').textContent = positions.length;
  $('kPositionsList').textContent = positions.length
    ? positions.map((p) => p.symbol).slice(0, 3).join(', ')
    : '—';

  const perHour = e ? e['действийЗаЧас'] ?? 0 : 0;
  $('kBreaker').innerHTML = `${perHour}<small>/30</small>`;
  const breakerTripped = e && e['предохранитель'] !== 'ок';
  $('kBreakerState').textContent = breakerTripped ? 'СРАБОТАЛ — торговля остановлена' : 'действий за час';
  $('kBreaker').parentElement.classList.toggle('ok', !breakerTripped);
  $('kBreaker').parentElement.classList.toggle('hero', Boolean(breakerTripped));

  const ws = st.snapshot && st.snapshot.ws;
  $('kWs').textContent = ws
    ? `WS: ${ws.messages} сообщ. · ${ws.pings} ping`
    : 'поток не подключён';

  renderPositions(positions);
}

function renderPositions(positions) {
  const host = $('positions');
  if (!positions.length) {
    host.innerHTML = '<p class="empty">Открытых позиций нет.</p>';
    return;
  }
  const rows = positions
    .map((p) => {
      const long = p.qty > 0;
      return `<tr>
        <td class="sym">${escape(p.symbol)}</td>
        <td class="${long ? 'long' : 'short'}">${long ? 'LONG' : 'SHORT'}</td>
        <td class="num">${nf.format(Math.abs(p.qty))}</td>
        <td class="num">${nf.format(p.entryPrice)}</td>
        <td class="num">${p.openTimeKnown && p.openedAtMs ? hhmm(p.openedAtMs) : '—'}</td>
      </tr>`;
    })
    .join('');
  host.innerHTML = `<table>
    <thead><tr><th>Символ</th><th>Сторона</th><th class="num">Объём</th>
    <th class="num">Средняя</th><th class="num">Открыта</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

const MARKS = { detection: '◆', action: '▲', skip: '·', info: '↻', warn: '!', error: '!' };

function renderLog() {
  const host = $('log');
  if (!events.length) {
    host.innerHTML = '<p class="empty">Событий пока не было.</p>';
    return;
  }
  host.innerHTML = events
    .slice(0, 120)
    .map((e) => {
      const amt = e.amount ? (e.amount > 0 ? '+' : '−') + nf.format(Math.abs(e.amount)) : '';
      const sym = e.symbol ? `<span class="s">${escape(e.symbol)}</span> — ` : '';
      return `<div class="row" data-kind="${e.kind}">
        <span class="time">${hhmmss(e.atMs)}</span>
        <span class="mark">${MARKS[e.kind] || '·'}</span>
        <span class="msg">${sym}${escape(e.text)}</span>
        <span class="amt">${amt}</span>
      </div>`;
    })
    .join('');
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/* ---------------- График ---------------- */

function bump(e) {
  if (e.kind !== 'skip' && e.kind !== 'detection' && e.kind !== 'action') return;
  const key = hhmm(e.atMs);
  const b = buckets.get(key) || { t: key, n: 0, hit: false, at: e.atMs };
  b.n += 1;
  if (e.kind === 'detection') b.hit = true;
  buckets.set(key, b);
  if (buckets.size > 40) buckets.delete(buckets.keys().next().value);
}

const NS = 'http://www.w3.org/2000/svg';
const el = (n, a) => {
  const x = document.createElementNS(NS, n);
  for (const k in a) x.setAttribute(k, a[k]);
  return x;
};

function renderChart() {
  const svg = $('chart');
  svg.textContent = '';
  const data = [...buckets.values()];
  if (!data.length) return;

  const W = 620, H = 150, PAD_L = 22, PAD_R = 6, PAD_T = 16, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const maxN = Math.max(...data.map((d) => d.n), 2);
  const GAP = 2;
  const band = plotW / data.length;
  const barW = Math.max(4, band - GAP);
  const step = maxN <= 4 ? 2 : Math.ceil(maxN / 3);

  for (let v = 0; v <= maxN; v += step) {
    const y = PAD_T + plotH - (v / maxN) * plotH;
    svg.appendChild(el('line', { x1: PAD_L, x2: W - PAD_R, y1: y, y2: y, class: v === 0 ? 'baseline' : 'gridline' }));
    const lab = el('text', { x: PAD_L - 7, y: y + 3.5, class: 'tick', 'text-anchor': 'end' });
    lab.textContent = v;
    svg.appendChild(lab);
  }

  data.forEach((d, i) => {
    const x = PAD_L + i * band + GAP / 2;
    const h = (d.n / maxN) * plotH;
    const y = PAD_T + plotH - h;
    const r = Math.min(4, barW / 2);

    const g = el('g', { class: 'bar' });
    g.appendChild(
      el('path', {
        d: `M${x} ${y + h} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + barW - r} ${y}
            Q${x + barW} ${y} ${x + barW} ${y + r} L${x + barW} ${y + h} Z`,
        fill: d.hit ? 'var(--critical)' : 'var(--deemph)',
      }),
    );
    g.dataset.t = d.t;
    g.dataset.n = d.n;
    g.dataset.hit = d.hit ? '1' : '';
    svg.appendChild(g);

    if (d.hit) {
      const lab = el('text', { x: x + barW / 2, y: y - 6, class: 'datalabel', 'text-anchor': 'end' });
      lab.textContent = 'усреднение';
      svg.appendChild(lab);
    }
    if (i % Math.max(1, Math.ceil(data.length / 6)) === 0 || d.hit) {
      const t = el('text', { x: x + barW / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = d.t;
      svg.appendChild(t);
    }
  });

  const tip = $('tip');
  const wrap = svg.parentElement;
  svg.querySelectorAll('.bar').forEach((g) => {
    g.addEventListener('mousemove', (ev) => {
      const r = wrap.getBoundingClientRect();
      tip.style.left = ev.clientX - r.left + 'px';
      tip.style.top = ev.clientY - r.top - 10 + 'px';
      tip.innerHTML =
        `${g.dataset.t} · <b>${g.dataset.n}</b> исполн.` +
        (g.dataset.hit ? ' · <span style="color:var(--critical)">сработала защита</span>' : '');
      tip.style.opacity = 1;
    });
    g.addEventListener('mouseleave', () => (tip.style.opacity = 0));
  });
}

/* ---------------- Настройки ---------------- */

const FIELDS = {
  sApiKey: 'apiKey', sApiSecret: 'apiSecret', sTestnet: 'testnet', sDryRun: 'dryRun',
  sReaction: 'reactionMode', sThreshold: 'lossThresholdPct', sGrid: 'countPreexistingOrders',
  sUnknown: 'unknownOpenTimePolicy', sCancelOrders: 'cancelDangerousOrders',
  sLockDrawdown: 'lockStopWhileInDrawdown', sLockSettings: 'lockSettingsWhileInDrawdown',
  sSymbols: 'symbols', sMaxActions: 'maxActionsPerHour',
  sMaxPos: 'maxPositionEnabled', sMaxPosLev: 'maxPositionLeverage',
  sDefStop: 'defaultStopEnabled', sDefStopPct: 'defaultStopPct',
  sProtectStop: 'protectStopOrders', sMaxRisk: 'maxRiskEnabled', sMaxRiskPct: 'maxRiskPct',
  sBelowMin: 'onQtyBelowMin', sWsProxy: 'wsProxy', sRestProxy: 'restProxy',
  sLaunch: 'launchOnLogin', sAutoGuard: 'autoStartGuard',
};

async function openSettings() {
  const { values, encryptionAvailable } = await api.getSettings();
  $('encWarn').hidden = encryptionAvailable;
  for (const [id, key] of Object.entries(FIELDS)) {
    const node = $(id);
    if (node.type === 'checkbox') node.checked = Boolean(values[key]);
    else node.value = values[key] ?? '';
  }
  $('saveNote').textContent = '';
  $('settings').showModal();
}

async function saveSettings() {
  const payload = {};
  for (const [id, key] of Object.entries(FIELDS)) {
    const node = $(id);
    if (node.type === 'checkbox') payload[key] = node.checked;
    else if (node.type === 'number') payload[key] = Number(node.value);
    else payload[key] = node.value;
  }
  const res = await api.saveSettings(payload);
  if (res.warning) {
    $('saveNote').textContent = res.warning;
    return;
  }
  // Часть полей (а при строгом замке — все) мог откатить замок просадки.
  // Показываем то, что реально сохранилось, а не то, что человек нажал.
  if (res.values) {
    for (const [id, key] of Object.entries(FIELDS)) {
      const node = $(id);
      if (node.type === 'checkbox') node.checked = Boolean(res.values[key]);
      else node.value = res.values[key] ?? '';
    }
  }
  $('settings').close();
  if (res.restarted) {
    events.unshift({
      id: Date.now(), atMs: Date.now(), kind: 'info',
      text: 'настройки сохранены и применены — защита перезапущена',
    });
    renderLog();
  } else if (res.needsRestart) {
    events.unshift({
      id: Date.now(), atMs: Date.now(), kind: 'warn',
      text: 'настройки сохранены, но НЕ применены — перезапустите защиту',
    });
    renderLog();
  }
}

/* ---------------- Подключение ---------------- */

$('btnStart').addEventListener('click', async () => {
  const res = await api.start();
  if (!res.ok && res.error) {
    events.unshift({ id: Date.now(), atMs: Date.now(), kind: 'error', text: res.error });
    renderLog();
  }
});
$('btnStop').addEventListener('click', () => api.stop());
$('btnSettings').addEventListener('click', openSettings);
$('btnSave').addEventListener('click', saveSettings);
$('btnLogFolder').addEventListener('click', () => api.openLogFolder());

api.onState(renderState);
api.onEvent((e) => {
  events.unshift(e);
  if (events.length > 400) events.length = 400;
  bump(e);
  renderLog();
  renderChart();
});

(async () => {
  events = await api.getEvents();
  events.forEach(bump);
  renderLog();
  renderChart();
  renderState(await api.getState());
})();

// Аптайм в плитке должен идти сам, без событий.
setInterval(async () => renderState(await api.getState()), 5000);
