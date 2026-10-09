// ---------- rendering: the 1280x400 host panel at the top of the page ----------
//
// Three bands: identity (clock, host facts, controls) | vitals (four dials
// + network graph) | containers (count, health pill, top 8 rows).
//
// The panel is laid out at a fixed 1280x400 and scaled to the width of the
// page, so it reads the same on a desktop as on a dedicated 1280x400 bar
// display. On narrow screens it drops the scaling and stacks instead.
// Add #kiosk to the URL to show only the panel, filling the window.
//
// Exposes: panelInit(), renderPanel(sys), renderPanelContainers(list),
// panelSetLink(ok) -- called from app.js.

(function () {
  const HISTORY_MAX = 60;
  const ROW_SLOTS = 8;
  const DISK_ROTATE_MS = 6000;
  const FLOW_BELOW_PX = 720;   // stack instead of scale under this width
  const MAX_SCALE = 1.25;      // on very wide screens, stretch instead of growing further

  const hist = { netRx: [], netTx: [] };
  let disks = [];
  let diskIndex = 0;
  let diskTimer = null;
  let lastSys = null;
  let uptimeBase = null, uptimeAt = 0;
  let lastOk = 0;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function push(arr, v) { arr.push(v); if (arr.length > HISTORY_MAX) arr.shift(); }

  // "1.21 / 3.64 TB" -- both sides in the larger value's unit
  function pair(used, total) {
    if (used == null || total == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, t = total;
    while (t >= 1024 && i < units.length - 1) { t /= 1024; i++; }
    const div = Math.pow(1024, i);
    const d = t >= 100 ? 0 : t >= 10 ? 1 : 2;
    return `${(used / div).toFixed(d)} / ${t.toFixed(d)} ${units[i]}`;
  }

  function mbps(bytesPerSec) {
    return bytesPerSec == null ? null : (bytesPerSec * 8) / 1e6;
  }
  function fmtMbps(n) {
    if (n == null) return '—';
    return n >= 100 ? n.toFixed(0) : n.toFixed(1);
  }

  // ---------- layout: scale / flow / kiosk ----------

  function isKiosk() { return document.documentElement.classList.contains('kiosk'); }

  function layout() {
    const fit = $('hp-fit'), stage = $('hp-stage');
    if (!fit || !stage) return;
    const kiosk = isKiosk();
    const flow = !kiosk && window.innerWidth < FLOW_BELOW_PX;
    fit.classList.toggle('hp-flow', flow);

    if (flow) {
      stage.style.transform = '';
      stage.style.width = '';
      fit.style.height = '';
      return;
    }

    let s, w;
    if (kiosk) {
      w = window.innerWidth;
      s = Math.min(w / 1280, window.innerHeight / 400);
    } else {
      w = fit.clientWidth;
      s = Math.min(w / 1280, MAX_SCALE);
    }
    stage.style.transform = `scale(${s})`;
    stage.style.width = `${w / s}px`;      // wider than 1280 when capped: middle band stretches
    fit.style.height = `${400 * s}px`;
    fitClock();
    drawChart();
  }

  // the clock is sized for Barlow Condensed; if that font can't load (no
  // internet on the server's network) the fallback is wider, so step the
  // size down until the seconds fit inside the band
  function fitClock() {
    const el = document.querySelector('.hp-clock');
    if (!el) return;
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > 48) {
      size -= 4;
      el.style.fontSize = `${size}px`;
    }
  }

  // ---------- dials ----------

  const ARC = 270, R = 46, C = 2 * Math.PI * R, LEN = (C * ARC) / 360;
  const G = {
    cpu:  { label: 'CPU',      unit: '%',      warn: 75, crit: 90 },
    mem:  { label: 'Memory',   unit: '%',      warn: 80, crit: 92 },
    disk: { label: 'Storage',  unit: '%',      warn: 80, crit: 90 },
    temp: { label: 'CPU temp', unit: '°C', warn: 70, crit: 85 },
  };

  function buildDials() {
    const wrap = $('hp-gauges');
    wrap.innerHTML = '';
    Object.keys(G).forEach((key) => {
      const g = G[key];
      let ticks = '';
      [0, 0.5, 1].forEach((f) => {
        const a = ((135 + f * ARC) * Math.PI) / 180;
        ticks += `<line class="hp-tick" x1="${(59 + Math.cos(a) * (R + 7)).toFixed(1)}" y1="${(54 + Math.sin(a) * (R + 7)).toFixed(1)}" x2="${(59 + Math.cos(a) * (R + 11)).toFixed(1)}" y2="${(54 + Math.sin(a) * (R + 11)).toFixed(1)}"/>`;
      });
      const el = document.createElement('div');
      el.className = 'hp-gauge';
      el.dataset.gauge = key;
      el.innerHTML = `
        <div class="hp-dial"><svg viewBox="0 0 118 104" aria-hidden="true">${ticks}
          <circle class="hp-track" cx="59" cy="54" r="${R}" stroke-dasharray="${LEN.toFixed(1)} ${C.toFixed(1)}" transform="rotate(135 59 54)"/>
          <circle class="hp-bar" cx="59" cy="54" r="${R}" stroke-dasharray="0 ${C.toFixed(1)}" transform="rotate(135 59 54)"/>
        </svg><div class="hp-read"><span class="hp-num"><span class="hp-n">—</span><small>${g.unit}</small></span></div></div>
        <div class="hp-label"></div>
        <div class="hp-sub">&nbsp;</div>`;
      wrap.appendChild(el);
      g.el = el;
      g.bar = el.querySelector('.hp-bar');
      g.n = el.querySelector('.hp-n');
      g.lbl = el.querySelector('.hp-label');
      g.sub = el.querySelector('.hp-sub');
      g.lbl.textContent = g.label;
    });

    // more than one disk: the storage dial cycles through them on its own,
    // and a click/tap moves to the next one straight away
    G.disk.el.addEventListener('click', () => {
      if (disks.length < 2) return;
      diskIndex = (diskIndex + 1) % disks.length;
      drawDisk();
      restartDiskTimer();
    });
  }

  function setDial(g, v, sub) {
    const has = v != null && Number.isFinite(v);
    const f = has ? clamp(v / 100, 0, 1) : 0;
    g.bar.setAttribute('stroke-dasharray', `${(LEN * f).toFixed(1)} ${C.toFixed(1)}`);
    g.bar.style.stroke = !has ? 'var(--hp-dim)' : v >= g.crit ? 'var(--bad)' : v >= g.warn ? 'var(--warn)' : 'var(--accent)';
    g.n.textContent = has ? Math.round(v) : '—';
    g.sub.textContent = sub || ' ';
  }

  function drawDisk() {
    const g = G.disk;
    if (!disks.length) {
      g.lbl.textContent = 'Storage';
      g.lbl.classList.remove('hp-label--path');
      g.el.classList.remove('hp-gauge--cycle');
      setDial(g, null, 'no drives detected');
      return;
    }
    diskIndex = diskIndex % disks.length;
    const d = disks[diskIndex];
    const multi = disks.length > 1;
    g.el.classList.toggle('hp-gauge--cycle', multi);
    g.el.title = multi ? 'click for the next drive' : '';
    if (multi) {
      g.lbl.textContent = d.mount;
      g.lbl.classList.add('hp-label--path');
    } else {
      g.lbl.textContent = 'Storage';
      g.lbl.classList.remove('hp-label--path');
    }
    setDial(g, d.usedPct, pair(d.usedBytes, d.totalBytes));
  }

  function restartDiskTimer() {
    if (diskTimer) clearInterval(diskTimer);
    diskTimer = null;
    if (disks.length > 1) {
      diskTimer = setInterval(() => { diskIndex = (diskIndex + 1) % disks.length; drawDisk(); }, DISK_ROTATE_MS);
    }
  }

  // ---------- network graph ----------

  // the graph's coordinate space follows its real size, so axis labels and
  // stroke widths aren't stretched when the panel is scaled or stacked
  let W = 512, H = 110;
  const PR = 40, PT = 6, PB = 4;

  function niceMax(m) {
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 250, 500, 1000, 2500, 5000, 10000];
    for (const s of steps) if (m <= s) return s;
    return Math.ceil(m / 10000) * 10000;
  }

  function points(arr, max) {
    const pw = W - PR, ph = H - PT - PB, off = HISTORY_MAX - arr.length;
    return arr.map((v, i) => [((off + i) / (HISTORY_MAX - 1)) * pw, PT + ph - (v / max) * ph]);
  }
  const line = (p) => p.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('');

  function drawChart() {
    const svg = $('hp-chart');
    if (svg.clientWidth > PR + 20 && svg.clientHeight > 20) {
      W = svg.clientWidth; H = svg.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    const rx = hist.netRx, tx = hist.netTx;
    const pw = W - PR, ph = H - PT - PB;
    const max = niceMax(Math.max(1, ...rx, ...tx) * 1.08);
    let s = '<defs><linearGradient id="hp-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>';
    [0, 0.5, 1].forEach((f) => {
      const y = PT + ph - f * ph;
      s += `<line class="hp-grid" x1="0" x2="${pw}" y1="${y}" y2="${y}"/>`;
      s += `<text class="hp-axis" x="${pw + 6}" y="${y + 3.5}">${+(max * f).toFixed(1)}</text>`;
    });
    if (rx.length > 1) {
      const pr = points(rx, max), pu = points(tx, max);
      const last = pr[pr.length - 1];
      s += `<path d="${line(pr)}L${last[0].toFixed(1)} ${H - PB}L${pr[0][0].toFixed(1)} ${H - PB}Z" fill="url(#hp-grad)"/>`;
      s += `<path d="${line(pr)}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
      s += `<path d="${line(pu)}" fill="none" stroke="var(--hp-up)" stroke-width="1.4" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`;
      const b = pu[pu.length - 1];
      s += `<circle cx="${last[0]}" cy="${last[1].toFixed(1)}" r="3" fill="var(--accent)"/>`;
      s += `<circle cx="${b[0]}" cy="${b[1].toFixed(1)}" r="2.5" fill="var(--hp-up)"/>`;
    }
    svg.innerHTML = s;
  }

  function netLabel(iface) {
    const secs = (HISTORY_MAX * (typeof settings !== 'undefined' ? settings.interval : 5000)) / 1000;
    const span = secs >= 120 ? `${Math.round(secs / 60)} min` : `${Math.round(secs)} s`;
    return `Network · ${iface || 'no interface'} · last ${span}`;
  }

  // ---------- clock ----------

  function tickClock() {
    const now = new Date();
    $('hp-hh').textContent = pad(now.getHours());
    $('hp-mm').textContent = pad(now.getMinutes());
    $('hp-ss').textContent = pad(now.getSeconds());
    $('hp-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (uptimeBase != null) {
      const up = uptimeBase + Math.floor((Date.now() - uptimeAt) / 1000);
      $('hp-uptime').textContent = `${Math.floor(up / 86400)}d ${pad(Math.floor((up % 86400) / 3600))}h ${pad(Math.floor((up % 3600) / 60))}m`;
    }
  }

  // ---------- public API ----------

  function panelInit() {
    if (location.hash === '#kiosk' || /[?&]kiosk\b/.test(location.search)) {
      document.documentElement.classList.add('kiosk');
    }
    buildDials();
    window.addEventListener('resize', layout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    window.addEventListener('hashchange', () => {
      document.documentElement.classList.toggle('kiosk', location.hash === '#kiosk');
      layout();
    });
    layout();
    tickClock();
    setInterval(tickClock, 1000);
  }

  function renderPanel(sys) {
    lastSys = sys;
    const host = sys.host || {};
    $('hp-host').textContent = host.name || '—';
    $('hp-ip').textContent = host.ip || '—';
    $('hp-os').textContent = host.os || '—';
    $('hp-os').title = host.os || '';
    $('hp-load').textContent = (host.load || []).map((x) => (+x).toFixed(2)).join('  ') || '—';
    if (sys.uptimeSec != null) { uptimeBase = Math.floor(sys.uptimeSec); uptimeAt = Date.now(); }

    const cpu = sys.cpu || {};
    const ghz = cpu.speedGHz ? ` · ${(+cpu.speedGHz).toFixed(1)} GHz` : '';
    setDial(G.cpu, cpu.loadPct, cpu.cores ? `${cpu.cores} ${cpu.cores === 1 ? 'core' : 'cores'}${ghz}` : '');

    const m = sys.memory;
    setDial(G.mem, m && m.usedPct, m ? pair(m.usedBytes, m.totalBytes) : 'unavailable');

    const before = disks.map((d) => d.mount).join('|');
    disks = sys.disks || [];
    if (disks.map((d) => d.mount).join('|') !== before) { diskIndex = 0; restartDiskTimer(); }
    drawDisk();

    const t = sys.temp || {};
    setDial(G.temp, t.c, t.c == null ? 'no sensor found' : t.fanRpm ? `fan ${t.fanRpm} rpm` : '');

    const n = sys.network;
    const rx = mbps(n && n.rxSec), tx = mbps(n && n.txSec);
    push(hist.netRx, rx || 0);
    push(hist.netTx, tx || 0);
    $('hp-netlabel').textContent = netLabel(n && n.iface);
    $('hp-down').textContent = fmtMbps(rx);
    $('hp-up').textContent = fmtMbps(tx);
    drawChart();
    tickClock();
  }

  function healthOf(c) {
    const s = c.status || '';
    if (/\(unhealthy\)/.test(s)) return 'unhealthy';
    if (/\(health: starting\)/.test(s)) return 'starting';
    return null;
  }
  function rank(c) {
    const h = healthOf(c);
    if (h === 'unhealthy') return 0;
    if (c.state === 'restarting') return 1;
    if (h === 'starting' || c.state === 'paused') return 2;
    if (c.state === 'running') return 3;
    return 4;
  }

  function renderPanelContainers(list) {
    const all = list || [];
    const total = all.length;
    const running = all.filter((c) => c.state === 'running').length;
    const stopped = all.filter((c) => ['exited', 'created', 'dead'].includes(c.state)).length;
    const restarting = all.filter((c) => c.state === 'restarting').length;
    const unhealthy = all.filter((c) => healthOf(c) === 'unhealthy').length;

    $('hp-running').innerHTML = `${running}<span>/${total}</span>`;
    const pill = $('hp-health');
    if (!total) { pill.className = 'hp-pill hp-pill--warn'; pill.textContent = 'No containers found'; }
    else if (unhealthy) { pill.className = 'hp-pill hp-pill--bad'; pill.textContent = `${unhealthy} unhealthy`; }
    else if (restarting) { pill.className = 'hp-pill hp-pill--warn'; pill.textContent = `${restarting} restarting`; }
    else if (!running) { pill.className = 'hp-pill hp-pill--warn'; pill.textContent = 'Nothing running'; }
    else { pill.className = 'hp-pill hp-pill--ok'; pill.textContent = 'All healthy'; }

    // rows follow the same show-hidden setting as the cards below; stopped
    // containers are always listed here (they sort last) since a panel that
    // silently drops a crashed container would be hiding the one thing it's for
    const showHidden = typeof settings !== 'undefined' && settings.showHidden;
    const rows = all.filter((c) => showHidden || !c.hidden)
      .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
    const extra = Math.max(0, rows.length - ROW_SLOTS);

    const meta = [`${stopped} stopped`];
    if (restarting) meta.push(`${restarting} restarting`);
    if (extra) meta.push(`+${extra} not shown`);
    $('hp-ctrmeta').textContent = meta.join(' · ');

    const ul = $('hp-ctrs');
    ul.innerHTML = '';
    rows.slice(0, ROW_SLOTS).forEach((c) => {
      const li = document.createElement('li');
      const isRunning = c.state === 'running';
      const h = healthOf(c);
      let dot = 'hp-dot';
      if (h === 'unhealthy') dot += ' hp-dot--bad';
      else if (c.state === 'restarting' || h === 'starting' || c.state === 'paused') dot += ' hp-dot--warn';
      else if (!isRunning) { dot += ' hp-dot--off'; li.className = 'hp-row--stopped'; }

      let cpu = c.state;
      let cpuCls = 'hp-cpu';
      if (isRunning) {
        cpu = c.cpuPct == null ? '…' : c.cpuPct < 1 ? '<1%' : `${Math.round(c.cpuPct)}%`;
        if (c.cpuPct >= 50) cpuCls += ' hp-cpu--bad'; else if (c.cpuPct >= 20) cpuCls += ' hp-cpu--warn';
      }

      li.innerHTML = `<span class="${dot}"></span><span class="hp-name">${escapeHtml(c.displayName)}</span><span class="${cpuCls}">${escapeHtml(cpu)}</span>`;
      li.title = `${c.displayName} — ${c.status || c.state}`;
      ul.appendChild(li);
    });
    if (!rows.length) {
      ul.innerHTML = '<li class="hp-row--empty">No containers to show. Check that docker.sock is mounted.</li>';
    }
  }

  function panelSetLink(ok) {
    const el = $('hp-link');
    const stage = $('hp-stage');
    if (ok) {
      lastOk = Date.now();
      el.className = 'hp-link';
      const secs = (typeof settings !== 'undefined' ? settings.interval : 5000) / 1000;
      el.textContent = `Live · every ${secs}s`;
      stage.classList.remove('hp-stale');
      if (lastSys) $('hp-netlabel').textContent = netLabel(lastSys.network && lastSys.network.iface);
    } else {
      el.className = 'hp-link hp-link--off';
      if (lastOk) {
        const ago = Math.round((Date.now() - lastOk) / 1000);
        el.textContent = `No data for ${ago < 120 ? ago + 's' : Math.round(ago / 60) + 'm'}`;
        stage.classList.add('hp-stale');
      } else {
        el.textContent = 'Connecting';
      }
    }
  }

  window.panelInit = panelInit;
  window.renderPanel = renderPanel;
  window.renderPanelContainers = renderPanelContainers;
  window.panelSetLink = panelSetLink;
})();
