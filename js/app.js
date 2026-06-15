/* 75 Hard Tracker — front-end app
 * Talks to the Google Apps Script backend (config.API_URL). If no URL is set,
 * it falls back to an OFFLINE demo mode backed by localStorage so the UI is
 * still fully usable on your phone.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG;
  var LEN = CFG.CHALLENGE_LENGTH;
  var WATER_GOAL = CFG.WATER_GOAL_OZ;
  var GLASS = CFG.GLASS_OZ;
  var GLASS_COUNT = Math.round(WATER_GOAL / GLASS);
  var OFFLINE = !CFG.API_URL;

  var TASKS = [
    { key: 'workout1',  emoji: '🏋️', title: 'Workout 1',           sub: '45 minutes' },
    { key: 'workout2',  emoji: '🏃', title: 'Workout 2',           sub: '45 minutes' },
    { key: 'outdoor',   emoji: '🌳', title: 'One workout outdoors', sub: 'Rain or shine' },
    { key: 'reading',   emoji: '📖', title: 'Read 10 pages',        sub: 'Non-fiction / self-help' },
    { key: 'photo',     emoji: '📸', title: 'Progress photo',       sub: 'Snap it today' },
    { key: 'diet',      emoji: '🥗', title: 'Follow your diet',     sub: 'No cheat meals' },
    { key: 'noAlcohol', emoji: '🚫', title: 'No alcohol',           sub: 'Zero, none' }
  ];
  var TOTAL_ITEMS = TASKS.length + 1; // + water

  /* ---------------- state ---------------- */
  var state = {
    token: localStorage.getItem('hard_token') || '',
    username: localStorage.getItem('hard_user') || '',
    user: null,
    logs: [],
    today: null,
    saveTimer: null
  };

  /* ---------------- DOM helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function show(s) { $(s).classList.remove('hidden'); }
  function hide(s) { $(s).classList.add('hidden'); }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); t.classList.remove('show'); }, 2200);
  }

  /* ---------------- date helpers ---------------- */
  function todayStr() { return fmt(new Date()); }
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) {
    var p = String(s).slice(0, 10).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(s, n) {
    var d = parse(s); d.setDate(d.getDate() + n); return fmt(d);
  }
  function dayNumber(startDate, date) {
    var diff = Math.floor((parse(date) - parse(startDate)) / 86400000) + 1;
    return diff < 1 ? 0 : diff;
  }
  function prettyDate(s) {
    return parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /* ---------------- API ---------------- */
  function api(action, payload) {
    payload = payload || {};
    payload.action = action;
    if (state.token) { payload.token = state.token; payload.username = state.username; }
    if (OFFLINE) return Promise.resolve(offlineApi(action, payload));

    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Request failed');
        return res.data;
      });
  }

  /* ---------------- Offline backend (localStorage) ---------------- */
  function db() { return JSON.parse(localStorage.getItem('hard_demo') || '{"users":{},"logs":{}}'); }
  function saveDb(d) { localStorage.setItem('hard_demo', JSON.stringify(d)); }

  function offlineApi(action, p) {
    var d = db();
    function pub(u) {
      return { username: u.username, displayName: u.displayName, startDate: u.startDate,
        currentDay: dayNumber(u.startDate, todayStr()), challengeLength: LEN, waterGoalOz: WATER_GOAL };
    }
    function userLogs(un) { return (d.logs[un] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }

    if (action === 'register') {
      var un = (p.username || '').toLowerCase().trim();
      if (un.length < 3) throw new Error('Username must be at least 3 characters.');
      if (d.users[un]) throw new Error('That username is already taken.');
      d.users[un] = { username: un, displayName: p.displayName || un, password: p.password,
        startDate: p.startDate || todayStr(), token: 't_' + un };
      d.logs[un] = []; saveDb(d);
      return { token: 't_' + un, user: pub(d.users[un]) };
    }
    if (action === 'login') {
      var lu = d.users[(p.username || '').toLowerCase().trim()];
      if (!lu || lu.password !== p.password) throw new Error('Invalid username or password.');
      return { token: lu.token, user: pub(lu) };
    }
    var me = d.users[(p.username || '').toLowerCase().trim()];
    if (!me || me.token !== p.token) throw new Error('Session expired. Please log in again.');

    if (action === 'getState') return { user: pub(me), logs: userLogs(me.username) };
    if (action === 'saveDay') {
      var day = p.day; day.completed = isComplete(day);
      var arr = d.logs[me.username] || (d.logs[me.username] = []);
      var i = arr.findIndex(function (l) { return l.date === day.date; });
      if (i >= 0) arr[i] = day; else arr.push(day);
      saveDb(d); return { day: day };
    }
    if (action === 'reset') {
      me.startDate = p.startDate || todayStr(); saveDb(d);
      return { user: pub(me), logs: userLogs(me.username) };
    }
    if (action === 'updateProfile') {
      me.displayName = p.displayName || me.displayName; saveDb(d); return { user: pub(me) };
    }
    if (action === 'leaderboard') {
      var board = Object.keys(d.users).map(function (k) {
        var u = d.users[k], lg = userLogs(k);
        return { displayName: u.displayName, currentDay: dayNumber(u.startDate, todayStr()),
          completedDays: lg.filter(function (x) { return x.completed; }).length, streak: streakOf(lg) };
      }).sort(function (a, b) { return b.completedDays - a.completedDays; });
      return { leaderboard: board };
    }
    throw new Error('Unknown action');
  }

  /* ---------------- domain helpers ---------------- */
  function isComplete(d) {
    return d.workout1 && d.workout2 && d.outdoor && d.reading &&
           d.photo && d.diet && d.noAlcohol && (Number(d.waterOz) >= WATER_GOAL);
  }
  function completedCount(d) {
    var c = 0;
    TASKS.forEach(function (t) { if (d[t.key]) c++; });
    if (Number(d.waterOz) >= WATER_GOAL) c++;
    return c;
  }
  function streakOf(logs) {
    var s = 0;
    for (var i = logs.length - 1; i >= 0; i--) { if (logs[i].completed) s++; else break; }
    return s;
  }
  function emptyDay(date) {
    return { date: date, dayNumber: state.user ? dayNumber(state.user.startDate, date) : 1,
      workout1: false, workout2: false, outdoor: false, waterOz: 0,
      reading: false, photo: false, diet: false, noAlcohol: false, completed: false, notes: '' };
  }
  function logFor(date) {
    return state.logs.filter(function (l) { return l.date === date; })[0];
  }

  /* ---------------- Auth UI ---------------- */
  function initAuth() {
    var di = $('#register-form [name=startDate]');
    if (di) di.value = todayStr();
    if (OFFLINE) $('.offline-note').classList.remove('hidden');

    document.querySelectorAll('[data-authtab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-authtab]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var login = b.dataset.authtab === 'login';
        $('#login-form').classList.toggle('hidden', !login);
        $('#register-form').classList.toggle('hidden', login);
        authMsg('');
      });
    });

    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      authSubmit('login', { username: f.username.value, password: f.password.value }, 'Logging in…');
    });
    $('#register-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      authSubmit('register', {
        username: f.username.value, password: f.password.value,
        displayName: f.displayName.value, startDate: f.startDate.value
      }, 'Setting up…');
    });
  }

  function authMsg(msg, cls) {
    var m = $('#auth-msg');
    m.textContent = msg || '';
    m.className = 'form-msg' + (cls ? ' ' + cls : '');
  }

  function authSubmit(action, payload, busy) {
    authMsg(busy);
    api(action, payload).then(function (data) {
      state.token = data.token; state.username = data.user.username; state.user = data.user;
      localStorage.setItem('hard_token', state.token);
      localStorage.setItem('hard_user', state.username);
      authMsg('');
      return loadState();
    }).then(enterApp).catch(function (err) { authMsg(err.message, 'error'); });
  }

  /* ---------------- App boot ---------------- */
  function loadState() {
    return api('getState', {}).then(function (data) {
      state.user = data.user;
      state.logs = data.logs || [];
      var t = logFor(todayStr());
      state.today = t ? Object.assign(emptyDay(todayStr()), t) : emptyDay(todayStr());
      cacheState();
    });
  }
  function cacheState() {
    localStorage.setItem('hard_cache', JSON.stringify({ user: state.user, logs: state.logs }));
  }

  function enterApp() {
    hide('#auth-screen'); show('#app-screen');
    $('#set-version').textContent = '75 Hard Tracker v' + CFG.APP_VERSION + (OFFLINE ? ' · demo mode' : '');
    bindAppEvents();
    renderAll();
    switchView('today');
  }

  function bindAppEvents() {
    if (bindAppEvents.done) return; bindAppEvents.done = true;
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.dataset.view); });
    });
    $('#sync-state').addEventListener('click', function () {
      loadState().then(renderAll).then(function () { toast('Synced'); });
    });
    $('#save-day').addEventListener('click', function () { pushToday(true); });
    $('#day-notes').addEventListener('input', function () {
      state.today.notes = this.value; queueSave();
    });
    $('#logout').addEventListener('click', logout);
    $('#reset-challenge').addEventListener('click', resetChallenge);
    $('#save-profile').addEventListener('click', saveProfile);
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (name === 'calendar') renderCalendar();
    if (name === 'stats') renderStats();
    if (name === 'board') renderBoard();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  /* ---------------- Render: header + today ---------------- */
  function renderAll() {
    $('#hdr-name').textContent = firstName(state.user.displayName);
    $('#hdr-day').textContent = Math.max(1, state.user.currentDay);
    renderToday();
  }
  function firstName(n) { return String(n || 'athlete').split(' ')[0]; }

  function renderToday() {
    var d = state.today;
    $('#today-date').textContent = prettyDate(d.date);
    $('#day-notes').value = d.notes || '';

    // tasks
    var list = $('#tasklist');
    list.innerHTML = '';
    TASKS.forEach(function (t) {
      var done = !!d[t.key];
      var row = el('div', 'task' + (done ? ' done' : ''));
      row.innerHTML =
        '<div class="check">✓</div>' +
        '<div class="t-emoji">' + t.emoji + '</div>' +
        '<div class="t-body"><div class="t-title">' + t.title + '</div>' +
        '<div class="t-sub">' + t.sub + '</div></div>';
      row.addEventListener('click', function () { toggleTask(t.key); });
      list.appendChild(row);
    });
    // water
    list.appendChild(renderWater(d));

    // ring / status
    var count = completedCount(d);
    var pct = Math.round((count / TOTAL_ITEMS) * 100);
    var ring = $('#ring-fg');
    var circ = 2 * Math.PI * 52;
    ring.style.strokeDashoffset = circ * (1 - count / TOTAL_ITEMS);
    ring.style.stroke = count === TOTAL_ITEMS ? 'var(--green)' : 'var(--primary)';
    $('#ring-pct').textContent = pct + '%';

    var st = $('#today-status');
    if (count === TOTAL_ITEMS) { st.textContent = 'Day complete! 🎉'; st.className = 'status-chip done'; }
    else { st.textContent = count + ' / ' + TOTAL_ITEMS + ' done'; st.className = 'status-chip pending'; }

    $('#streak-line').textContent = '🔥 ' + streakOf(state.logs) + ' day streak';
  }

  function renderWater(d) {
    var wrap = el('div', 'task water-task');
    var oz = Number(d.waterOz) || 0;
    var goalMet = oz >= WATER_GOAL;
    wrap.innerHTML =
      '<div class="water-head">' +
        '<div class="check"' + (goalMet ? ' style="background:#4aa8ff;border-color:#4aa8ff;color:#04223f"' : '') + '>✓</div>' +
        '<div class="t-emoji">💧</div>' +
        '<div class="t-body"><div class="t-title">Drink 1 gallon</div>' +
        '<div class="t-sub">Tap a glass each time you drink (' + GLASS + ' oz each)</div></div>' +
      '</div>';
    var glasses = el('div', 'glasses');
    var filled = Math.round(oz / GLASS);
    for (var i = 0; i < GLASS_COUNT; i++) {
      var g = el('div', 'glass' + (i < filled ? ' full' : ''));
      (function (idx) {
        g.addEventListener('click', function () {
          // tapping a glass sets the level to that glass (toggle last one off)
          var newFilled = (idx + 1 === filled) ? idx : idx + 1;
          state.today.waterOz = newFilled * GLASS;
          renderToday(); queueSave();
        });
      })(i);
      glasses.appendChild(g);
    }
    wrap.appendChild(glasses);
    var amt = el('div', 'water-amount');
    amt.innerHTML = '<b>' + oz + ' oz</b> / ' + WATER_GOAL + ' oz';
    wrap.appendChild(amt);
    return wrap;
  }

  function toggleTask(key) {
    state.today[key] = !state.today[key];
    renderToday();
    queueSave();
  }

  /* ---------------- Saving ---------------- */
  function queueSave() {
    state.today.completed = isComplete(state.today);
    upsertLocal(state.today);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { pushToday(false); }, 700);
  }
  function upsertLocal(day) {
    var i = state.logs.findIndex(function (l) { return l.date === day.date; });
    var copy = Object.assign({}, day);
    if (i >= 0) state.logs[i] = copy; else state.logs.push(copy);
    cacheState();
  }
  function pushToday(announce) {
    state.today.completed = isComplete(state.today);
    api('saveDay', { day: state.today }).then(function () {
      if (announce) toast(state.today.completed ? 'Day complete — beast! 🔥' : 'Saved ✓');
    }).catch(function (err) {
      toast('Saved locally · ' + err.message);
    });
  }

  /* ---------------- Calendar ---------------- */
  function renderCalendar() {
    var grid = $('#calendar-grid');
    grid.innerHTML = '';
    var today = todayStr();
    for (var n = 1; n <= LEN; n++) {
      var date = addDays(state.user.startDate, n - 1);
      var log = logFor(date);
      var cell = el('div', 'cal-cell');
      cell.textContent = n;
      if (date === today) cell.classList.add('today');
      if (log && log.completed) cell.classList.add('done');
      else if (date < today) cell.classList.add('miss');
      cell.title = prettyDate(date);
      grid.appendChild(cell);
    }
  }

  /* ---------------- Stats ---------------- */
  function renderStats() {
    var logs = state.logs;
    var done = logs.filter(function (l) { return l.completed; }).length;
    var curDay = Math.max(1, state.user.currentDay);
    var remaining = Math.max(0, LEN - curDay + (state.user.currentDay > 0 ? 0 : 0));
    var totalWater = logs.reduce(function (s, l) { return s + (Number(l.waterOz) || 0); }, 0);
    var gallons = (totalWater / WATER_GOAL).toFixed(1);
    var best = bestStreak(logs);

    var grid = $('#stats-grid');
    grid.innerHTML = '';
    [
      ['Current day', Math.min(curDay, LEN) + ' / ' + LEN],
      ['Days completed', done],
      ['Current streak', streakOf(logs) + '🔥'],
      ['Best streak', best],
      ['Days left', Math.max(0, LEN - Math.min(curDay, LEN))],
      ['Water drank', gallons + ' gal']
    ].forEach(function (s) {
      var c = el('div', 'stat');
      c.innerHTML = '<div class="num">' + s[1] + '</div><div class="lbl">' + s[0] + '</div>';
      grid.appendChild(c);
    });

    // per-task consistency over elapsed days
    var elapsed = logs.length || 1;
    var bars = $('#task-bars');
    bars.innerHTML = '';
    var defs = TASKS.concat([{ key: '__water', title: '💧 1 gallon water' }]);
    defs.forEach(function (t) {
      var hit = logs.filter(function (l) {
        return t.key === '__water' ? Number(l.waterOz) >= WATER_GOAL : l[t.key];
      }).length;
      var pct = Math.round((hit / elapsed) * 100);
      var row = el('div', 'bar-row');
      var label = t.emoji ? (t.emoji + ' ' + t.title) : t.title;
      row.innerHTML = '<div class="bl"><span>' + label + '</span><span>' + pct + '%</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      bars.appendChild(row);
    });
  }
  function bestStreak(logs) {
    var best = 0, cur = 0;
    logs.forEach(function (l) { if (l.completed) { cur++; best = Math.max(best, cur); } else cur = 0; });
    return best;
  }

  /* ---------------- Leaderboard ---------------- */
  function renderBoard() {
    var box = $('#leaderboard');
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('leaderboard', {}).then(function (data) {
      var list = data.leaderboard || [];
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="muted">No athletes yet.</p>'; return; }
      list.forEach(function (u, i) {
        var mine = u.displayName === state.user.displayName;
        var medal = ['🥇', '🥈', '🥉'][i] || (i + 1);
        var row = el('div', 'lb-row' + (mine ? ' me' : ''));
        row.innerHTML =
          '<div class="lb-rank">' + medal + '</div>' +
          '<div class="lb-name">' + esc(u.displayName) + (mine ? ' (you)' : '') +
            '<small>Day ' + Math.min(u.currentDay, LEN) + ' · 🔥 ' + u.streak + ' streak</small></div>' +
          '<div class="lb-stat"><b>' + u.completedDays + '</b><div class="muted tiny">days done</div></div>';
        box.appendChild(row);
      });
    }).catch(function (err) { box.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    $('#set-displayname').value = state.user.displayName;
    $('#set-username').textContent = state.user.username;
  }
  function saveProfile() {
    var name = $('#set-displayname').value.trim();
    if (!name) return;
    api('updateProfile', { displayName: name }).then(function (data) {
      state.user = data.user; cacheState(); renderAll(); toast('Name saved');
    }).catch(function (e) { toast(e.message); });
  }
  function resetChallenge() {
    if (!confirm('Restart from Day 1? Your start date moves to today. This is what 75 Hard requires after a miss.')) return;
    api('reset', { startDate: todayStr() }).then(function (data) {
      state.user = data.user; state.logs = data.logs || [];
      state.today = emptyDay(todayStr()); cacheState();
      renderAll(); switchView('today'); toast('Fresh start — Day 1. Go.');
    }).catch(function (e) { toast(e.message); });
  }
  function logout() {
    localStorage.removeItem('hard_token');
    localStorage.removeItem('hard_user');
    localStorage.removeItem('hard_cache');
    state.token = ''; state.username = ''; state.user = null; state.logs = [];
    location.reload();
  }

  /* ---------------- Start ---------------- */
  function boot() {
    initAuth();
    var splash = $('#splash');
    setTimeout(function () { splash.classList.add('fade'); }, 600);

    if (state.token && state.username) {
      // optimistic: show cached immediately, then refresh
      var cache = JSON.parse(localStorage.getItem('hard_cache') || 'null');
      if (cache && cache.user) {
        state.user = cache.user; state.logs = cache.logs || [];
        state.today = Object.assign(emptyDay(todayStr()), logFor(todayStr()) || {});
        enterApp();
      }
      loadState().then(function () { if (state.user) { if (!cache) enterApp(); renderAll(); } })
        .catch(function () { if (!cache) showAuth(); });
    } else {
      showAuth();
    }
  }
  function showAuth() { show('#auth-screen'); }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
