/* 75 Hard Tracker — front-end app
 * Talks to the Google Apps Script backend (config.API_URL). If no URL is set,
 * it falls back to an OFFLINE demo mode backed by localStorage so the UI is
 * still fully usable on your phone.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG;
  var LEN = CFG.CHALLENGE_LENGTH;
  var WATER_GOAL = CFG.WATER_GOAL_ML;
  var GLASS = CFG.GLASS_ML;
  var GLASS_COUNT = Math.round(WATER_GOAL / GLASS);
  var OFFLINE = !CFG.API_URL;

  var TASKS = [
    { key: 'workout1',  emoji: '🏋️', title: 'Indoor workout',  sub: '45 minutes' },
    { key: 'outdoor',   emoji: '🌳', title: 'Outdoor workout', sub: '45 minutes · rain or shine' },
    { key: 'reading',   emoji: '📖', title: 'Read 10 pages',    sub: 'Non-fiction / self-help' },
    { key: 'photo',     emoji: '📸', title: 'Progress photo',   sub: 'Snap it today' },
    { key: 'diet',      emoji: '🥗', title: 'Follow your diet', sub: 'No cheat meals' },
    { key: 'noAlcohol', emoji: '🚫', title: 'No alcohol',       sub: 'Zero, none' }
  ];
  var TOTAL_ITEMS = TASKS.length + 1; // + water

  /* ---------------- state ---------------- */
  var state = {
    token: localStorage.getItem('hard_token') || '',
    username: localStorage.getItem('hard_user') || '',
    user: null,
    logs: [],
    today: null,
    profile: {},
    foods: [],
    foodsDate: null,
    pendingFood: null,
    activeFast: null,
    fastTimer: null,
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
        currentDay: dayNumber(u.startDate, todayStr()), challengeLength: LEN, waterGoalMl: WATER_GOAL };
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

    function myFasts() { return (d.fasts && d.fasts[me.username]) || []; }
    function activeFast() { return myFasts().filter(function (f) { return !f.endAt; })[0] || null; }

    if (action === 'getState') return { user: pub(me), logs: userLogs(me.username), profile: d.profiles && d.profiles[me.username] || {}, activeFast: activeFast() };
    if (action === 'startFast') {
      var ex = activeFast(); if (ex) return { fast: ex };
      d.fasts = d.fasts || {}; var fa = d.fasts[me.username] || (d.fasts[me.username] = []);
      var nf = { id: 'fa_' + Date.now(), startAt: p.startAt || new Date().toISOString(), endAt: '', goalHours: Number(p.goalHours) || 16 };
      fa.push(nf); saveDb(d); return { fast: nf };
    }
    if (action === 'endFast') {
      var act = activeFast(); if (act) { act.endAt = new Date().toISOString(); saveDb(d); }
      return { fast: act || null };
    }
    if (action === 'getFasts') {
      var done = myFasts().filter(function (f) { return f.endAt; }).sort(function (a, b) { return a.startAt < b.startAt ? 1 : -1; });
      return { active: activeFast(), fasts: done.slice(0, 30) };
    }
    if (action === 'updateFast') {
      var fu = myFasts().filter(function (f) { return f.id === p.id; })[0];
      if (fu) { if (p.startAt) fu.startAt = p.startAt; if (p.endAt != null) fu.endAt = p.endAt; saveDb(d); }
      return { fast: fu || null };
    }
    if (action === 'deleteFast') {
      if (d.fasts && d.fasts[me.username]) {
        d.fasts[me.username] = d.fasts[me.username].filter(function (f) { return f.id !== p.id; });
        saveDb(d);
      }
      return { deleted: p.id };
    }
    if (action === 'saveGoals') {
      d.profiles = d.profiles || {}; d.profiles[me.username] = p.profile || {}; saveDb(d);
      return { profile: d.profiles[me.username] };
    }
    if (action === 'getFood') {
      var all = (d.foods && d.foods[me.username]) || [];
      return { foods: all.filter(function (x) { return x.date === (p.date || todayStr()); }) };
    }
    if (action === 'addFood') {
      d.foods = d.foods || {}; var arr = d.foods[me.username] || (d.foods[me.username] = []);
      var rec = p.food; rec.id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      arr.push(rec); saveDb(d); return { food: rec };
    }
    if (action === 'deleteFood') {
      if (d.foods && d.foods[me.username]) {
        d.foods[me.username] = d.foods[me.username].filter(function (x) { return x.id !== p.id; });
        saveDb(d);
      }
      return { deleted: p.id };
    }
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
      var today = todayStr();
      var board = Object.keys(d.users).map(function (k) {
        var u = d.users[k], lg = userLogs(k);
        var tl = lg.filter(function (x) { return x.date === today; })[0];
        var done = 0;
        if (tl) {
          ['workout1', 'outdoor', 'reading', 'photo', 'diet', 'noAlcohol'].forEach(function (key) { if (tl[key]) done++; });
          if (Number(tl.waterMl) >= WATER_GOAL) done++;
        }
        var cals = ((d.foods && d.foods[k]) || []).filter(function (x) { return x.date === today; })
          .reduce(function (s, x) { return s + (Number(x.calories) || 0); }, 0);
        return {
          displayName: u.displayName, currentDay: dayNumber(u.startDate, today),
          completedDays: lg.filter(function (x) { return x.completed; }).length, streak: streakOf(lg),
          todayDone: done, todayTotal: TOTAL_ITEMS, todayComplete: tl ? !!tl.completed : false,
          todayWaterMl: tl ? (Number(tl.waterMl) || 0) : 0,
          todayCalories: Math.round(cals),
          calorieGoal: (d.profiles && d.profiles[k] && d.profiles[k].calorieGoal) || 0
        };
      }).sort(function (a, b) { return b.completedDays - a.completedDays || b.todayDone - a.todayDone; });
      return { leaderboard: board };
    }
    throw new Error('Unknown action');
  }

  /* ---------------- domain helpers ---------------- */
  function isComplete(d) {
    return d.workout1 && d.outdoor && d.reading &&
           d.photo && d.diet && d.noAlcohol && (Number(d.waterMl) >= WATER_GOAL);
  }
  function completedCount(d) {
    var c = 0;
    TASKS.forEach(function (t) { if (d[t.key]) c++; });
    if (Number(d.waterMl) >= WATER_GOAL) c++;
    return c;
  }
  function streakOf(logs) {
    var s = 0;
    for (var i = logs.length - 1; i >= 0; i--) { if (logs[i].completed) s++; else break; }
    return s;
  }
  function emptyDay(date) {
    return { date: date, dayNumber: state.user ? dayNumber(state.user.startDate, date) : 1,
      workout1: false, workout2: false, outdoor: false, waterMl: 0,
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
      state.profile = data.profile || {};
      state.activeFast = data.activeFast || null;
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
    bindDietEvents();
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (name !== 'diet') stopFastTimer();
    if (name === 'diet') renderDiet();
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

  function litres(ml) {
    return (ml / 1000).toFixed(1).replace(/\.0$/, '');
  }

  function renderWater(d) {
    var wrap = el('div', 'task water-task');
    var ml = Number(d.waterMl) || 0;
    var goalMet = ml >= WATER_GOAL;
    wrap.innerHTML =
      '<div class="water-head">' +
        '<div class="check"' + (goalMet ? ' style="background:#4aa8ff;border-color:#4aa8ff;color:#04223f"' : '') + '>✓</div>' +
        '<div class="t-emoji">💧</div>' +
        '<div class="t-body"><div class="t-title">Drink ' + litres(WATER_GOAL) + ' L of water</div>' +
        '<div class="t-sub">Tap a glass each time you drink (' + GLASS + ' ml each)</div></div>' +
      '</div>';
    var glasses = el('div', 'glasses');
    var filled = Math.round(ml / GLASS);
    for (var i = 0; i < GLASS_COUNT; i++) {
      var g = el('div', 'glass' + (i < filled ? ' full' : ''));
      (function (idx) {
        g.addEventListener('click', function () {
          // tapping a glass sets the level to that glass (toggle last one off)
          var newFilled = (idx + 1 === filled) ? idx : idx + 1;
          state.today.waterMl = newFilled * GLASS;
          renderToday(); queueSave();
        });
      })(i);
      glasses.appendChild(g);
    }
    wrap.appendChild(glasses);
    var amt = el('div', 'water-amount');
    amt.innerHTML = '<b>' + litres(ml) + ' L</b> / ' + litres(WATER_GOAL) + ' L';
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
    renderStatsBody('…');
    api('getFasts', {}).then(function (data) {
      renderStatsBody(avgFastLabel(data.fasts || []));
    }).catch(function () { renderStatsBody('—'); });
  }

  function avgFastLabel(fasts) {
    var done = (fasts || []).filter(function (f) { return f.endAt; });
    if (!done.length) return '—';
    var avg = done.reduce(function (s, f) {
      return s + (new Date(f.endAt).getTime() - new Date(f.startAt).getTime());
    }, 0) / done.length;
    return Math.floor(avg / 3600000) + 'h ' + Math.floor((avg % 3600000) / 60000) + 'm';
  }

  function renderStatsBody(avgFast) {
    var logs = state.logs;
    var done = logs.filter(function (l) { return l.completed; }).length;
    var curDay = Math.max(1, state.user.currentDay);
    var totalWater = logs.reduce(function (s, l) { return s + (Number(l.waterMl) || 0); }, 0);
    var totalLitres = Math.round(totalWater / 1000);
    var best = bestStreak(logs);

    var grid = $('#stats-grid');
    grid.innerHTML = '';
    [
      ['Current day', Math.min(curDay, LEN) + ' / ' + LEN],
      ['Days completed', done],
      ['Current streak', streakOf(logs) + '🔥'],
      ['Best streak', best],
      ['Water drank', totalLitres + ' L'],
      ['Avg fast', avgFast]
    ].forEach(function (s) {
      var c = el('div', 'stat');
      c.innerHTML = '<div class="num">' + s[1] + '</div><div class="lbl">' + s[0] + '</div>';
      grid.appendChild(c);
    });

    // per-task consistency over elapsed days
    var elapsed = logs.length || 1;
    var bars = $('#task-bars');
    bars.innerHTML = '';
    var defs = TASKS.concat([{ key: '__water', title: '💧 Water goal' }]);
    defs.forEach(function (t) {
      var hit = logs.filter(function (l) {
        return t.key === '__water' ? Number(l.waterMl) >= WATER_GOAL : l[t.key];
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

  /* ---------------- Friends ---------------- */
  function renderBoard() {
    var box = $('#leaderboard');
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('leaderboard', {}).then(function (data) {
      var list = data.leaderboard || [];
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="muted">No athletes yet.</p>'; return; }
      list.forEach(function (u, i) {
        var mine = u.displayName === state.user.displayName;
        var medal = ['🥇', '🥈', '🥉'][i] || ('#' + (i + 1));
        var done = u.todayDone || 0, total = u.todayTotal || 8;
        var pending = Math.max(0, total - done);
        var pct = Math.round(done / total * 100);
        var water = litres(u.todayWaterMl || 0) + ' L';
        var cal = Math.round(u.todayCalories || 0);
        var calStr = u.calorieGoal ? (cal + ' / ' + u.calorieGoal) : ('' + cal);
        var badge = u.todayComplete
          ? '<span class="fc-badge done">Day done ✓</span>'
          : '<span class="fc-badge pend">' + pending + ' left</span>';
        var card = el('div', 'friend-card' + (mine ? ' me' : ''));
        card.innerHTML =
          '<div class="fc-top">' +
            '<div class="fc-rank">' + medal + '</div>' +
            '<div class="fc-name">' + esc(u.displayName) + (mine ? ' <span class="muted">(you)</span>' : '') +
              '<small>Day ' + Math.min(u.currentDay, LEN) + ' · 🔥 ' + u.streak + ' · ' + u.completedDays + ' days done</small></div>' +
            badge +
          '</div>' +
          '<div class="fc-bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="fc-stats">' +
            '<span>✅ <b>' + done + '/' + total + '</b> tasks</span>' +
            '<span>💧 <b>' + water + '</b></span>' +
            '<span>🍽️ <b>' + calStr + '</b> kcal</span>' +
          '</div>';
        box.appendChild(card);
      });
    }).catch(function (err) { box.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    $('#set-displayname').value = state.user.displayName;
    $('#set-username').textContent = state.user.username;
    prefillGoals();
    renderThemes();
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

  /* ---------------- Diet & calories ---------------- */
  // Per 100 g unless the item is naturally counted per piece (then grams = avg weight).
  var COMMON_FOODS = [
    { name: 'White rice (cooked)', kcal: 130, p: 2.7, c: 28, f: 0.3, serving: 150 },
    { name: 'Roti / Chapati', kcal: 297, p: 11, c: 50, f: 7, serving: 40 },
    { name: 'Dal (cooked)', kcal: 116, p: 7, c: 17, f: 1.5, serving: 150 },
    { name: 'Paneer', kcal: 296, p: 18, c: 4, f: 22, serving: 50 },
    { name: 'Chicken breast (cooked)', kcal: 165, p: 31, c: 0, f: 3.6, serving: 120 },
    { name: 'Egg (whole)', kcal: 155, p: 13, c: 1.1, f: 11, serving: 50 },
    { name: 'Milk (full fat)', kcal: 61, p: 3.2, c: 4.8, f: 3.3, serving: 200 },
    { name: 'Curd / Yogurt', kcal: 98, p: 11, c: 3.4, f: 4.3, serving: 150 },
    { name: 'Oats (dry)', kcal: 389, p: 17, c: 66, f: 7, serving: 40 },
    { name: 'Banana', kcal: 89, p: 1.1, c: 23, f: 0.3, serving: 120 },
    { name: 'Apple', kcal: 52, p: 0.3, c: 14, f: 0.2, serving: 180 },
    { name: 'Peanut butter', kcal: 588, p: 25, c: 20, f: 50, serving: 20 },
    { name: 'Almonds', kcal: 579, p: 21, c: 22, f: 50, serving: 28 },
    { name: 'Whey protein (scoop)', kcal: 400, p: 80, c: 8, f: 6, serving: 30 },
    { name: 'Bread (white slice)', kcal: 265, p: 9, c: 49, f: 3.2, serving: 30 },
    { name: 'Potato (boiled)', kcal: 87, p: 1.9, c: 20, f: 0.1, serving: 150 },
    { name: 'Chicken curry', kcal: 180, p: 14, c: 6, f: 11, serving: 200 },
    { name: 'Fish (cooked)', kcal: 206, p: 22, c: 0, f: 12, serving: 120 },
    { name: 'Mixed vegetables', kcal: 65, p: 2.6, c: 13, f: 0.4, serving: 150 },
    { name: 'Olive oil', kcal: 884, p: 0, c: 0, f: 100, serving: 10 }
  ];

  function dietGoals() {
    var p = state.profile || {};
    return {
      cal: Number(p.calorieGoal) || 0,
      protein: Number(p.proteinGoal) || 0,
      carbs: Number(p.carbGoal) || 0,
      fat: Number(p.fatGoal) || 0
    };
  }

  function loadFoods(date) {
    return api('getFood', { date: date }).then(function (data) {
      state.foods = data.foods || [];
      state.foodsDate = date;
    });
  }

  function renderDiet() {
    var date = todayStr();
    if (state.foodsDate !== date) {
      $('#meals').innerHTML = '<p class="muted tiny center">Loading…</p>';
      loadFoods(date).then(renderDietBody).catch(function (e) {
        $('#meals').innerHTML = '<p class="muted tiny center">' + esc(e.message) + '</p>';
      });
    } else {
      renderDietBody();
    }
    renderFasting();
  }

  /* ----- Intermittent fasting ----- */
  // Milestones (hours). The "mark" you earn is the highest one you reach.
  var MILESTONES = [12, 14, 16, 18, 20, 24, 36];

  function stopFastTimer() { if (state.fastTimer) { clearInterval(state.fastTimer); state.fastTimer = null; } }

  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }
  function durLabel(ms) {
    if (ms < 0) ms = 0;
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h + 'h ' + m + 'm';
  }
  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function milestoneInfo(hours) {
    var reached = 0, next = null;
    for (var i = 0; i < MILESTONES.length; i++) {
      if (hours >= MILESTONES[i]) reached = MILESTONES[i];
      else { next = MILESTONES[i]; break; }
    }
    return { reached: reached, next: next };
  }
  // datetime-local <-> ISO helpers (local time)
  function toLocalInput(iso) {
    var x = new Date(iso);
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) +
      'T' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  }
  function fromLocalInput(v) { return new Date(v).toISOString(); }

  function renderFasting() {
    stopFastTimer();
    var box = $('#fasting');
    if (!box) return;
    var f = state.activeFast;

    if (f) {
      box.innerHTML =
        '<div class="card fast-card active">' +
          '<div class="fast-head"><span class="fast-title">⏳ Fasting</span>' +
            '<span id="fast-mark" class="fast-mark">—</span></div>' +
          '<div class="fast-ring-wrap">' +
            '<svg viewBox="0 0 120 120" class="ring"><circle class="ring-bg" cx="60" cy="60" r="52"></circle>' +
            '<circle id="fast-ring" class="ring-fg" cx="60" cy="60" r="52"></circle></svg>' +
            '<div class="fast-center"><div id="fast-elapsed" class="fast-elapsed">00:00:00</div>' +
            '<div id="fast-state" class="muted tiny">elapsed</div></div>' +
          '</div>' +
          '<div class="fast-times"><span>Started <b id="fast-started">' + clockTime(f.startAt) + '</b></span>' +
            '<button id="fast-edit-start" class="link-btn">Edit start</button></div>' +
          '<div id="fast-edit-box" class="fast-edit-box hidden">' +
            '<label>Start time<input type="datetime-local" id="fast-start-edit"></label>' +
            '<div class="row-2"><button id="fast-save-start" class="btn primary">Save</button>' +
            '<button id="fast-cancel-start" class="btn">Cancel</button></div></div>' +
          '<button id="fast-end" class="btn danger block">End fast</button>' +
        '</div>';
      $('#fast-end').addEventListener('click', endFast);
      $('#fast-edit-start').addEventListener('click', function () {
        $('#fast-start-edit').value = toLocalInput(f.startAt);
        $('#fast-edit-box').classList.toggle('hidden');
      });
      $('#fast-cancel-start').addEventListener('click', function () { $('#fast-edit-box').classList.add('hidden'); });
      $('#fast-save-start').addEventListener('click', function () {
        var v = $('#fast-start-edit').value; if (!v) return;
        if (new Date(v).getTime() > Date.now()) { toast('Start time can’t be in the future'); return; }
        api('updateFast', { id: f.id, startAt: fromLocalInput(v) }).then(function (data) {
          state.activeFast = data.fast; renderFasting(); toast('Start time updated ✓');
        }).catch(function (e) { toast(e.message); });
      });
      updateFastTimer();
      state.fastTimer = setInterval(updateFastTimer, 1000);
    } else {
      box.innerHTML =
        '<div class="card fast-card">' +
          '<div class="fast-head"><span class="fast-title">⏳ Intermittent fasting</span></div>' +
          '<p class="muted tiny">Start a fast — the timer counts up and logs the milestone you reach when you end it. Adjust the start time if you began earlier.</p>' +
          '<label>Start time<input type="datetime-local" id="fast-start-input"></label>' +
          '<button id="fast-start" class="btn primary block">Start fast</button>' +
          '<div id="fast-history" class="fast-history"></div>' +
        '</div>';
      $('#fast-start-input').value = toLocalInput(new Date().toISOString());
      $('#fast-start').addEventListener('click', function () {
        var v = $('#fast-start-input').value;
        if (v && new Date(v).getTime() > Date.now()) { toast('Start time can’t be in the future'); return; }
        startFast(v ? fromLocalInput(v) : new Date().toISOString());
      });
      loadFastHistory();
    }
  }

  function updateFastTimer() {
    var f = state.activeFast; if (!f) { stopFastTimer(); return; }
    var elapsed = Date.now() - new Date(f.startAt).getTime();
    var hours = elapsed / 3600000;
    var mi = milestoneInfo(hours);
    var elEl = $('#fast-elapsed'); if (!elEl) { stopFastTimer(); return; }
    elEl.textContent = fmtDur(elapsed);

    var ring = $('#fast-ring');
    var circ = 2 * Math.PI * 52;
    var frac = mi.next ? Math.min(1, hours / mi.next) : 1;
    if (ring) {
      ring.style.strokeDashoffset = circ * (1 - frac);
      ring.style.stroke = mi.reached >= 16 ? 'var(--green)' : 'var(--primary)';
    }
    var mark = $('#fast-mark');
    if (mark) mark.textContent = mi.reached ? mi.reached + 'h mark' : 'warming up';
    var st = $('#fast-state');
    if (st) st.textContent = mi.next ? ('next: ' + mi.next + 'h') : 'beast mode 🦾';
  }

  function startFast(startIso) {
    api('startFast', { startAt: startIso }).then(function (data) {
      state.activeFast = data.fast; renderFasting(); toast('Fast started — stay strong 💪');
    }).catch(function (e) { toast(e.message); });
  }
  function endFast() {
    var f = state.activeFast; if (!f) return;
    var elapsed = Date.now() - new Date(f.startAt).getTime();
    if (!confirm('End your fast? You fasted ' + durLabel(elapsed) + '.')) return;
    api('endFast', {}).then(function (data) {
      state.activeFast = null;
      var done = data.fast;
      var ms = done ? (new Date(done.endAt).getTime() - new Date(done.startAt).getTime()) : elapsed;
      var mark = milestoneInfo(ms / 3600000).reached;
      renderFasting();
      toast(mark ? ('Fast ended — ' + mark + 'h mark! 🎉') : ('Fast ended — ' + durLabel(ms)));
    }).catch(function (e) { toast(e.message); });
  }

  function loadFastHistory() {
    api('getFasts', {}).then(function (data) {
      var box = $('#fast-history'); if (!box) return;
      var list = (data.fasts || []).slice(0, 8);
      box.innerHTML = '';
      if (!list.length) return;
      box.appendChild(el('div', 'muted tiny fh-title', 'Recent fasts'));
      list.forEach(function (f) { box.appendChild(buildFastRow(f)); });
    }).catch(function () {});
  }

  function buildFastRow(f) {
    var dur = new Date(f.endAt).getTime() - new Date(f.startAt).getTime();
    var mark = milestoneInfo(dur / 3600000).reached;
    var wrap = el('div', 'fh-item');
    var row = el('div', 'fh-row');
    row.innerHTML =
      '<span class="fh-date">' + new Date(f.startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</span>' +
      '<span class="fh-dur">' + durLabel(dur) + '</span>' +
      '<span class="fh-mark">' + (mark ? mark + 'h mark' : '—') + '</span>';
    var edit = el('button', 'fh-btn', '✎');
    var del = el('button', 'fh-btn', '🗑');
    row.appendChild(edit); row.appendChild(del);

    var form = el('div', 'fh-edit-form hidden');
    form.innerHTML =
      '<label class="tiny">Start<input type="datetime-local" class="fh-s"></label>' +
      '<label class="tiny">End<input type="datetime-local" class="fh-e"></label>' +
      '<div class="row-2"><button class="btn primary fh-save">Save</button>' +
      '<button class="btn fh-cancel">Cancel</button></div>';

    edit.addEventListener('click', function () {
      form.querySelector('.fh-s').value = toLocalInput(f.startAt);
      form.querySelector('.fh-e').value = toLocalInput(f.endAt);
      form.classList.toggle('hidden');
    });
    form.querySelector('.fh-cancel').addEventListener('click', function () { form.classList.add('hidden'); });
    form.querySelector('.fh-save').addEventListener('click', function () {
      var s = form.querySelector('.fh-s').value, e = form.querySelector('.fh-e').value;
      if (!s || !e) { toast('Set both times'); return; }
      if (new Date(e).getTime() <= new Date(s).getTime()) { toast('End must be after start'); return; }
      api('updateFast', { id: f.id, startAt: fromLocalInput(s), endAt: fromLocalInput(e) })
        .then(function () { loadFastHistory(); toast('Fast updated ✓'); })
        .catch(function (err) { toast(err.message); });
    });
    del.addEventListener('click', function () {
      if (!confirm('Delete this fast?')) return;
      api('deleteFast', { id: f.id })
        .then(function () { loadFastHistory(); toast('Deleted'); })
        .catch(function (err) { toast(err.message); });
    });

    wrap.appendChild(row); wrap.appendChild(form);
    return wrap;
  }

  function renderDietBody() {
    var g = dietGoals();
    var t = state.foods.reduce(function (s, f) {
      s.cal += f.calories; s.p += f.protein; s.c += f.carbs; s.f += f.fat; return s;
    }, { cal: 0, p: 0, c: 0, f: 0 });

    $('#cal-eaten').textContent = Math.round(t.cal);
    $('#cal-goal').textContent = g.cal ? g.cal : '—';
    $('#cal-left').textContent = g.cal ? Math.round(g.cal - t.cal) : '—';
    $('#goal-hint').classList.toggle('hidden', !!g.cal);

    var ring = $('#cal-ring');
    var circ = 2 * Math.PI * 34;
    var frac = g.cal ? Math.min(1, t.cal / g.cal) : 0;
    ring.style.strokeDashoffset = circ * (1 - frac);
    ring.style.stroke = (g.cal && t.cal > g.cal) ? 'var(--red)' : '#2fd47a';

    var bars = $('#macro-bars');
    bars.innerHTML = '';
    [['p', 'Protein', t.p, g.protein], ['c', 'Carbs', t.c, g.carbs], ['f', 'Fat', t.f, g.fat]].forEach(function (m) {
      var pct = m[3] ? Math.min(100, Math.round((m[2] / m[3]) * 100)) : 0;
      var row = el('div', 'macro ' + m[0]);
      row.innerHTML = '<div class="ml"><span>' + m[1] + '</span><span><b>' + Math.round(m[2]) + 'g</b>' +
        (m[3] ? ' / ' + m[3] + 'g' : '') + '</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      bars.appendChild(row);
    });

    renderMeals();
  }

  function renderMeals() {
    var meals = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
    var box = $('#meals');
    box.innerHTML = '';
    meals.forEach(function (meal) {
      var items = state.foods.filter(function (f) { return f.meal === meal; });
      var cals = items.reduce(function (s, f) { return s + f.calories; }, 0);
      var card = el('div', 'meal-card');
      var head = el('div', 'meal-top');
      head.innerHTML = '<span class="mt-name">' + meal + '</span><span class="mt-cal">' + Math.round(cals) + ' kcal</span>';
      card.appendChild(head);
      items.forEach(function (f) {
        var it = el('div', 'food-item');
        it.innerHTML =
          '<div class="fi-body"><div class="fi-name">' + esc(f.name) + '</div>' +
          '<div class="fi-sub">' + Math.round(f.grams) + ' g · P' + Math.round(f.protein) + ' C' + Math.round(f.carbs) + ' F' + Math.round(f.fat) + '</div></div>' +
          '<div class="fi-cal">' + Math.round(f.calories) + '</div>' +
          '<button class="fi-del" title="Remove">✕</button>';
        it.querySelector('.fi-del').addEventListener('click', function () { deleteFood(f.id); });
        card.appendChild(it);
      });
      var add = el('button', 'add-food-btn', '+ Add food');
      add.addEventListener('click', function () { openFoodModal(meal); });
      card.appendChild(add);
      box.appendChild(card);
    });
  }

  /* ----- Food modal ----- */
  var searchTimer;
  function openFoodModal(meal) {
    $('#food-modal-title').textContent = 'Add to ' + meal;
    $('#p-meal').value = meal;
    showSearchStep();
    $('#food-search').value = '';
    $('#food-results').innerHTML = '<p class="fr-loading">Type to search foods…</p>';
    $('#food-manual').classList.add('hidden');
    show('#food-modal');
    setTimeout(function () { $('#food-search').focus(); }, 100);
  }
  function closeFoodModal() { hide('#food-modal'); state.pendingFood = null; }
  function showSearchStep() { $('#food-step-search').classList.remove('hidden'); $('#food-step-portion').classList.add('hidden'); }
  function showPortionStep() { $('#food-step-search').classList.add('hidden'); $('#food-step-portion').classList.remove('hidden'); }

  function runSearch(q) {
    q = q.trim();
    var results = $('#food-results');
    if (!q) { results.innerHTML = '<p class="fr-loading">Type to search foods…</p>'; return; }
    var local = COMMON_FOODS.filter(function (f) { return f.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; });
    renderResults(local, true);
    results.insertAdjacentHTML('beforeend', '<p class="fr-loading" id="fr-loading">Searching database…</p>');

    fetch('https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) +
          '&search_simple=1&action=process&json=1&page_size=20' +
          '&fields=product_name,brands,nutriments,serving_quantity')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var items = (d.products || []).map(function (p) {
          var n = p.nutriments || {};
          var kcal = n['energy-kcal_100g'];
          if (kcal == null || !p.product_name) return null;
          return {
            name: p.product_name + (p.brands ? ' · ' + String(p.brands).split(',')[0] : ''),
            kcal: kcal, p: n.proteins_100g || 0, c: n.carbohydrates_100g || 0, f: n.fat_100g || 0,
            serving: Number(p.serving_quantity) || 100
          };
        }).filter(Boolean);
        var loadingEl = $('#fr-loading'); if (loadingEl) loadingEl.remove();
        if (!local.length && !items.length) { results.innerHTML = '<p class="fr-loading">No matches. Try the manual option below.</p>'; return; }
        appendResults(items);
      })
      .catch(function () { var l = $('#fr-loading'); if (l) l.remove(); });
  }

  function renderResults(list, replace) {
    var box = $('#food-results');
    if (replace) box.innerHTML = '';
    appendResults(list);
  }
  function appendResults(list) {
    var box = $('#food-results');
    list.forEach(function (f) {
      var it = el('div', 'fr-item');
      it.innerHTML = '<div><div class="fr-name">' + esc(f.name) + '</div>' +
        '<div class="fr-sub">per 100g · P' + Math.round(f.p) + ' C' + Math.round(f.c) + ' F' + Math.round(f.f) + '</div></div>' +
        '<div class="fr-cal">' + Math.round(f.kcal) + ' kcal</div>';
      it.addEventListener('click', function () { pickFood(f); });
      box.appendChild(it);
    });
  }

  function pickFood(f) {
    state.pendingFood = f;
    $('#p-name').textContent = f.name;
    $('#p-grams').value = f.serving || 100;
    updatePortion();
    showPortionStep();
  }
  function updatePortion() {
    var f = state.pendingFood; if (!f) return;
    var g = Number($('#p-grams').value) || 0;
    var k = f.kcal * g / 100, p = f.p * g / 100, c = f.c * g / 100, ft = f.f * g / 100;
    $('#p-macros').innerHTML =
      '<div class="pm-chip"><b>' + Math.round(k) + '</b>kcal</div>' +
      '<div class="pm-chip"><b>' + Math.round(p) + '</b>protein</div>' +
      '<div class="pm-chip"><b>' + Math.round(c) + '</b>carbs</div>' +
      '<div class="pm-chip"><b>' + Math.round(ft) + '</b>fat</div>';
  }
  function addPortion() {
    var f = state.pendingFood; if (!f) return;
    var g = Number($('#p-grams').value) || 0;
    saveFood({
      meal: $('#p-meal').value, name: f.name, grams: g,
      calories: f.kcal * g / 100, protein: f.p * g / 100, carbs: f.c * g / 100, fat: f.f * g / 100
    });
  }
  function addManual() {
    var name = $('#m-name').value.trim();
    if (!name) { toast('Enter a food name'); return; }
    saveFood({
      meal: $('#p-meal').value || 'Snacks', name: name, grams: 0,
      calories: Number($('#m-cal').value) || 0, protein: Number($('#m-protein').value) || 0,
      carbs: Number($('#m-carbs').value) || 0, fat: Number($('#m-fat').value) || 0
    });
    $('#m-name').value = $('#m-cal').value = $('#m-protein').value = $('#m-carbs').value = $('#m-fat').value = '';
  }
  function saveFood(food) {
    food.date = todayStr();
    api('addFood', { food: food }).then(function (data) {
      state.foods.push(data.food);
      closeFoodModal();
      renderDietBody();
      toast('Added ✓');
    }).catch(function (e) { toast(e.message); });
  }
  function deleteFood(id) {
    api('deleteFood', { id: id }).then(function () {
      state.foods = state.foods.filter(function (f) { return f.id !== id; });
      renderDietBody();
    }).catch(function (e) { toast(e.message); });
  }

  /* ----- Diet goals ----- */
  function bindDietEvents() {
    $('#food-close').addEventListener('click', closeFoodModal);
    $('#food-modal').addEventListener('click', function (e) { if (e.target.id === 'food-modal') closeFoodModal(); });
    $('#food-back').addEventListener('click', showSearchStep);
    $('#food-search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = this.value;
      searchTimer = setTimeout(function () { runSearch(q); }, 350);
    });
    $('#food-manual-toggle').addEventListener('click', function () { $('#food-manual').classList.toggle('hidden'); });
    $('#m-add').addEventListener('click', addManual);
    $('#p-grams').addEventListener('input', updatePortion);
    $('#p-add').addEventListener('click', addPortion);
    $('#calc-goals').addEventListener('click', calcGoals);
    $('#save-goals').addEventListener('click', saveGoals);
  }

  function calcGoals() {
    var sex = $('#g-sex').value, age = +$('#g-age').value, cm = +$('#g-height').value, kg = +$('#g-weight').value;
    if (!age || !cm || !kg) { toast('Fill age, height & weight'); return; }
    var bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
    var act = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 }[$('#g-activity').value] || 1.2;
    var adj = { lose: -500, maintain: 0, gain: 300 }[$('#g-goaltype').value] || 0;
    var cal = Math.max(1200, Math.round((bmr * act + adj) / 10) * 10);
    var protein = Math.round(1.8 * kg);
    var fat = Math.round(cal * 0.25 / 9);
    var carbs = Math.max(0, Math.round((cal - protein * 4 - fat * 9) / 4));
    $('#g-cal').value = cal; $('#g-protein').value = protein; $('#g-carbs').value = carbs; $('#g-fat').value = fat;
    toast('Targets calculated — tap Save');
  }

  function saveGoals() {
    var profile = {
      sex: $('#g-sex').value, age: +$('#g-age').value || '', heightCm: +$('#g-height').value || '',
      weightKg: +$('#g-weight').value || '', activity: $('#g-activity').value, goalType: $('#g-goaltype').value,
      calorieGoal: +$('#g-cal').value || 0, proteinGoal: +$('#g-protein').value || 0,
      carbGoal: +$('#g-carbs').value || 0, fatGoal: +$('#g-fat').value || 0
    };
    api('saveGoals', { profile: profile }).then(function (data) {
      state.profile = data.profile || profile;
      toast('Diet goals saved ✓');
    }).catch(function (e) { toast(e.message); });
  }

  function prefillGoals() {
    var p = state.profile || {};
    if (p.sex) $('#g-sex').value = p.sex;
    if (p.activity) $('#g-activity').value = p.activity;
    if (p.goalType) $('#g-goaltype').value = p.goalType;
    $('#g-age').value = p.age || '';
    $('#g-height').value = p.heightCm || '';
    $('#g-weight').value = p.weightKg || '';
    $('#g-cal').value = p.calorieGoal || '';
    $('#g-protein').value = p.proteinGoal || '';
    $('#g-carbs').value = p.carbGoal || '';
    $('#g-fat').value = p.fatGoal || '';
  }

  /* ---------------- Themes ---------------- */
  var THEMES = [
    { id: 'midnight', name: 'Midnight',  bg: '#0b1220', accent: '#ff5a3c' },
    { id: 'neon',     name: 'Neon Lime', bg: '#0a0a0a', accent: '#c8ff00' },
    { id: 'violet',   name: 'Violet',    bg: '#0c0a14', accent: '#a855f7' },
    { id: 'ocean',    name: 'Ocean',     bg: '#04141b', accent: '#22d3ee' },
    { id: 'crimson',  name: 'Crimson',   bg: '#140a0d', accent: '#ff4d5e' },
    { id: 'pastel',   name: 'Pastel',    bg: '#f3f1ee', accent: '#b07cff' }
  ];
  function currentTheme() { return localStorage.getItem('hard_theme') || CFG.DEFAULT_THEME || 'midnight'; }
  function applyTheme(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
    if (t.id === 'midnight') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t.id);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
    localStorage.setItem('hard_theme', t.id);
  }
  function renderThemes() {
    var grid = $('#theme-grid'); if (!grid) return;
    var active = currentTheme();
    grid.innerHTML = '';
    THEMES.forEach(function (t) {
      var s = el('button', 'swatch' + (t.id === active ? ' active' : ''));
      s.innerHTML = '<span class="sw-preview" style="background:' + t.bg + '">' +
        '<i style="background:' + t.accent + '"></i></span><span class="sw-name">' + t.name + '</span>';
      s.addEventListener('click', function () { applyTheme(t.id); renderThemes(); });
      grid.appendChild(s);
    });
  }

  /* ---------------- Start ---------------- */
  function boot() {
    applyTheme(currentTheme());
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
