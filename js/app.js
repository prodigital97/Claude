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
  var ADMIN_USERS = ['pronoy']; // who sees the admin dashboard (backend enforces too)
  function isAdmin() { return !!state.user && ADMIN_USERS.indexOf(String(state.user.username || '').toLowerCase()) >= 0; }

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
    dietDate: null,
    customFoods: [],
    friends: null,
    scanData: null,
    pendingFood: null,
    editingFoodId: null,
    activeFast: null,
    fastTimer: null,
    journeyWindow: 75,
    editDay: null,
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

  /* ---------------- Tap feedback (haptic + click sound) ---------------- */
  var FX = {
    haptics: localStorage.getItem('hard_haptics') !== '0', // default on
    sound: localStorage.getItem('hard_sound') !== '0',     // default on
    actx: null,
    ensure: function () {
      if (this.actx) { if (this.actx.state === 'suspended') this.actx.resume(); return; }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) { try { this.actx = new Ctx(); } catch (e) {} }
    },
    beep: function () {
      this.ensure();
      if (!this.actx) return;
      try {
        var now = this.actx.currentTime;
        var o = this.actx.createOscillator(), g = this.actx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(420, now); o.frequency.exponentialRampToValueAtTime(180, now + 0.05);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.06, now + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
        o.connect(g); g.connect(this.actx.destination);
        o.start(now); o.stop(now + 0.07);
      } catch (e) {}
    },
    tap: function () {
      if (this.haptics && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
      if (this.sound) this.beep();
    },
    set: function (key, on) {
      this[key] = on;
      localStorage.setItem(key === 'haptics' ? 'hard_haptics' : 'hard_sound', on ? '1' : '0');
      if (on) this.tap(); // confirm the toggle itself
    }
  };
  // Fire on pointerdown so it feels instant (and unlocks audio on the first user gesture).
  // Walk up a few ancestors and tick if the element is a control or is styled clickable.
  document.addEventListener('pointerdown', function (e) {
    var node = e.target;
    for (var i = 0; i < 5 && node && node.nodeType === 1; i++) {
      if (node.disabled) return;
      var tag = node.tagName;
      var isControl = tag === 'BUTTON' || tag === 'A' ||
        (tag === 'INPUT' && /^(checkbox|radio|button|submit)$/i.test(node.type));
      if (isControl || node.getAttribute('role') === 'button') { FX.tap(); return; }
      try { if (window.getComputedStyle(node).cursor === 'pointer') { FX.tap(); return; } } catch (e2) {}
      node = node.parentNode;
    }
  }, { passive: true });

  /* ---------------- date helpers ---------------- */
  function todayStr() { return fmt(new Date()); }
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) {
    if (s instanceof Date) return s;
    var str = String(s);
    var p = str.slice(0, 10).split('-');
    if (p.length === 3 && p[0].length === 4) return new Date(+p[0], +p[1] - 1, +p[2]);
    var d = new Date(str); // tolerate "Tue Jun 16 2026 …" style strings from Sheets
    return isNaN(d.getTime()) ? new Date() : d;
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
    if (action === 'updateFood') {
      var farr = (d.foods && d.foods[me.username]) || [];
      var row = farr.filter(function (x) { return x.id === p.id; })[0];
      if (row) { ['grams', 'calories', 'protein', 'carbs', 'fat', 'sugar'].forEach(function (k) { row[k] = p.food[k]; }); saveDb(d); }
      return { food: row || null };
    }
    if (action === 'getCustomFoods') {
      return { foods: (d.customFoods || []) };
    }
    if (action === 'addCustomFood') {
      d.customFoods = d.customFoods || [];
      var nm = String(p.food.name || '').trim();
      var dup = d.customFoods.some(function (x) { return x.name.toLowerCase() === nm.toLowerCase(); });
      if (!dup && nm) {
        d.customFoods.push({ id: 'c_' + Date.now(), name: nm, kcal: Math.round(p.food.kcal || 0),
          protein: p.food.p || 0, carbs: p.food.c || 0, fat: p.food.f || 0, sugar: p.food.s || 0 });
        saveDb(d);
      }
      return { food: p.food };
    }
    if (action === 'foodSummary') {
      var all = (d.foods && d.foods[me.username]) || [];
      var total = all.reduce(function (s, x) { return s + (Number(x.calories) || 0); }, 0);
      var days = {}; all.forEach(function (x) { days[x.date] = true; });
      var n = Object.keys(days).length;
      return { totalCalories: Math.round(total), daysLogged: n, avgCalories: n ? Math.round(total / n) : 0 };
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
    if (action === 'deleteAccount') {
      if (me.password !== p.password) throw new Error('Password is incorrect.');
      var un = me.username;
      delete d.users[un];
      if (d.logs) delete d.logs[un];
      if (d.foods) delete d.foods[un];
      if (d.fasts) delete d.fasts[un];
      if (d.profiles) delete d.profiles[un];
      saveDb(d); return { deleted: true };
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
        var start = u.startDate;
        var doneDates = {};
        lg.forEach(function (x) { if (x.completed && x.date >= start && x.date <= today) doneDates[x.date] = true; });
        return {
          displayName: u.displayName, currentDay: dayNumber(u.startDate, today),
          completedDays: Object.keys(doneDates).length, streak: streakOf(lg),
          todayDone: done, todayTotal: TOTAL_ITEMS, todayComplete: tl ? !!tl.completed : false,
          todayWaterMl: tl ? (Number(tl.waterMl) || 0) : 0,
          todayCalories: Math.round(cals),
          calorieGoal: (d.profiles && d.profiles[k] && d.profiles[k].calorieGoal) || 0
        };
      }).sort(function (a, b) { return b.completedDays - a.completedDays || b.todayDone - a.todayDone; });
      return { leaderboard: board };
    }
    // Friends features aren't meaningful in single-device demo mode — return empties.
    if (action === 'getFriends') return { friends: [], incoming: [], outgoing: [] };
    if (action === 'searchUsers') return { users: [] };
    if (action === 'addFriend') return { status: 'outgoing' };
    if (action === 'respondFriend') return { status: 'friend' };
    if (action === 'removeFriend') return { status: 'removed' };
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
    // Count consecutive complete days ending today (or yesterday if today's
    // still in progress, so an unfinished today doesn't zero your streak).
    var set = {};
    logs.forEach(function (l) { if (isComplete(l)) set[l.date] = true; });
    var d = todayStr();
    if (!set[d]) d = addDays(d, -1);
    var s = 0;
    while (set[d]) { s++; d = addDays(d, -1); }
    return s;
  }
  function emptyDay(date) {
    return { date: date, dayNumber: state.user ? dayNumber(state.user.startDate, date) : 1,
      workout1: false, workout2: false, outdoor: false, waterMl: 0,
      reading: false, photo: false, diet: false, noAlcohol: false, completed: false, notes: '', extra: {}, mood: 0 };
  }
  function logFor(date) {
    return state.logs.filter(function (l) { return l.date === date; })[0];
  }
  // Keep one log per date (the most complete), guarding against duplicate rows.
  function dedupeLogs(logs) {
    var m = {};
    logs.forEach(function (l) {
      var ex = m[l.date];
      if (!ex || (isComplete(l) && !isComplete(ex))) m[l.date] = l;
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
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
      state.logs = dedupeLogs(data.logs || []);
      state.user.currentDay = dayNumber(state.user.startDate, todayStr());
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
    loadCustomFoods();
    renderAll();
    switchView('today');
  }

  function loadCustomFoods() {
    api('getCustomFoods', {}).then(function (data) {
      state.customFoods = (data.foods || []).map(function (f) {
        return { name: f.name, kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat, s: f.sugar, serving: 100, shared: true };
      });
    }).catch(function () {});
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
    $('#add-habit-btn').addEventListener('click', addHabit);
    $('#new-habit').addEventListener('keydown', function (e) { if (e.key === 'Enter') addHabit(); });
    $('#logout').addEventListener('click', logout);
    $('#reset-challenge').addEventListener('click', resetChallenge);
    $('#save-profile').addEventListener('click', saveProfile);
    $('#save-startdate').addEventListener('click', saveStartDate);
    $('#delete-account').addEventListener('click', deleteAccount);
    // Journey window buttons + day editor modal
    document.querySelectorAll('#journey-windows [data-w]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.journeyWindow = +b.dataset.w;
        document.querySelectorAll('#journey-windows [data-w]').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderCalendar();
      });
    });
    $('#day-close').addEventListener('click', function () { hide('#day-modal'); });
    $('#day-modal').addEventListener('click', function (e) { if (e.target.id === 'day-modal') hide('#day-modal'); });
    $('#day-save').addEventListener('click', saveDayEditor);
    document.querySelectorAll('[data-calc]').forEach(function (b) {
      b.addEventListener('click', function () { calcDispatch(b.dataset.calc); });
    });
    $('#bf-sex').addEventListener('change', function () {
      $('#bf-hip-wrap').classList.toggle('hidden', this.value !== 'female');
    });
    $('#fx-sound').addEventListener('change', function () { FX.set('sound', this.checked); });
    $('#fx-haptics').addEventListener('change', function () { FX.set('haptics', this.checked); });
    // Admin dashboard
    $('#open-admin').addEventListener('click', function () { switchView('admin'); });
    $('#admin-back').addEventListener('click', function () { switchView('settings'); });
    document.querySelectorAll('#admin-tabs [data-atab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#admin-tabs [data-atab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        ['scans', 'users', 'foods'].forEach(function (t) { $('#admin-pane-' + t).classList.toggle('hidden', t !== b.dataset.atab); });
      });
    });
    $('#admin-food-filter').addEventListener('input', function () { renderAdminFoods(); });
    $('#admin-foods-list').addEventListener('click', function (e) {
      var save = e.target.closest('[data-save]'); var del = e.target.closest('[data-del]');
      if (save) adminSaveFood(save.getAttribute('data-save'), save);
      if (del) adminDeleteFood(del.getAttribute('data-del'));
    });
    // Friends tabs + actions
    document.querySelectorAll('#board-tabs [data-btab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#board-tabs [data-btab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        ['feed', 'requests', 'add'].forEach(function (t) { $('#board-pane-' + t).classList.toggle('hidden', t !== b.dataset.btab); });
        if (b.dataset.btab === 'add') setTimeout(function () { $('#friend-search').focus(); }, 50);
      });
    });
    $('#friend-search').addEventListener('input', function () {
      clearTimeout(friendSearchTimer);
      var q = this.value;
      friendSearchTimer = setTimeout(function () { runFriendSearch(q); }, 300);
    });
    $('#view-board').addEventListener('click', function (e) {
      var t = e.target.closest('[data-add],[data-accept],[data-decline],[data-cancel]');
      if (!t) return;
      if (t.hasAttribute('data-add')) addFriend(t.getAttribute('data-add'));
      else if (t.hasAttribute('data-accept')) respondFriend(t.getAttribute('data-accept'), true);
      else if (t.hasAttribute('data-decline')) respondFriend(t.getAttribute('data-decline'), false);
      else if (t.hasAttribute('data-cancel')) { e.preventDefault(); removeFriend(t.getAttribute('data-cancel')); }
    });
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
    if (name === 'calc') renderCalc();
    if (name === 'settings') renderSettings();
    if (name === 'admin') renderAdmin();
    window.scrollTo(0, 0);
  }

  /* ---------------- Render: header + today ---------------- */
  function renderAll() {
    $('#hdr-name').textContent = firstName(state.user.displayName);
    var cd = state.user.currentDay;
    var pill = $('.day-pill');
    if (cd > LEN + 30 || cd < 0) {
      // Start date is clearly wrong (e.g. the year-2000 bug) — nudge to fix it.
      pill.innerHTML = '⚠️ Set start date';
      pill.style.cursor = 'pointer';
      pill.onclick = function () { switchView('settings'); };
    } else {
      pill.innerHTML = 'Day <span id="hdr-day">' + Math.max(1, cd) + '</span> <span class="muted">/ ' + LEN + '</span>';
      pill.onclick = null; pill.style.cursor = '';
    }
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

    renderMood(d);
    renderExtraTasks(d);
  }

  /* ----- Mood meter (does NOT affect 75 Hard completion) ----- */
  var MOODS = [
    { v: 5, label: 'Great', emoji: '😄', color: '#2fd47a' },
    { v: 4, label: 'Good',  emoji: '🙂', color: '#9bd84a' },
    { v: 3, label: 'Okay',  emoji: '😐', color: '#ffc24b' },
    { v: 2, label: 'Low',   emoji: '😕', color: '#ff9f43' },
    { v: 1, label: 'Bad',   emoji: '😣', color: '#ff5470' }
  ];
  function moodColor(v) { for (var i = 0; i < MOODS.length; i++) if (MOODS[i].v === v) return MOODS[i].color; return null; }
  function renderMood(d) {
    var box = $('#mood-buttons'); if (!box) return;
    box.innerHTML = '';
    MOODS.forEach(function (m) {
      var sel = d.mood === m.v;
      var b = el('button', 'mood-btn' + (sel ? ' sel' : ''));
      b.style.setProperty('--mc', m.color);
      b.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span>';
      b.addEventListener('click', function () {
        d.mood = (d.mood === m.v) ? 0 : m.v;
        renderMood(d);
        queueSave();
      });
      box.appendChild(b);
    });
  }

  /* ----- Custom daily habits (do NOT affect 75 Hard completion) ----- */
  function renderExtraTasks(d) {
    var list = $('#extra-tasks'); if (!list) return;
    if (!d.extra) d.extra = {};
    var habits = (state.profile && state.profile.customTasks) || [];
    list.innerHTML = '';
    if (!habits.length) {
      list.innerHTML = '<p class="muted tiny" style="margin:2px 2px 10px">No habits yet — add one below to track it daily.</p>';
      return;
    }
    habits.forEach(function (h) {
      var done = !!d.extra[h.id];
      var row = el('div', 'task habit' + (done ? ' done' : ''));
      row.innerHTML =
        '<div class="check">✓</div>' +
        '<div class="t-emoji">📌</div>' +
        '<div class="t-body"><div class="t-title">' + esc(h.name) + '</div></div>' +
        '<button class="habit-del" title="Remove">✕</button>';
      row.addEventListener('click', function (e) {
        if (e.target.classList.contains('habit-del')) return;
        d.extra[h.id] = !d.extra[h.id];
        renderExtraTasks(d);
        queueSave();
      });
      row.querySelector('.habit-del').addEventListener('click', function (e) {
        e.stopPropagation();
        removeHabit(h.id);
      });
      list.appendChild(row);
    });
  }

  function addHabit() {
    var name = $('#new-habit').value.trim();
    if (!name) return;
    var habits = (state.profile.customTasks || []).slice();
    habits.push({ id: 'h_' + Date.now().toString(36), name: name });
    $('#new-habit').value = '';
    saveHabits(habits);
  }
  function removeHabit(id) {
    var habits = (state.profile.customTasks || []).filter(function (h) { return h.id !== id; });
    saveHabits(habits);
  }
  function saveHabits(habits) {
    var profile = Object.assign({}, state.profile, { customTasks: habits });
    state.profile = profile;
    renderExtraTasks(state.today);
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
    }).catch(function (e) { toast(e.message); });
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
      var g = el('div', 'glass' + (i < filled ? ' full' : ''), '🥛');
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
  function shortDate(date) {
    return parse(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function renderCalendar() {
    renderJourneySummary();
    var grid = $('#calendar-grid');
    grid.innerHTML = '';
    var today = todayStr();
    for (var n = 1; n <= LEN; n++) {
      var date = addDays(state.user.startDate, n - 1);
      var log = logFor(date);
      var done = log && isComplete(log);
      var cell = el('div', 'cal-cell');
      cell.innerHTML = '<span class="cc-num">' + n + '</span><span class="cc-date">' + shortDate(date) + '</span>';
      if (date === today) cell.classList.add('today');
      if (done) cell.classList.add('done');
      else if (date < today) cell.classList.add('miss');
      if (date <= today) {
        cell.classList.add('editable');
        (function (dt) { cell.addEventListener('click', function () { openDayEditor(dt); }); })(date);
      }
      grid.appendChild(cell);
    }
  }

  function renderJourneySummary() {
    var box = $('#journey-summary'); if (!box) return;
    var win = state.journeyWindow || LEN;
    var today = todayStr();
    var curDay = Math.max(1, state.user.currentDay);
    var n = Math.min(win, curDay); // only count elapsed days
    var completed = 0, taskHits = 0, taskTotal = 0;
    for (var i = 0; i < n; i++) {
      var date = addDays(state.user.startDate, curDay - 1 - i);
      if (date > today || date < state.user.startDate) continue;
      var log = logFor(date);
      if (log && isComplete(log)) completed++;
      taskTotal += TOTAL_ITEMS;
      if (log) taskHits += completedCount(log);
    }
    var rate = taskTotal ? Math.round((taskHits / taskTotal) * 100) : 0;
    box.innerHTML =
      '<div class="js-stat"><b>' + completed + ' / ' + n + '</b><span>days complete</span></div>' +
      '<div class="js-stat"><b>' + rate + '%</b><span>tasks done</span></div>';
  }

  /* ----- Day editor (edit any date from Journey) ----- */
  function openDayEditor(date) {
    state.editDay = Object.assign(emptyDay(date), logFor(date) || {});
    state.editDay.date = date;
    $('#day-modal-title').textContent = 'Day ' + dayNumber(state.user.startDate, date) + ' · ' + prettyDate(date);
    renderDayEditorBody();
    show('#day-modal');
  }
  function renderDayEditorBody() {
    var d = state.editDay;
    var list = $('#day-editor-list');
    list.innerHTML = '';
    TASKS.forEach(function (t) {
      var row = el('div', 'task' + (d[t.key] ? ' done' : ''));
      row.innerHTML = '<div class="check">✓</div><div class="t-emoji">' + t.emoji + '</div>' +
        '<div class="t-body"><div class="t-title">' + t.title + '</div><div class="t-sub">' + t.sub + '</div></div>';
      row.addEventListener('click', function () { d[t.key] = !d[t.key]; renderDayEditorBody(); });
      list.appendChild(row);
    });
    // water stepper
    var ml = Number(d.waterMl) || 0;
    var w = el('div', 'task water-edit');
    w.innerHTML =
      '<div class="check"' + (ml >= WATER_GOAL ? ' style="background:#4aa8ff;border-color:#4aa8ff;color:#04223f"' : '') + '>✓</div>' +
      '<div class="t-emoji">💧</div>' +
      '<div class="t-body"><div class="t-title">Water</div><div class="t-sub">' + litres(ml) + ' L / ' + litres(WATER_GOAL) + ' L</div></div>' +
      '<button class="wstep" data-d="-1">–</button><button class="wstep" data-d="1">＋</button>';
    w.querySelectorAll('.wstep').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        d.waterMl = Math.max(0, Math.min(WATER_GOAL, (Number(d.waterMl) || 0) + (+b.dataset.d) * GLASS));
        renderDayEditorBody();
      });
    });
    list.appendChild(w);
  }
  function saveDayEditor() {
    var d = state.editDay;
    d.completed = isComplete(d);
    api('saveDay', { day: d }).then(function () {
      var i = state.logs.findIndex(function (l) { return l.date === d.date; });
      var copy = Object.assign({}, d);
      if (i >= 0) state.logs[i] = copy; else state.logs.push(copy);
      state.logs.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      cacheState();
      if (d.date === todayStr()) { state.today = Object.assign(emptyDay(todayStr()), d); }
      hide('#day-modal');
      renderCalendar(); renderAll();
      toast('Saved ' + shortDate(d.date) + ' ✓');
    }).catch(function (e) { toast(e.message); });
  }

  /* ---------------- Stats ---------------- */
  function renderStats() {
    renderStatsBody({ avgFast: '…', avgCal: '…' });
    var fast = api('getFasts', {}).then(function (d) { return avgFastLabel(d.fasts || []); }).catch(function () { return '—'; });
    var food = api('foodSummary', {}).then(function (d) { return d.avgCalories ? (d.avgCalories + ' kcal') : '—'; }).catch(function () { return '—'; });
    Promise.all([fast, food]).then(function (res) {
      renderStatsBody({ avgFast: res[0], avgCal: res[1] });
    });
  }

  function avgFastLabel(fasts) {
    var done = (fasts || []).filter(function (f) { return f.endAt; });
    if (!done.length) return '—';
    var avg = done.reduce(function (s, f) {
      return s + (new Date(f.endAt).getTime() - new Date(f.startAt).getTime());
    }, 0) / done.length;
    return Math.floor(avg / 3600000) + 'h ' + Math.floor((avg % 3600000) / 60000) + 'm';
  }

  function renderStatsBody(vals) {
    var logs = state.logs;
    var curDay = Math.max(1, state.user.currentDay);
    var start = fmt(parse(state.user.startDate));
    var today = todayStr();
    // Count complete days only within the challenge window (ignores stray logs).
    var done = logs.filter(function (l) {
      return l.date >= start && l.date <= today && isComplete(l);
    }).length;

    var grid = $('#stats-grid');
    grid.innerHTML = '';
    [
      ['Current day', Math.min(curDay, LEN) + ' / ' + LEN],
      ['Streak', streakOf(logs) + '🔥'],
      ['Days completed', done],
      ['Days left', Math.max(0, LEN - Math.min(curDay, LEN))],
      ['Avg fast', vals.avgFast],
      ['Avg calories / day', vals.avgCal]
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

    renderMoodTrend();
  }

  function renderMoodTrend() {
    var box = $('#mood-trend'); if (!box) return;
    var today = todayStr(), dots = '', sum = 0, n = 0;
    for (var i = 13; i >= 0; i--) {
      var date = addDays(today, -i);
      var log = logFor(date);
      var mv = log && log.mood ? log.mood : 0;
      var col = moodColor(mv) || 'var(--bg-soft)';
      dots += '<span class="mt-dot" title="' + shortDate(date) + '" style="background:' + col + '"></span>';
      if (mv) { sum += mv; n++; }
    }
    var avg = n ? (sum / n) : 0;
    var avgM = avg ? MOODS.reduce(function (a, b) { return Math.abs(b.v - avg) < Math.abs(a.v - avg) ? b : a; }) : null;
    box.innerHTML = '<div class="mt-dots">' + dots + '</div>' +
      '<div class="muted tiny" style="margin-top:8px">' +
      (n ? ('Average: ' + avgM.emoji + ' ' + avgM.label + ' (' + avg.toFixed(1) + '/5) over ' + n + ' logged day' + (n > 1 ? 's' : '')) : 'No mood logged yet — set it on the Today screen.') +
      '</div>';
  }
  function bestStreak(logs) {
    var best = 0, cur = 0;
    logs.forEach(function (l) { if (isComplete(l)) { cur++; best = Math.max(best, cur); } else cur = 0; });
    return best;
  }

  /* ---------------- Friends ---------------- */
  function renderBoard() {
    renderFeed();
    renderFriends();
  }
  function renderFeed() {
    var box = $('#leaderboard');
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('leaderboard', {}).then(function (data) {
      var list = data.leaderboard || [];
      box.innerHTML = '';
      if (list.length <= 1) {
        box.innerHTML = '<p class="muted">Add friends to see their progress here. Tap <b>Add</b> above to find people.</p>';
        if (!list.length) return;
      }
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

  // Load friends + requests; render the Requests pane and the badge.
  function renderFriends() {
    api('getFriends', {}).then(function (d) {
      state.friends = d;
      var inc = d.incoming || [], out = d.outgoing || [];
      var badge = $('#req-badge');
      badge.textContent = inc.length;
      badge.classList.toggle('hidden', !inc.length);

      $('#req-incoming').innerHTML = inc.length
        ? inc.map(function (u) {
            return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' +
              '<span class="fr-acts"><button class="btn primary fr-mini" data-accept="' + esc(u.username) + '">Accept</button>' +
              '<button class="btn fr-mini" data-decline="' + esc(u.username) + '">Decline</button></span></div>';
          }).join('')
        : '<p class="muted tiny">No new requests.</p>';

      $('#req-outgoing').innerHTML = out.length
        ? out.map(function (u) {
            return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' +
              '<span class="muted tiny">Pending · <a href="#" class="fr-cancel" data-cancel="' + esc(u.username) + '">cancel</a></span></div>';
          }).join('')
        : '<p class="muted tiny">No pending sent requests.</p>';
    }).catch(function () {});
  }

  var friendSearchTimer;
  function runFriendSearch(q) {
    var box = $('#friend-results');
    if (!q || q.trim().length < 2) { box.innerHTML = '<p class="muted tiny">Type at least 2 letters.</p>'; return; }
    box.innerHTML = '<p class="muted tiny">Searching…</p>';
    api('searchUsers', { query: q.trim() }).then(function (d) {
      var list = d.users || [];
      if (!list.length) { box.innerHTML = '<p class="muted tiny">No users found.</p>'; return; }
      box.innerHTML = list.map(function (u) {
        var right;
        if (u.relation === 'friend') right = '<span class="muted tiny">✓ Friend</span>';
        else if (u.relation === 'outgoing') right = '<span class="muted tiny">Requested</span>';
        else if (u.relation === 'incoming') right = '<button class="btn primary fr-mini" data-accept="' + esc(u.username) + '">Accept</button>';
        else right = '<button class="btn primary fr-mini" data-add="' + esc(u.username) + '">+ Add</button>';
        return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' + right + '</div>';
      }).join('');
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function addFriend(username) {
    api('addFriend', { to: username }).then(function (r) {
      toast(r.status === 'friend' ? 'You are now friends ✓' : 'Request sent ✓');
      runFriendSearch($('#friend-search').value); renderFriends();
      if (r.status === 'friend') renderFeed();
    }).catch(function (e) { toast(e.message); });
  }
  function respondFriend(username, accept) {
    api('respondFriend', { from: username, accept: accept }).then(function () {
      toast(accept ? 'Friend added ✓' : 'Request declined');
      renderFriends(); renderFeed();
      if ($('#friend-search').value) runFriendSearch($('#friend-search').value);
    }).catch(function (e) { toast(e.message); });
  }
  function removeFriend(username) {
    api('removeFriend', { username: username }).then(function () {
      toast('Removed'); renderFriends(); renderFeed();
    }).catch(function (e) { toast(e.message); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    $('#set-displayname').value = state.user.displayName;
    $('#set-username').textContent = state.user.username;
    $('#admin-entry').classList.toggle('hidden', !isAdmin());
    $('#fx-sound').checked = FX.sound;
    $('#fx-haptics').checked = FX.haptics;
    var sd = fmt(parse(state.user.startDate));
    // Guard against a corrupted/ancient stored date (e.g. year 2000) — show today instead.
    if (sd < '2025-01-01' || sd > todayStr()) sd = todayStr();
    var inp = $('#set-startdate');
    inp.value = sd; inp.min = '2025-01-01'; inp.max = todayStr();
    prefillGoals();
    renderThemes();
  }
  function saveStartDate() {
    var v = $('#set-startdate').value;
    if (!v) { toast('Pick a date'); return; }
    if (v < '2025-01-01' || v > todayStr()) { toast('Pick a valid recent date (this year)'); return; }
    api('reset', { startDate: v })
      .then(function () { return loadState(); }) // re-read to confirm it persisted
      .then(function () {
        renderAll(); renderSettings();
        toast('Start date saved ✓ — Day ' + Math.max(1, state.user.currentDay));
      })
      .catch(function (e) { toast(e.message); });
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
  function deleteAccount() {
    var pw = $('#del-password').value;
    if (!pw) { toast('Enter your password to confirm'); return; }
    if (!confirm('Delete your account and ALL your data permanently? This cannot be undone.')) return;
    api('deleteAccount', { password: pw }).then(function () {
      localStorage.removeItem('hard_token');
      localStorage.removeItem('hard_user');
      localStorage.removeItem('hard_cache');
      alert('Your account has been deleted. Take care! 👋');
      location.reload();
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
    // Grains & breads
    { name: 'White rice (cooked)', kcal: 130, p: 2.7, c: 28, f: 0.3, s: 0.1, serving: 150 },
    { name: 'Brown rice (cooked)', kcal: 123, p: 2.7, c: 26, f: 1, s: 0.4, serving: 150 },
    { name: 'Roti / Chapati', kcal: 297, p: 11, c: 50, f: 7, s: 1.5, serving: 40 },
    { name: 'Paratha (plain)', kcal: 320, p: 6, c: 40, f: 14, s: 1.5, serving: 60 },
    { name: 'Aloo paratha', kcal: 280, p: 5, c: 38, f: 11, s: 2, serving: 100 },
    { name: 'Naan', kcal: 310, p: 9, c: 50, f: 8, s: 3, serving: 90 },
    { name: 'Bread (white slice)', kcal: 265, p: 9, c: 49, f: 3.2, s: 5, serving: 30 },
    { name: 'Brown bread (slice)', kcal: 247, p: 13, c: 41, f: 4, s: 4, serving: 30 },
    { name: 'Oats (dry)', kcal: 389, p: 17, c: 66, f: 7, s: 1, serving: 40 },
    { name: 'Poha (cooked)', kcal: 130, p: 2.5, c: 27, f: 1.5, s: 1, serving: 150 },
    { name: 'Upma', kcal: 145, p: 3, c: 24, f: 4, s: 1, serving: 150 },
    { name: 'Idli', kcal: 130, p: 4, c: 25, f: 0.8, s: 0.5, serving: 80 },
    { name: 'Dosa (plain)', kcal: 168, p: 3.9, c: 30, f: 3.7, s: 1, serving: 80 },
    // Noodles / pasta / wraps
    { name: 'Pasta (cooked)', kcal: 131, p: 5, c: 25, f: 1.1, s: 0.6, serving: 150 },
    { name: 'Hakka noodles (cooked)', kcal: 138, p: 4, c: 25, f: 2, s: 1, serving: 150 },
    { name: 'Rice vermicelli (cooked)', kcal: 109, p: 1.8, c: 24, f: 0.2, s: 0, serving: 150 },
    { name: 'Shirataki noodles (cooked)', kcal: 10, p: 0.2, c: 3, f: 0, s: 0, serving: 100 },
    { name: 'Rice paper / spring roll wrapper', kcal: 330, p: 0.9, c: 81, f: 0.2, s: 0.5, serving: 10 },
    // Dals, legumes, soy
    { name: 'Dal (cooked)', kcal: 116, p: 7, c: 17, f: 1.5, s: 1, serving: 150 },
    { name: 'Dal makhani', kcal: 230, p: 9, c: 20, f: 13, s: 3, serving: 150 },
    { name: 'Rajma (cooked)', kcal: 127, p: 8.7, c: 22, f: 0.5, s: 0.6, serving: 150 },
    { name: 'Chole / chana masala', kcal: 180, p: 8, c: 22, f: 7, s: 3, serving: 150 },
    { name: 'Boiled chana', kcal: 164, p: 8.9, c: 27, f: 2.6, s: 5, serving: 100 },
    { name: 'Tofu', kcal: 76, p: 8, c: 1.9, f: 4.8, s: 0.6, serving: 100 },
    { name: 'Soya chunks (dry)', kcal: 345, p: 52, c: 33, f: 0.5, s: 9, serving: 30 },
    // Dairy & fats
    { name: 'Milk (full fat)', kcal: 61, p: 3.2, c: 4.8, f: 3.3, s: 5, serving: 200 },
    { name: 'Milk (toned)', kcal: 47, p: 3.1, c: 4.7, f: 1.5, s: 5, serving: 200 },
    { name: 'Curd / Yogurt', kcal: 98, p: 11, c: 3.4, f: 4.3, s: 4.7, serving: 150 },
    { name: 'Greek yogurt', kcal: 97, p: 9, c: 4, f: 5, s: 4, serving: 150 },
    { name: 'Buttermilk', kcal: 40, p: 3.3, c: 4.8, f: 0.9, s: 4.8, serving: 200 },
    { name: 'Paneer', kcal: 296, p: 18, c: 4, f: 22, s: 1.2, serving: 50 },
    { name: 'Cheddar cheese', kcal: 402, p: 25, c: 1.3, f: 33, s: 0.5, serving: 30 },
    { name: 'Mozzarella', kcal: 280, p: 28, c: 3.1, f: 17, s: 1, serving: 30 },
    { name: 'Fresh cream', kcal: 292, p: 2.1, c: 3, f: 30, s: 3, serving: 30 },
    { name: 'Butter', kcal: 717, p: 0.9, c: 0.1, f: 81, s: 0.1, serving: 10 },
    { name: 'Ghee', kcal: 900, p: 0, c: 0, f: 100, s: 0, serving: 10 },
    { name: 'Coconut oil', kcal: 862, p: 0, c: 0, f: 100, s: 0, serving: 10 },
    { name: 'Mustard oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, serving: 10 },
    { name: 'Olive oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, serving: 10 },
    { name: 'Peanut butter', kcal: 588, p: 25, c: 20, f: 50, s: 9, serving: 20 },
    // Proteins
    { name: 'Egg (whole)', kcal: 155, p: 13, c: 1.1, f: 11, s: 1.1, serving: 50 },
    { name: 'Egg white', kcal: 52, p: 11, c: 0.7, f: 0.2, s: 0.7, serving: 33 },
    { name: 'Chicken breast (cooked)', kcal: 165, p: 31, c: 0, f: 3.6, s: 0, serving: 120 },
    { name: 'Chicken curry', kcal: 180, p: 14, c: 6, f: 11, s: 3, serving: 200 },
    { name: 'Butter chicken', kcal: 240, p: 14, c: 8, f: 16, s: 4, serving: 200 },
    { name: 'Fish (cooked)', kcal: 206, p: 22, c: 0, f: 12, s: 0, serving: 120 },
    { name: 'Mutton (cooked)', kcal: 258, p: 25, c: 0, f: 17, s: 0, serving: 120 },
    { name: 'Whey protein (scoop)', kcal: 400, p: 80, c: 8, f: 6, s: 6, serving: 30 },
    // Veg, fruit
    { name: 'Mixed vegetables', kcal: 65, p: 2.6, c: 13, f: 0.4, s: 5, serving: 150 },
    { name: 'Mixed veg sabzi', kcal: 110, p: 3, c: 12, f: 6, s: 4, serving: 150 },
    { name: 'Palak paneer', kcal: 180, p: 8, c: 8, f: 13, s: 3, serving: 150 },
    { name: 'Potato (boiled)', kcal: 87, p: 1.9, c: 20, f: 0.1, s: 0.8, serving: 150 },
    { name: 'Spinach (cooked)', kcal: 23, p: 2.9, c: 3.6, f: 0.4, s: 0.4, serving: 100 },
    { name: 'Cucumber', kcal: 15, p: 0.7, c: 3.6, f: 0.1, s: 1.7, serving: 100 },
    { name: 'Tomato', kcal: 18, p: 0.9, c: 3.9, f: 0.2, s: 2.6, serving: 100 },
    { name: 'Banana', kcal: 89, p: 1.1, c: 23, f: 0.3, s: 12, serving: 120 },
    { name: 'Apple', kcal: 52, p: 0.3, c: 14, f: 0.2, s: 10, serving: 180 },
    { name: 'Mango', kcal: 60, p: 0.8, c: 15, f: 0.4, s: 14, serving: 150 },
    // Fruits
    { name: 'Pineapple', kcal: 50, p: 0.5, c: 13, f: 0.1, s: 10, serving: 165 },
    { name: 'Guava (Amrood)', kcal: 68, p: 2.6, c: 14, f: 1, s: 9, serving: 100 },
    { name: 'Orange', kcal: 47, p: 0.9, c: 12, f: 0.1, s: 9, serving: 130 },
    { name: 'Sweet lime (Mosambi)', kcal: 43, p: 0.8, c: 9.3, f: 0.3, s: 8, serving: 130 },
    { name: 'Grapes', kcal: 69, p: 0.7, c: 18, f: 0.2, s: 16, serving: 100 },
    { name: 'Watermelon', kcal: 30, p: 0.6, c: 8, f: 0.2, s: 6, serving: 150 },
    { name: 'Muskmelon (Cantaloupe)', kcal: 34, p: 0.8, c: 8, f: 0.2, s: 8, serving: 150 },
    { name: 'Papaya', kcal: 43, p: 0.5, c: 11, f: 0.3, s: 8, serving: 140 },
    { name: 'Pomegranate (Anar)', kcal: 83, p: 1.7, c: 19, f: 1.2, s: 14, serving: 100 },
    { name: 'Pear', kcal: 57, p: 0.4, c: 15, f: 0.1, s: 10, serving: 150 },
    { name: 'Peach', kcal: 39, p: 0.9, c: 10, f: 0.3, s: 8, serving: 150 },
    { name: 'Plum', kcal: 46, p: 0.7, c: 11, f: 0.3, s: 10, serving: 65 },
    { name: 'Kiwi', kcal: 61, p: 1.1, c: 15, f: 0.5, s: 9, serving: 75 },
    { name: 'Strawberry', kcal: 32, p: 0.7, c: 8, f: 0.3, s: 5, serving: 100 },
    { name: 'Litchi (Lychee)', kcal: 66, p: 0.8, c: 17, f: 0.4, s: 15, serving: 100 },
    { name: 'Sapota (Chikoo)', kcal: 83, p: 0.4, c: 20, f: 1.1, s: 15, serving: 100 },
    { name: 'Custard apple (Sitaphal)', kcal: 94, p: 2.1, c: 24, f: 0.3, s: 19, serving: 100 },
    { name: 'Jackfruit', kcal: 95, p: 1.7, c: 23, f: 0.6, s: 19, serving: 100 },
    { name: 'Fig (Anjeer, fresh)', kcal: 74, p: 0.8, c: 19, f: 0.3, s: 16, serving: 50 },
    { name: 'Amla (Indian gooseberry)', kcal: 44, p: 0.9, c: 10, f: 0.6, s: 6, serving: 50 },
    { name: 'Dates (Khajoor)', kcal: 277, p: 1.8, c: 75, f: 0.2, s: 66, serving: 24 },
    { name: 'Coconut (fresh)', kcal: 354, p: 3.3, c: 15, f: 33, s: 6, serving: 50 },
    { name: 'Avocado', kcal: 160, p: 2, c: 9, f: 15, s: 0.7, serving: 100 },
    { name: 'Blueberries', kcal: 57, p: 0.7, c: 14, f: 0.3, s: 10, serving: 100 },
    // Nuts
    { name: 'Almonds', kcal: 579, p: 21, c: 22, f: 50, s: 4, serving: 28 },
    { name: 'Peanuts', kcal: 567, p: 26, c: 16, f: 49, s: 4, serving: 30 },
    { name: 'Cashews', kcal: 553, p: 18, c: 30, f: 44, s: 6, serving: 30 },
    { name: 'Walnuts', kcal: 654, p: 15, c: 14, f: 65, s: 2.6, serving: 30 },
    { name: 'Pistachios', kcal: 562, p: 20, c: 28, f: 45, s: 8, serving: 30 },
    { name: 'Hazelnuts', kcal: 628, p: 15, c: 17, f: 61, s: 4.3, serving: 28 },
    // Dry fruits & seeds
    { name: 'Raisins (Kishmish)', kcal: 299, p: 3.1, c: 79, f: 0.5, s: 59, serving: 30 },
    { name: 'Dried apricots (Khubani)', kcal: 241, p: 3.4, c: 63, f: 0.5, s: 53, serving: 30 },
    { name: 'Prunes (dried plums)', kcal: 240, p: 2.2, c: 64, f: 0.4, s: 38, serving: 30 },
    { name: 'Dried figs (Anjeer)', kcal: 249, p: 3.3, c: 64, f: 0.9, s: 48, serving: 30 },
    { name: 'Pumpkin seeds', kcal: 559, p: 30, c: 11, f: 49, s: 1, serving: 28 },
    { name: 'Sunflower seeds', kcal: 584, p: 21, c: 20, f: 51, s: 2.6, serving: 28 },
    { name: 'Chia seeds', kcal: 486, p: 17, c: 42, f: 31, s: 0, serving: 15 },
    { name: 'Flax seeds (Alsi)', kcal: 534, p: 18, c: 29, f: 42, s: 1.5, serving: 15 },
    // Vegetables (raw unless noted)
    { name: 'Broccoli', kcal: 34, p: 2.8, c: 7, f: 0.4, s: 1.7, serving: 100 },
    { name: 'Cauliflower (Gobi)', kcal: 25, p: 1.9, c: 5, f: 0.3, s: 1.9, serving: 100 },
    { name: 'Cabbage (Patta gobi)', kcal: 25, p: 1.3, c: 6, f: 0.1, s: 3.2, serving: 100 },
    { name: 'Capsicum / Bell pepper', kcal: 31, p: 1, c: 6, f: 0.3, s: 4.2, serving: 100 },
    { name: 'French beans', kcal: 31, p: 1.8, c: 7, f: 0.2, s: 3.3, serving: 100 },
    { name: 'Okra (Bhindi)', kcal: 33, p: 1.9, c: 7, f: 0.2, s: 1.5, serving: 100 },
    { name: 'Carrot', kcal: 41, p: 0.9, c: 10, f: 0.2, s: 4.7, serving: 100 },
    { name: 'Onion', kcal: 40, p: 1.1, c: 9, f: 0.1, s: 4.2, serving: 100 },
    { name: 'Green peas', kcal: 81, p: 5.4, c: 14, f: 0.4, s: 6, serving: 100 },
    { name: 'Brinjal / Eggplant (Baingan)', kcal: 25, p: 1, c: 6, f: 0.2, s: 3.5, serving: 100 },
    { name: 'Bottle gourd (Lauki)', kcal: 14, p: 0.6, c: 3.4, f: 0, s: 1.4, serving: 100 },
    { name: 'Bitter gourd (Karela)', kcal: 17, p: 1, c: 3.7, f: 0.2, s: 0, serving: 100 },
    { name: 'Pumpkin (Kaddu)', kcal: 26, p: 1, c: 7, f: 0.1, s: 2.8, serving: 100 },
    { name: 'Beetroot', kcal: 43, p: 1.6, c: 10, f: 0.2, s: 7, serving: 100 },
    { name: 'Sweet potato (Shakarkandi)', kcal: 86, p: 1.6, c: 20, f: 0.1, s: 4.2, serving: 100 },
    { name: 'Mushroom', kcal: 22, p: 3.1, c: 3.3, f: 0.3, s: 2, serving: 100 },
    { name: 'Sweet corn', kcal: 86, p: 3.2, c: 19, f: 1.2, s: 6.3, serving: 100 },
    { name: 'Radish (Mooli)', kcal: 16, p: 0.7, c: 3.4, f: 0.1, s: 1.9, serving: 100 },
    // Raw meat & seafood (per 100 g, uncooked)
    { name: 'Chicken breast (raw, skinless)', kcal: 120, p: 22.5, c: 0, f: 2.6, s: 0, serving: 100 },
    { name: 'Chicken thigh (raw, skinless)', kcal: 121, p: 19.7, c: 0, f: 4.3, s: 0, serving: 100 },
    { name: 'Chicken (whole, raw, with skin)', kcal: 215, p: 18, c: 0, f: 15, s: 0, serving: 100 },
    { name: 'Mutton / Goat (raw)', kcal: 109, p: 20.6, c: 0, f: 2.3, s: 0, serving: 100 },
    { name: 'Lamb (raw)', kcal: 294, p: 25, c: 0, f: 21, s: 0, serving: 100 },
    { name: 'Pork (raw)', kcal: 242, p: 27, c: 0, f: 14, s: 0, serving: 100 },
    { name: 'Pork (lean, raw)', kcal: 143, p: 21, c: 0, f: 6, s: 0, serving: 100 },
    { name: 'Beef (raw)', kcal: 250, p: 26, c: 0, f: 15, s: 0, serving: 100 },
    { name: 'Fish (raw, white)', kcal: 96, p: 20, c: 0, f: 1.5, s: 0, serving: 100 },
    { name: 'Rohu fish (raw)', kcal: 97, p: 16.6, c: 0, f: 1.4, s: 0, serving: 100 },
    { name: 'Salmon (raw)', kcal: 208, p: 20, c: 0, f: 13, s: 0, serving: 100 },
    { name: 'Prawns / Shrimp (raw)', kcal: 99, p: 24, c: 0.2, f: 0.3, s: 0, serving: 100 },
    { name: 'Egg (raw, whole)', kcal: 143, p: 12.6, c: 0.7, f: 9.5, s: 0.4, serving: 50 },
    // Snacks, sweets, drinks
    { name: 'Samosa', kcal: 308, p: 5, c: 32, f: 18, s: 2, serving: 50 },
    { name: 'Veg biryani', kcal: 180, p: 4, c: 28, f: 6, s: 2, serving: 200 },
    { name: 'Chicken biryani', kcal: 200, p: 9, c: 26, f: 7, s: 2, serving: 200 },
    { name: 'Curd rice', kcal: 150, p: 4, c: 22, f: 5, s: 3, serving: 200 },
    { name: 'Dark chocolate', kcal: 546, p: 4.9, c: 61, f: 31, s: 48, serving: 20 },
    { name: 'Honey', kcal: 304, p: 0.3, c: 82, f: 0, s: 82, serving: 20 },
    { name: 'Jaggery', kcal: 383, p: 0.4, c: 98, f: 0.1, s: 97, serving: 10 },
    { name: 'Sugar', kcal: 387, p: 0, c: 100, f: 0, s: 100, serving: 5 },
    { name: 'Tea with milk & sugar', kcal: 40, p: 1, c: 6, f: 1, s: 5, serving: 150 },
    { name: 'Black coffee (no sugar)', kcal: 1, p: 0.1, c: 0, f: 0, s: 0, serving: 240 },
    { name: 'Cola / soft drink', kcal: 42, p: 0, c: 10.6, f: 0, s: 10.6, serving: 330 },
    { name: 'Orange juice', kcal: 45, p: 0.7, c: 10, f: 0.2, s: 8, serving: 200 }
  ];

  // Bundled Indian dish database. Source values are per serving; we estimate a
  // serving weight so every dish also has per-100g values (supports both units).
  function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
  function estServingGrams(name) {
    var n = name.toLowerCase();
    if (/tea|coffee|chai|juice|lassi|shake|panna|sharbat|drink|smoothie|milk|buttermilk|chaas|soup|rasam|water/.test(n)) return 200;
    if (/rice|biryani|biriyani|pulao|pulav|khichdi|khichri/.test(n)) return 200;
    if (/idli/.test(n)) return 80;
    if (/roti|chapati|chapathi|paratha|parantha|naan|dosa|thepla|puri|poori|bhatura|kulcha|appam|uttapam/.test(n)) return 60;
    if (/samosa|pakora|pakoda|tikki|vada|bonda|cutlet|spring roll|\broll\b|kebab|kabab|tikka|momo/.test(n)) return 60;
    if (/halwa|kheer|barfi|burfi|laddu|ladoo|jalebi|gulab|rasgulla|rasmalai|sweet|dessert|ice cream|custard|payasam/.test(n)) return 100;
    if (/salad|raita|chutney|pickle|achar|papad/.test(n)) return 100;
    if (/dal|daal|sabzi|sabji|curry|paneer|gravy|kofta|korma|masala|bhaji|rajma|chole|chana|sambar|kadhi/.test(n)) return 150;
    return 150;
  }
  var INDIAN_POOL = (window.INDIAN_FOODS || []).map(function (a) {
    var sg = estServingGrams(a[0]);
    var k = 100 / sg;
    return { name: a[0], kcal: Math.round(a[1] * k), c: round1(a[2] * k), p: round1(a[3] * k), f: round1(a[4] * k), s: round1(a[5] * k), serving: sg };
  });

  function dietGoals() {
    var p = state.profile || {};
    return {
      cal: Number(p.calorieGoal) || 0,
      protein: Number(p.proteinGoal) || 0,
      carbs: Number(p.carbGoal) || 0,
      fat: Number(p.fatGoal) || 0,
      sugar: Number(p.sugarGoal) || 0
    };
  }

  function loadFoods(date) {
    return api('getFood', { date: date }).then(function (data) {
      state.foods = data.foods || [];
      state.foodsDate = date;
    });
  }

  function renderDiet() {
    if (!state.dietDate) state.dietDate = todayStr();
    var date = state.dietDate;
    var di = $('#diet-date');
    if (di) { di.value = date; di.max = todayStr(); }
    var lbl = $('#diet-date-label');
    if (lbl) lbl.textContent = (date === todayStr()) ? 'Today' : prettyDate(date);
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
  function setDietDate(date) {
    if (date > todayStr()) return;
    state.dietDate = date;
    renderDiet();
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
      s.cal += f.calories; s.p += f.protein; s.c += f.carbs; s.f += f.fat; s.s += (f.sugar || 0); return s;
    }, { cal: 0, p: 0, c: 0, f: 0, s: 0 });

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
    [['p', 'Protein', t.p, g.protein], ['c', 'Carbs', t.c, g.carbs],
     ['f', 'Fat', t.f, g.fat], ['s', 'Sugar', t.s, g.sugar]].forEach(function (m) {
      var over = m[3] && m[2] > m[3];
      var pct = m[3] ? Math.min(100, Math.round((m[2] / m[3]) * 100)) : 0;
      var row = el('div', 'macro ' + m[0] + (over ? ' over' : ''));
      var goalTxt = m[3] ? ' / ' + m[3] + 'g' + (m[0] === 's' ? ' max' : '') : '';
      row.innerHTML = '<div class="ml"><span>' + m[1] + '</span><span><b>' + Math.round(m[2]) + 'g</b>' +
        goalTxt + '</span></div>' +
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
          '<div class="fi-sub">' + (f.grams ? Math.round(f.grams) + ' g · ' : '') + 'P' + Math.round(f.protein) + ' C' + Math.round(f.carbs) + ' F' + Math.round(f.fat) + ' S' + Math.round(f.sugar || 0) + ' · <span class="fi-edit-hint">tap to edit</span></div></div>' +
          '<div class="fi-cal">' + Math.round(f.calories) + '</div>' +
          '<button class="fi-del" title="Remove">✕</button>';
        it.querySelector('.fi-body').addEventListener('click', function () { editFoodEntry(f); });
        it.querySelector('.fi-del').addEventListener('click', function (e) { e.stopPropagation(); deleteFood(f.id); });
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
    state.editingFoodId = null;
    $('#p-meal').value = meal;
    showSearchStep();
    $('#food-search').value = '';
    showRecents();
    loadCustomFoods();   // refresh shared foods so newly-added ones are searchable
    state.scanData = null;
    $('#food-manual').classList.add('hidden');
    show('#food-modal');
    setTimeout(function () { $('#food-search').focus(); }, 100);
  }

  /* Per-device food stats: frequency (most used) + recency (recent). */
  function getFoodStats() {
    try { return JSON.parse(localStorage.getItem('hard_foodstats') || '{}'); } catch (e) { return {}; }
  }
  function addRecent(food) {
    if (!food || !food.name) return;
    var m = getFoodStats();
    var k = food.name.toLowerCase();
    var ex = m[k] || { count: 0 };
    m[k] = {
      name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s,
      serving: food.serving || 100, perServing: !!food.perServing,
      count: (ex.count || 0) + 1, last: Date.now()
    };
    localStorage.setItem('hard_foodstats', JSON.stringify(m));
  }
  function showRecents() {
    var box = $('#food-results');
    box.innerHTML = '';
    var m = getFoodStats();
    var all = Object.keys(m).map(function (k) { return m[k]; });
    var most = all.filter(function (x) { return (x.count || 0) >= 2; })
                  .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    var taken = {};
    most.forEach(function (x) { taken[x.name.toLowerCase()] = 1; });
    var recent = all.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); })
                    .filter(function (x) { return !taken[x.name.toLowerCase()]; }).slice(0, 8);
    if (most.length) { box.appendChild(el('div', 'fr-head muted tiny', '⭐ Most used')); appendResults(most); }
    if (recent.length) { box.appendChild(el('div', 'fr-head muted tiny', 'Recent')); appendResults(recent); }
    if (!most.length && !recent.length) { box.appendChild(el('div', 'fr-head muted tiny', 'Popular')); appendResults(COMMON_FOODS.slice(0, 12)); }
  }
  function closeFoodModal() { hide('#food-modal'); state.pendingFood = null; state.editingFoodId = null; $('#food-modal-title').textContent = 'Add food'; }
  function showSearchStep() { $('#food-step-search').classList.remove('hidden'); $('#food-step-portion').classList.add('hidden'); }
  function showPortionStep() { $('#food-step-search').classList.add('hidden'); $('#food-step-portion').classList.remove('hidden'); }

  // Token-based match: every result must contain at least one query word,
  // ranked by how many words it matches (so "chicken boiled" surfaces all chicken).
  function localMatches(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    var pool = COMMON_FOODS.concat(state.customFoods || [], INDIAN_POOL);
    return pool.map(function (f) {
      var n = f.name.toLowerCase();
      var score = 0;
      tokens.forEach(function (t) { if (n.indexOf(t) !== -1) score++; });
      return { f: f, score: score };
    }).filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (x) { return x.f; })
      .slice(0, 40);
  }

  function runSearch(q) {
    q = q.trim();
    var results = $('#food-results');
    if (!q) { showRecents(); return; }
    var local = localMatches(q);
    renderResults(local, true);
    results.insertAdjacentHTML('beforeend', '<p class="fr-loading" id="fr-loading">Searching database…</p>');

    searchOFF(q).then(function (items) {
      var l = $('#fr-loading'); if (l) l.remove();
      var seen = {};
      local.forEach(function (x) { seen[x.name.toLowerCase()] = true; });
      var add = items.filter(function (x) {
        var k = x.name.toLowerCase();
        if (seen[k]) return false; seen[k] = true; return true;
      });
      if (!local.length && !add.length) {
        results.innerHTML = '<p class="fr-loading">No matches in the database. Use “+ Add a custom food” below to enter it from the label.</p>';
        return;
      }
      appendResults(add);
    });
  }

  function mapProduct(p) {
    var n = p.nutriments || {};
    var kcal = n['energy-kcal_100g'];
    if (kcal == null) kcal = n['energy-kcal'];
    if (kcal == null || !p.product_name) return null;
    return {
      name: p.product_name + (p.brands ? ' · ' + String(p.brands).split(',')[0] : ''),
      kcal: kcal, p: n.proteins_100g || 0, c: n.carbohydrates_100g || 0, f: n.fat_100g || 0,
      s: n.sugars_100g || 0, serving: Number(p.serving_quantity) || 100
    };
  }

  // Newer Open Food Facts search first; fall back to the legacy endpoint.
  function searchOFF(q) {
    var sal = 'https://search.openfoodfacts.org/search?q=' + encodeURIComponent(q) +
      '&page_size=30&fields=product_name,brands,nutriments,serving_quantity';
    return fetch(sal).then(function (r) { return r.json(); }).then(function (d) {
      var hits = d.hits || d.products || [];
      var items = hits.map(mapProduct).filter(Boolean);
      return items.length ? items : legacySearch(q);
    }).catch(function () { return legacySearch(q); });
  }
  function legacySearch(q) {
    var url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) +
      '&search_simple=1&action=process&json=1&page_size=40' +
      '&fields=product_name,brands,nutriments,serving_quantity';
    return fetch(url).then(function (r) { return r.json(); })
      .then(function (d) { return (d.products || []).map(mapProduct).filter(Boolean); })
      .catch(function () { return []; });
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
        '<div class="fr-sub">' + (f.perServing ? 'per serving' : 'per 100g') + ' · P' + Math.round(f.p) + ' C' + Math.round(f.c) + ' F' + Math.round(f.f) + '</div></div>' +
        '<div class="fr-cal">' + Math.round(f.kcal) + ' kcal</div>';
      it.addEventListener('click', function () { pickFood(f); });
      box.appendChild(it);
    });
  }

  function pickFood(f) {
    state.pendingFood = f;
    state.editingFoodId = null;
    $('#p-add').textContent = 'Add to diary';
    $('#p-name').textContent = f.name;
    setPortionUnit('serving');
    showPortionStep();
  }

  // Edit the quantity (and meal) of a food already in the diary.
  function editFoodEntry(f) {
    var g = Number(f.grams) > 0 ? Number(f.grams) : 100;
    state.pendingFood = {
      name: f.name, serving: 100,
      kcal: f.calories / g * 100, p: f.protein / g * 100,
      c: f.carbs / g * 100, f: f.fat / g * 100, s: (f.sugar || 0) / g * 100
    };
    state.editingFoodId = f.id;
    $('#food-modal-title').textContent = 'Edit quantity';
    $('#p-meal').value = f.meal;
    $('#p-name').textContent = f.name;
    show('#food-modal');
    showPortionStep();
    setPortionUnit('grams');
    $('#p-grams').value = Math.round(g);
    updatePortion();
    $('#p-add').textContent = 'Save changes';
  }
  function setPortionUnit(unit) {
    state.portionUnit = unit;
    $('#unit-serving').classList.toggle('active', unit === 'serving');
    $('#unit-grams').classList.toggle('active', unit === 'grams');
    var f = state.pendingFood; if (!f) return;
    if (unit === 'serving') {
      $('#p-amount-label').textContent = 'Servings (1 ≈ ' + (f.serving || 100) + ' g)';
      $('#p-grams').value = 1; $('#p-grams').step = '0.25';
    } else {
      $('#p-amount-label').textContent = 'Amount (g / ml)';
      $('#p-grams').value = f.serving || 100; $('#p-grams').step = 'any';
    }
    updatePortion();
  }
  function portionGrams() {
    var f = state.pendingFood; var amt = Number($('#p-grams').value) || 0;
    return state.portionUnit === 'serving' ? amt * (f.serving || 100) : amt;
  }
  function updatePortion() {
    var f = state.pendingFood; if (!f) return;
    var x = portionGrams() / 100;
    var k = f.kcal * x, p = f.p * x, c = f.c * x, ft = f.f * x, su = (f.s || 0) * x;
    $('#p-macros').innerHTML =
      '<div class="pm-chip"><b>' + Math.round(k) + '</b>kcal</div>' +
      '<div class="pm-chip"><b>' + Math.round(p) + '</b>protein</div>' +
      '<div class="pm-chip"><b>' + Math.round(c) + '</b>carbs</div>' +
      '<div class="pm-chip"><b>' + Math.round(ft) + '</b>fat</div>' +
      '<div class="pm-chip"><b>' + Math.round(su) + '</b>sugar</div>';
  }
  function addPortion() {
    var f = state.pendingFood; if (!f) return;
    var grams = portionGrams();
    var x = grams / 100;
    var macros = { calories: f.kcal * x, protein: f.p * x, carbs: f.c * x, fat: f.f * x, sugar: (f.s || 0) * x };
    if (state.editingFoodId) {
      var id = state.editingFoodId;
      api('updateFood', { id: id, food: Object.assign({ grams: Math.round(grams), meal: $('#p-meal').value }, macros) })
        .then(function (data) {
          for (var i = 0; i < state.foods.length; i++) { if (state.foods[i].id === id && data.food) { state.foods[i] = data.food; break; } }
          state.editingFoodId = null;
          closeFoodModal(); renderDietBody(); toast('Updated ✓');
        }).catch(function (e) { toast(e.message); });
      return;
    }
    addRecent(f);
    saveFood(Object.assign({ meal: $('#p-meal').value, name: f.name, grams: Math.round(grams) }, macros));
  }
  // Custom food entered per 100 g/ml -> share it, then set the amount.
  function manualNext() {
    var name = $('#m-name').value.trim();
    if (!name) { toast('Enter a food name'); return; }
    var sd = state.scanData || {};
    var food = {
      name: name,
      kcal: Number($('#m-cal').value) || 0,
      p: Number($('#m-protein').value) || 0,
      c: Number($('#m-carbs').value) || 0,
      f: Number($('#m-fat').value) || 0,
      s: Number($('#m-sugar').value) || 0,
      serving: 100,
      // full panel (from a scan) — stored in the backend dataset, not shown here
      satFat: sd.saturatedFat || 0, transFat: sd.transFat || 0, fiber: sd.fiber || 0, addedSugar: sd.addedSugar || 0,
      sodium: sd.sodium || 0, cholesterol: sd.cholesterol || 0, calcium: sd.calcium || 0, iron: sd.iron || 0,
      servingSize: sd.servingSize || '', data: state.scanData
    };
    saveCustomFood(food);   // share with everyone so it's searchable
    pickFood(food);
    state.scanData = null;
    $('#m-name').value = $('#m-cal').value = $('#m-protein').value = $('#m-carbs').value = $('#m-fat').value = $('#m-sugar').value = '';
  }
  function saveCustomFood(food) {
    var exists = (state.customFoods || []).some(function (f) { return f.name.toLowerCase() === food.name.toLowerCase(); });
    if (!exists) state.customFoods.push({ name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s, serving: 100, shared: true });
    api('addCustomFood', { food: {
      name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s,
      satFat: food.satFat || 0, transFat: food.transFat || 0, fiber: food.fiber || 0, addedSugar: food.addedSugar || 0,
      sodium: food.sodium || 0, cholesterol: food.cholesterol || 0, calcium: food.calcium || 0, iron: food.iron || 0,
      servingSize: food.servingSize || '', data: food.data || null
    } }).catch(function () {});
  }
  function saveFood(food) {
    food.date = state.dietDate || todayStr();
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

  /* ----- Scan a nutrition label (on-device OCR via Tesseract.js) ----- */
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = res; s.onerror = function () { rej(new Error('Could not load the scanner (no internet?)')); };
      document.head.appendChild(s);
    });
  }
  function scanStatus(msg) { var e = $('#scan-status'); if (e) e.textContent = msg || ''; }

  // Grayscale + upscale + contrast to give Tesseract a better chance.
  function fileToCanvas(file) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(2.5, Math.max(1, 1300 / img.width));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        try {
          var d = ctx.getImageData(0, 0, w, h), p = d.data;
          for (var i = 0; i < p.length; i += 4) {
            var g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
            g = (g - 128) * 1.5 + 128;
            p[i] = p[i + 1] = p[i + 2] = g < 0 ? 0 : g > 255 ? 255 : g;
          }
          ctx.putImageData(d, 0, 0);
        } catch (e) { /* ignore */ }
        res(c);
      };
      img.onerror = function () { res(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  // Compress to a JPEG base64 string for the AI scanner payload.
  function compressImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1000 / img.width);
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { res(c.toDataURL('image/jpeg', 0.6).split(',')[1]); }
        catch (e) { rej(new Error('Could not read this image.')); }
      };
      img.onerror = function () { rej(new Error('Could not open this image.')); };
      img.src = URL.createObjectURL(file);
    });
  }
  // Fill the form from an AI result (works for label reads, front-photo or name lookups).
  function applyScanResult(d) {
    state.scanData = d;   // full panel kept for the backend dataset
    var any = false;
    function put(sel, v, intval) { if (v) { $(sel).value = intval ? Math.round(v) : Math.round(v * 10) / 10; any = true; } }
    put('#m-cal', d.calories, true); put('#m-protein', d.protein); put('#m-carbs', d.carbs); put('#m-fat', d.fat); put('#m-sugar', d.sugar);
    if (d.name && !$('#m-name').value) $('#m-name').value = d.name;
    var warn = d.estimated ? ' ⚠️ AI estimate — please double-check the values.' : '';
    scanStatus(any
      ? ((d.estimated ? 'AI estimate ✓' : 'AI read ✓') + ' — check the values, then add.' + warn)
      : 'AI couldn’t find nutrition values. Try a clear photo of the nutrition panel.');
  }
  // Send one or more already-compressed base64 JPEGs to the Gemini scanner.
  function scanWithGemini(b64list) {
    if (!b64list || !b64list.length) return;
    scanStatus(b64list.length > 1 ? 'Sending front + back to AI…' : 'Sending to AI…');
    var payload = b64list.length > 1
      ? { images: b64list, mime: 'image/jpeg' }
      : { image: b64list[0], mime: 'image/jpeg' };
    api('scanLabel', payload).then(function (d) { applyScanResult(d); resetScanImages(); })
      .catch(function (e) { scanStatus(e.message || 'AI scan failed.'); });
  }
  // Look a product up by name (no photo) — AI returns typical per-100g values.
  function aiLookupByName() {
    var name = $('#m-name').value.trim();
    if (!name) { scanStatus('Type a product name above first.'); return; }
    scanStatus('Asking AI about “' + name + '”…');
    api('scanLabel', { query: name }).then(applyScanResult)
      .catch(function (e) { scanStatus(e.message || 'AI lookup failed.'); });
  }

  // Front + back collection (AI mode only).
  function resetScanImages() {
    state.scanImages = [];
    var t = $('#scan-thumbs'); if (t) t.innerHTML = '';
    var go = $('#scan-go-btn'); if (go) go.classList.add('hidden');
  }
  function renderScanThumbs() {
    var t = $('#scan-thumbs'); if (!t) return;
    t.innerHTML = '';
    (state.scanImages || []).forEach(function (b64, i) {
      var img = document.createElement('img');
      img.src = 'data:image/jpeg;base64,' + b64;
      img.title = (i === 0 ? 'Front' : 'Back') + ' — tap to remove';
      img.addEventListener('click', function () {
        state.scanImages.splice(i, 1); renderScanThumbs();
        $('#scan-go-btn').classList.toggle('hidden', !state.scanImages.length);
      });
      t.appendChild(img);
    });
  }
  function addScanImage(file) {
    compressImage(file).then(function (b64) {
      if (!state.scanImages) state.scanImages = [];
      if (state.scanImages.length >= 2) state.scanImages.shift();   // keep latest two
      state.scanImages.push(b64);
      renderScanThumbs();
      $('#scan-go-btn').classList.remove('hidden');
      scanStatus(state.scanImages.length < 2
        ? 'Front added ✓ — now add the back (nutrition table), then tap Scan now.'
        : 'Front + back added ✓ — tap Scan now.');
    }).catch(function (e) { scanStatus(e.message || 'Could not read image.'); });
  }

  function handleScanFile(file) {
    if (!file) return;
    $('#food-manual').classList.remove('hidden');
    var ai = $('#ai-scan') && $('#ai-scan').checked;
    if (ai && $('#two-img') && $('#two-img').checked) { addScanImage(file); return; }
    if (ai) { compressImage(file).then(function (b64) { scanWithGemini([b64]); }).catch(function (e) { scanStatus(e.message || 'AI scan failed.'); }); return; }
    scanStatus('Loading scanner…');
    var imgSource = file;
    loadTesseract()
      .then(function () { return fileToCanvas(file); })
      .then(function (canvas) {
        if (canvas) imgSource = canvas;
        scanStatus('Reading label… 0%');
        return Tesseract.recognize(imgSource, 'eng', {
          logger: function (m) {
            if (m.status === 'recognizing text') scanStatus('Reading label… ' + Math.round(m.progress * 100) + '%');
          }
        });
      })
      .then(function (out) {
        var r = applyLabel((out && out.data && out.data.text) || '');
        if (r.any) scanStatus('Read ✓ (' + r.note + ') — check the values, then add.');
        else scanStatus('Couldn’t read this label clearly. Try a straight, close, well-lit shot — or type the values in.');
      })
      .catch(function (e) { scanStatus(e.message || 'Scan failed.'); });
  }

  function firstNumAfter(text, kw) {
    var re = new RegExp(kw.replace(/ /g, '\\s*') + '[^0-9\\n]{0,25}?(\\d+(?:[.,]\\d+)?)', 'i');
    var m = text.match(re);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }
  function applyLabel(text) {
    var t = ' ' + text.replace(/\n/g, ' ').replace(/\s+/g, ' ') + ' ';
    var kcal = firstNumAfter(t, 'energy');
    if (kcal == null) { var mk = t.match(/(\d+(?:[.,]\d+)?)\s*kcal/i) || t.match(/kcal[^0-9]{0,10}(\d+(?:[.,]\d+)?)/i); if (mk) kcal = parseFloat(mk[1].replace(',', '.')); }
    if (kcal == null) kcal = firstNumAfter(t, 'calorie');
    var protein = firstNumAfter(t, 'protein');
    var carbs = firstNumAfter(t, 'carbohydrate'); if (carbs == null) carbs = firstNumAfter(t, 'carb');
    var fat = firstNumAfter(t, 'total fat'); if (fat == null) fat = firstNumAfter(t, 'fat');
    var sugar = firstNumAfter(t, 'total sugar'); if (sugar == null) sugar = firstNumAfter(t, 'sugar');

    // Convert per-serving labels to per-100.
    var scale = 1, note = 'per 100';
    var ps = t.match(/per\s*serv\w*[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i) || t.match(/serving\s*size[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i);
    if (ps) { var sz = parseFloat(ps[1].replace(',', '.')); if (sz > 0 && Math.abs(sz - 100) > 1) { scale = 100 / sz; note = 'converted from per ' + sz + ps[2]; } }

    var any = false;
    function put(sel, v, intval) { if (v != null) { var x = v * scale; $(sel).value = intval ? Math.round(x) : Math.round(x * 10) / 10; any = true; } }
    put('#m-cal', kcal, true); put('#m-protein', protein); put('#m-carbs', carbs); put('#m-fat', fat); put('#m-sugar', sugar);
    return { any: any, note: note };
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
    $('#scan-camera-btn').addEventListener('click', function () { $('#scan-camera').click(); });
    $('#scan-upload-btn').addEventListener('click', function () { $('#scan-upload').click(); });
    function onScanChange() { if (this.files && this.files[0]) handleScanFile(this.files[0]); this.value = ''; }
    $('#scan-camera').addEventListener('change', onScanChange);
    $('#scan-upload').addEventListener('change', onScanChange);
    $('#ai-scan').checked = localStorage.getItem('hard_aiscan') === '1';
    function syncTwoImg() {
      var on = $('#ai-scan').checked;
      $('#two-img-wrap').classList.toggle('hidden', !on);
      $('#ai-name-btn').classList.toggle('hidden', !on);
      $('#ai-hint').classList.toggle('hidden', !on);
      if (!on) { $('#two-img').checked = false; resetScanImages(); }
    }
    $('#ai-scan').addEventListener('change', function () { localStorage.setItem('hard_aiscan', this.checked ? '1' : '0'); syncTwoImg(); });
    syncTwoImg();
    $('#ai-name-btn').addEventListener('click', aiLookupByName);
    $('#two-img').addEventListener('change', function () {
      resetScanImages();
      scanStatus(this.checked ? 'Add the FRONT (name/brand), then the BACK (nutrition table), then tap Scan now.' : '');
    });
    $('#scan-go-btn').addEventListener('click', function () {
      if (state.scanImages && state.scanImages.length) scanWithGemini(state.scanImages.slice());
      else scanStatus('Add a photo first.');
    });
    $('#m-next').addEventListener('click', manualNext);
    $('#p-grams').addEventListener('input', updatePortion);
    $('#unit-serving').addEventListener('click', function () { setPortionUnit('serving'); });
    $('#unit-grams').addEventListener('click', function () { setPortionUnit('grams'); });
    $('#p-add').addEventListener('click', addPortion);
    $('#calc-goals').addEventListener('click', calcGoals);
    $('#save-goals').addEventListener('click', saveGoals);
    // Diet date navigation
    $('#diet-prev').addEventListener('click', function () { setDietDate(addDays(state.dietDate || todayStr(), -1)); });
    $('#diet-next').addEventListener('click', function () { setDietDate(addDays(state.dietDate || todayStr(), 1)); });
    $('#diet-date').addEventListener('change', function () { if (this.value) setDietDate(this.value); });
  }

  function calcGoals() {
    var sex = $('#g-sex').value;
    var age = parseFloat($('#g-age').value), cm = parseFloat($('#g-height').value), kg = parseFloat($('#g-weight').value);
    var missing = [];
    if (!(age > 0)) missing.push('age');
    if (!(cm > 0)) missing.push('height');
    if (!(kg > 0)) missing.push('weight');
    if (missing.length) { toast('Please enter your ' + missing.join(', ')); return; }
    var bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
    var act = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 }[$('#g-activity').value] || 1.2;
    var adj = { lose: -500, maintain: 0, gain: 300 }[$('#g-goaltype').value] || 0;
    var cal = Math.max(1200, Math.round((bmr * act + adj) / 10) * 10);
    var protein = Math.round(1.8 * kg);
    var fat = Math.round(cal * 0.25 / 9);
    var carbs = Math.max(0, Math.round((cal - protein * 4 - fat * 9) / 4));
    var sugar = Math.round(cal * 0.10 / 4); // WHO: keep free sugars under ~10% of calories
    $('#g-cal').value = cal; $('#g-protein').value = protein; $('#g-carbs').value = carbs; $('#g-fat').value = fat;
    $('#g-sugar').value = sugar;
    toast('Targets calculated — tap Save');
  }

  function saveGoals() {
    var profile = {
      sex: $('#g-sex').value, age: +$('#g-age').value || '', heightCm: +$('#g-height').value || '',
      weightKg: +$('#g-weight').value || '', activity: $('#g-activity').value, goalType: $('#g-goaltype').value,
      calorieGoal: +$('#g-cal').value || 0, proteinGoal: +$('#g-protein').value || 0,
      carbGoal: +$('#g-carbs').value || 0, fatGoal: +$('#g-fat').value || 0, sugarGoal: +$('#g-sugar').value || 0
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
    $('#g-sugar').value = p.sugarGoal || '';
  }

  /* ---------------- Fitness calculators ---------------- */
  var ACT_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };

  function renderCalc() {
    var p = state.profile || {};
    var pre = function (sel, v) { var e = $(sel); if (e && !e.value && (v || v === 0)) e.value = v; };
    var preSel = function (sel, v) { var e = $(sel); if (e && v) e.value = v; };
    pre('#bmi-h', p.heightCm); pre('#bmi-w', p.weightKg);
    pre('#bf-h', p.heightCm); preSel('#bf-sex', p.sex);
    $('#bf-hip-wrap').classList.toggle('hidden', $('#bf-sex').value !== 'female');
    preSel('#cal-sex', p.sex); pre('#cal-age', p.age); pre('#cal-h', p.heightCm); pre('#cal-w', p.weightKg);
    preSel('#cal-act', p.activity); preSel('#cal-goal', p.goalType);
    pre('#mac-cal', p.calorieGoal);
    preSel('#iw-sex', p.sex); pre('#iw-h', p.heightCm);
    pre('#wtr-w', p.weightKg);
  }

  function calcOut(sel, html) { $(sel).innerHTML = html; }

  function calcDispatch(type) {
    var num = function (sel) { return parseFloat($(sel).value) || 0; };
    if (type === 'bmi') {
      var h = num('#bmi-h') / 100, w = num('#bmi-w');
      if (!h || !w) return calcOut('#bmi-out', 'Enter height & weight.');
      var bmi = w / (h * h);
      var cat = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Normal' : bmi < 30 ? 'Overweight' : 'Obese';
      calcOut('#bmi-out', '<b>' + bmi.toFixed(1) + '</b> BMI · ' + cat);
    }
    else if (type === 'bodyfat') {
      var sex = $('#bf-sex').value, H = num('#bf-h'), neck = num('#bf-neck'), waist = num('#bf-waist'), hip = num('#bf-hip');
      if (!H || !neck || !waist) return calcOut('#bf-out', 'Enter height, neck & waist.');
      var bf;
      if (sex === 'female') {
        if (!hip) return calcOut('#bf-out', 'Enter hip measurement.');
        bf = 495 / (1.29579 - 0.35004 * log10(waist + hip - neck) + 0.22100 * log10(H)) - 450;
      } else {
        if (waist - neck <= 0) return calcOut('#bf-out', 'Waist must be larger than neck.');
        bf = 495 / (1.0324 - 0.19077 * log10(waist - neck) + 0.15456 * log10(H)) - 450;
      }
      calcOut('#bf-out', '<b>' + bf.toFixed(1) + '%</b> body fat (estimate)');
    }
    else if (type === 'calories') {
      var s = $('#cal-sex').value, age = num('#cal-age'), ch = num('#cal-h'), cw = num('#cal-w');
      if (!age || !ch || !cw) return calcOut('#cal-out', 'Enter age, height & weight.');
      var bmr = 10 * cw + 6.25 * ch - 5 * age + (s === 'female' ? -161 : 5);
      var tdee = bmr * (ACT_FACTORS[$('#cal-act').value] || 1.2);
      var adj = { lose: -500, maintain: 0, gain: 300 }[$('#cal-goal').value] || 0;
      var target = Math.max(1200, Math.round((tdee + adj) / 10) * 10);
      calcOut('#cal-out', 'BMR <b>' + Math.round(bmr) + '</b> · Maintain <b>' + Math.round(tdee) +
        '</b> · Target <b>' + target + '</b> kcal/day');
    }
    else if (type === 'macros') {
      var cal = num('#mac-cal');
      if (!cal) return calcOut('#mac-out', 'Enter a calorie target.');
      var r = { balanced: [.30, .40, .30], highprotein: [.40, .35, .25], lowcarb: [.40, .20, .40], keto: [.30, .10, .60] }[$('#mac-split').value];
      var prot = Math.round(cal * r[0] / 4), carb = Math.round(cal * r[1] / 4), fat = Math.round(cal * r[2] / 9);
      calcOut('#mac-out', 'Protein <b>' + prot + 'g</b> · Carbs <b>' + carb + 'g</b> · Fat <b>' + fat + 'g</b>');
    }
    else if (type === 'ideal') {
      var is = $('#iw-sex').value, ih = num('#iw-h');
      if (!ih) return calcOut('#iw-out', 'Enter height.');
      var inches = ih / 2.54;
      var devine = (is === 'female' ? 45.5 : 50) + 2.3 * Math.max(0, inches - 60);
      var m = ih / 100;
      var lo = (18.5 * m * m), hi = (24.9 * m * m);
      calcOut('#iw-out', 'Ideal <b>' + devine.toFixed(1) + ' kg</b> · healthy range ' + lo.toFixed(0) + '–' + hi.toFixed(0) + ' kg');
    }
    else if (type === 'orm') {
      var w = num('#orm-w'), reps = num('#orm-reps');
      if (!w || !reps) return calcOut('#orm-out', 'Enter weight & reps.');
      var orm = w * (1 + reps / 30);
      calcOut('#orm-out', '1RM <b>' + orm.toFixed(1) + ' kg</b> · ' +
        '80%: ' + (orm * .8).toFixed(0) + ' · 90%: ' + (orm * .9).toFixed(0) + ' kg');
    }
    else if (type === 'water') {
      var ww = num('#wtr-w');
      if (!ww) return calcOut('#wtr-out', 'Enter weight.');
      var ml = 35 * ww;
      calcOut('#wtr-out', '<b>' + (ml / 1000).toFixed(1) + ' L/day</b> (~' + Math.round(ml / 250) + ' glasses)');
    }
  }
  function log10(x) { return Math.log(x) / Math.LN10; }

  /* ---------------- Themes ---------------- */
  var THEMES = [
    { id: 'midnight', name: 'Midnight',  bg: '#0b1220', accent: '#ff5a3c' },
    { id: 'neon',     name: 'Neon Lime', bg: '#0a0a0a', accent: '#c8ff00' },
    { id: 'violet',   name: 'Violet',    bg: '#0c0a14', accent: '#a855f7' },
    { id: 'ocean',    name: 'Ocean',     bg: '#04141b', accent: '#22d3ee' },
    { id: 'crimson',  name: 'Crimson',   bg: '#140a0d', accent: '#ff4d5e' },
    { id: 'pastel',   name: 'Pastel',    bg: '#f3f1ee', accent: '#b07cff' },
    { id: 'academia', name: 'Academia',  bg: '#241c14', accent: '#c8a86a' },
    { id: 'arsenal',  name: 'Arsenal',   bg: '#ffffff', accent: '#ef0107' }
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

  /* ---------------- Admin dashboard ---------------- */
  function renderAdmin() {
    if (!isAdmin()) { switchView('today'); return; }
    $('#admin-scan-cards').innerHTML = '<p class="muted tiny">Loading…</p>';
    $('#admin-users-list').innerHTML = '<p class="muted tiny">Loading…</p>';
    $('#admin-foods-list').innerHTML = '<p class="muted tiny">Loading…</p>';
    api('adminScans', {}).then(renderAdminScans).catch(function (e) { $('#admin-scan-cards').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
    api('adminUsers', {}).then(renderAdminUsers).catch(function (e) { $('#admin-users-list').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
    api('adminFoods', {}).then(function (d) { state.adminFoods = d.foods || []; renderAdminFoods(); })
      .catch(function (e) { $('#admin-foods-list').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
  }

  function inr(v) { return '₹' + (Number(v) || 0).toFixed(Math.abs(v) >= 1 ? 2 : 3); }

  function renderAdminScans(d) {
    var cards = [
      ['Total scans', d.totalScans || 0],
      ['Total cost', inr(d.totalCostInr)],
      ['Avg / scan', inr(d.avgCostInr)],
      ['This month', inr(d.monthCostInr)],
      ['Avg tokens', (d.avgTokens || 0).toLocaleString()],
      ['≈ USD total', '$' + (Number(d.totalCostUsd) || 0).toFixed(4)]
    ];
    $('#admin-scan-cards').innerHTML = cards.map(function (c) {
      return '<div class="stat"><div class="num">' + c[1] + '</div><div class="lbl">' + c[0] + '</div></div>';
    }).join('');

    $('#admin-scan-byuser').innerHTML = (d.byUser || []).length
      ? d.byUser.map(function (u) {
          return '<div class="admin-row"><span>' + esc(u.username) + '</span><span class="amono">' + u.scans + ' · ' + inr(u.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">No scans yet.</p>';

    $('#admin-scan-bymodel').innerHTML = (d.byModel || []).length
      ? d.byModel.map(function (m) {
          return '<div class="admin-row"><span>' + esc(m.model) + '</span><span class="amono">' + m.scans + ' · ' + inr(m.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">—</p>';

    $('#admin-scan-recent').innerHTML = (d.recent || []).length
      ? d.recent.map(function (r) {
          var when = String(r.at || '').slice(0, 16).replace('T', ' ');
          var label = (r.name || '(unnamed)') + (r.images > 1 ? ' · ' + r.images + ' imgs' : '');
          return '<div class="admin-row"><span>' + esc(label) + '<br><span class="muted tiny">' + when + ' · ' + esc(r.username) + ' · ' + r.tokens.toLocaleString() + ' tok</span></span>' +
                 '<span class="amono">' + inr(r.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">No scans yet.</p>';
  }

  function renderAdminUsers(d) {
    var list = $('#admin-users-list');
    if (!d.users || !d.users.length) { list.innerHTML = '<p class="muted tiny">No users.</p>'; return; }
    // Newest signups first so the admin can spot who just joined.
    var users = (d.users || []).slice().sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    var weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    var newCount = users.filter(function (u) { return u.createdAt && u.createdAt >= weekAgo; }).length;
    list.innerHTML = '<p class="muted tiny" style="margin:2px">' + d.total + ' user' + (d.total === 1 ? '' : 's') +
        (newCount ? ' · 🆕 ' + newCount + ' joined this week' : '') + '</p>' +
      users.map(function (u) {
        var isNew = u.createdAt && u.createdAt >= weekAgo;
        var joined = u.createdAt ? String(u.createdAt).slice(0, 10) : '—';
        return '<div class="admin-user"><div class="au-top"><span class="au-name">' + esc(u.displayName) +
          (isNew ? ' <span class="new-badge">NEW</span>' : '') +
          (u.isAdmin ? ' <span class="muted tiny">· admin</span>' : '') + '</span>' +
          '<span class="muted tiny">Day ' + u.currentDay + '</span></div>' +
          '<div class="au-sub">@' + esc(u.username) + ' · 🔥 ' + u.streak + ' streak · ✅ ' + u.completedDays + ' days done · today ' + u.todayDone + '/7<br>' +
          '🍽 ' + u.foodLogs + ' food logs · joined ' + esc(joined) + ' · started ' + esc(u.startDate) + ' · last active ' + (u.lastActive ? esc(u.lastActive) : '—') + '</div></div>';
      }).join('');
  }

  function renderAdminFoods() {
    var list = $('#admin-foods-list');
    var all = state.adminFoods || [];
    var q = ($('#admin-food-filter').value || '').trim().toLowerCase();
    var foods = q ? all.filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; }) : all;
    if (!foods.length) { list.innerHTML = '<p class="muted tiny">' + (all.length ? 'No matches.' : 'No scanned foods yet.') + '</p>'; return; }
    var fields = [
      ['kcal', 'Cal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['sugar', 'Sugar'],
      ['satFat', 'Sat fat'], ['transFat', 'Trans'], ['fiber', 'Fibre'], ['addedSugar', 'Add sugar'],
      ['sodium', 'Sodium'], ['cholesterol', 'Chol'], ['calcium', 'Calcium'], ['iron', 'Iron']
    ];
    list.innerHTML = foods.map(function (f) {
      var grid = fields.map(function (fl) {
        return '<label>' + fl[1] + '<input type="number" inputmode="decimal" data-f="' + fl[0] + '" value="' + (f[fl[0]] || 0) + '" /></label>';
      }).join('');
      return '<div class="admin-food" data-id="' + esc(f.id) + '">' +
        '<div class="af-head"><input data-f="name" value="' + esc(f.name) + '" /></div>' +
        '<div class="af-grid">' + grid +
        '<label>Serving<input data-f="servingSize" value="' + esc(f.servingSize || '') + '" /></label></div>' +
        '<div class="af-meta">by ' + esc(f.createdBy || '—') + ' · ' + String(f.createdAt || '').slice(0, 10) + '</div>' +
        '<div class="af-actions"><button class="btn primary" data-save="' + esc(f.id) + '">Save</button>' +
        '<button class="btn danger" data-del="' + esc(f.id) + '">Delete</button></div></div>';
    }).join('');
  }

  function adminSaveFood(id, btn) {
    var card = btn.closest('.admin-food'); if (!card) return;
    var patch = { id: id };
    card.querySelectorAll('[data-f]').forEach(function (el) { patch[el.getAttribute('data-f')] = el.value; });
    btn.disabled = true; btn.textContent = 'Saving…';
    api('adminUpdateFood', patch).then(function () {
      btn.textContent = 'Saved ✓';
      // reflect locally so a re-filter keeps the new values
      var rec = (state.adminFoods || []).filter(function (x) { return x.id === id; })[0];
      if (rec) Object.keys(patch).forEach(function (k) { if (k !== 'id') rec[k] = k === 'name' || k === 'servingSize' ? patch[k] : (Number(patch[k]) || 0); });
      setTimeout(function () { btn.disabled = false; btn.textContent = 'Save'; }, 1200);
      toast('Saved ✓');
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Save'; toast(e.message); });
  }

  function adminDeleteFood(id) {
    var rec = (state.adminFoods || []).filter(function (x) { return x.id === id; })[0];
    if (!confirm('Delete "' + (rec ? rec.name : 'this food') + '" from the shared directory? This can’t be undone.')) return;
    api('adminDeleteFood', { id: id }).then(function () {
      state.adminFoods = (state.adminFoods || []).filter(function (x) { return x.id !== id; });
      renderAdminFoods(); toast('Deleted');
    }).catch(function (e) { toast(e.message); });
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
