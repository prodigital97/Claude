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
    bizSelected: null,
    money: null,
    coachHistory: null,
    coachBusy: false,
    scanData: null,
    pendingFood: null,
    editingFoodId: null,
    activeFast: null,
    fastTimer: null,
    calMonth: null,          // 'YYYY-MM' shown in the Journey calendar
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
  var MONEY_DEFAULT_CATS = [
    ['Food & Dining', 'Groceries', 'need', '🛒', '#16a34a'], ['Food & Dining', 'Restaurants', 'want', '🍽️', '#f59e0b'],
    ['Food & Dining', 'Online Delivery', 'want', '🛵', '#ef4444'], ['Transport', 'Fuel', 'need', '⛽', '#0ea5e9'],
    ['Transport', 'Cabs / Ride-share', 'want', '🚕', '#38bdf8'], ['Entertainment', 'OTT / Subscriptions', 'want', '📺', '#a855f7'],
    ['Shopping', 'General Shopping', 'want', '🛍️', '#be185d'], ['Health', 'Pharmacy', 'need', '💊', '#14b8a6'],
    ['Bills & Utilities', 'Rent / EMI', 'need', '🏠', '#64748b'], ['Bills & Utilities', 'Internet / Mobile', 'need', '📶', '#334155'],
    ['Money', 'Savings & Investments', 'saving', '📈', '#10b981'], ['Income', 'Income', 'income', '💰', '#22c55e'],
    ['Other', 'Miscellaneous', 'want', '📦', '#6b7280']
  ];

  function offlineApi(action, p) {
    var d = db();
    function pub(u) {
      return { username: u.username, displayName: u.displayName, startDate: u.startDate,
        currentDay: dayNumber(u.startDate, todayStr()), challengeLength: LEN, waterGoalMl: WATER_GOAL,
        email: u.email || '', emailVerified: !!u.emailVerified };
    }
    function userLogs(un) { return (d.logs[un] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }

    if (action === 'register') {
      var un = (p.username || '').toLowerCase().trim();
      if (un.length < 3) throw new Error('Username must be at least 3 characters.');
      if (d.users[un]) throw new Error('That username is already taken.');
      d.users[un] = { username: un, displayName: p.displayName || un, password: p.password,
        startDate: p.startDate || todayStr(), token: 't_' + un, email: p.email || '', emailVerified: !!p.email };
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

    if (action === 'updateEmail') { me.email = p.email || ''; me.emailVerified = !!p.email; saveDb(d); return { user: pub(me) }; }
    if (action === 'changePassword') { me.password = p.newPassword; saveDb(d); return { ok: true }; }
    if (action === 'adminResetPassword') {
      var tu = d.users[(p.username || '').toLowerCase().trim()];
      if (tu) { tu.password = p.newPassword; saveDb(d); }
      return { ok: true, username: p.username };
    }
    if (action === 'changeUsername') {
      var nn = (p.newUsername || '').toLowerCase().trim();
      if (d.users[nn]) throw new Error('That username is already taken.');
      delete d.users[me.username]; me.username = nn; d.users[nn] = me; saveDb(d);
      return { token: me.token, user: pub(me) };
    }

    // ---- Money Manager (offline demo mode) ----
    if (action.indexOf('money') === 0) {
      d.money = d.money || {};
      var mm = d.money[me.username] || (d.money[me.username] = { accounts: [], categories: [], txns: [], budget: {} });
      var moneyStatus = function () {
        var limit = Number(mm.budget.limit) || 0;
        var from = todayStr().slice(0, 7) + '-01', today2 = todayStr();
        var spent = mm.txns.filter(function (t) { return t.type === 'expense' && t.date >= from && t.date <= today2; }).reduce(function (s, t) { return s + (Number(t.amount) || 0); }, 0);
        var now = new Date(), daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), dayOfMonth = now.getDate();
        var daysLeft = Math.max(1, daysInMonth - dayOfMonth + 1);
        var pct = limit > 0 ? spent / limit : 0;
        var level = limit <= 0 ? 'none' : (pct >= 1 ? 'stop' : pct >= 0.85 ? 'critical' : pct >= 0.70 ? 'warn' : 'ok');
        var remaining = limit > 0 ? Math.max(0, limit - spent) : 0;
        return { limit: limit, spent: spent, remaining: remaining, pct: pct, level: level, daysLeft: daysLeft, daysInMonth: daysInMonth, dayOfMonth: dayOfMonth, safePerDay: limit > 0 ? remaining / daysLeft : 0, projection: dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0, categoryFlags: [] };
      };
      var moneyDashboardCalc = function () {
        var from2 = todayStr().slice(0, 7) + '-01';
        var catMap = {}; mm.categories.forEach(function (c) { catMap[c.id] = c; });
        var byCategory = {}, byKind = { need: 0, want: 0, saving: 0 }, byMerchant = {}, totalSpend = 0;
        mm.txns.filter(function (t) { return t.date >= from2 && t.type === 'expense'; }).forEach(function (t) {
          var c = catMap[t.categoryId] || { name: 'Uncategorised', kind: 'want', icon: '❓', color: '#6b7280' };
          totalSpend += Number(t.amount) || 0;
          byCategory[t.categoryId] = (byCategory[t.categoryId] || 0) + (Number(t.amount) || 0);
          byKind[c.kind] = (byKind[c.kind] || 0) + (Number(t.amount) || 0);
          var m = t.merchant || '(unknown)'; byMerchant[m] = (byMerchant[m] || 0) + (Number(t.amount) || 0);
        });
        var catList = Object.keys(byCategory).map(function (id) { var c = catMap[id] || {}; return { id: id, name: c.name || 'Uncategorised', icon: c.icon || '❓', color: c.color || '#6b7280', total: byCategory[id] }; }).sort(function (a, b) { return b.total - a.total; });
        var merchList = Object.keys(byMerchant).map(function (m) { return { merchant: m, total: byMerchant[m] }; }).sort(function (a, b) { return b.total - a.total; }).slice(0, 8);
        return { totalSpend: totalSpend, byCategory: catList, byKind: byKind, topMerchants: merchList, status: moneyStatus() };
      };
      if (action === 'moneyGetState') {
        if (!mm.categories.length) {
          mm.categories = MONEY_DEFAULT_CATS.map(function (c) { return { id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: c[1], group: c[0], kind: c[2], icon: c[3], color: c[4] }; });
        }
        saveDb(d);
        return { accounts: mm.accounts, categories: mm.categories, budget: mm.budget, status: moneyStatus(), dashboard: moneyDashboardCalc() };
      }
      if (action === 'moneyAddAccount') { var acc = Object.assign({ id: 'a_' + Date.now().toString(36) }, p.account); mm.accounts.push(acc); saveDb(d); return { account: acc }; }
      if (action === 'moneyDeleteAccount') { mm.accounts = mm.accounts.filter(function (a) { return a.id !== p.id; }); saveDb(d); return { deleted: p.id }; }
      if (action === 'moneyAddCategory') { var mc = Object.assign({ id: 'c_' + Date.now().toString(36) }, p.category); mm.categories.push(mc); saveDb(d); return { category: mc }; }
      if (action === 'moneyDeleteCategory') { mm.categories = mm.categories.filter(function (c) { return c.id !== p.id; }); saveDb(d); return { deleted: p.id }; }
      if (action === 'moneyGetTxns') { var lim = Number(p.limit) || 0; var list = mm.txns.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }); return { transactions: lim ? list.slice(0, lim) : list }; }
      if (action === 'moneyAddTxn') { var tx = Object.assign({ id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: todayStr() }, p.transaction); mm.txns.push(tx); saveDb(d); return { transaction: tx, status: moneyStatus() }; }
      if (action === 'moneyAddTxns') {
        var added = (p.transactions || []).map(function (t) { return Object.assign({ id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, t); });
        added.forEach(function (t) { mm.txns.push(t); }); saveDb(d);
        return { added: added.length, transactions: added, status: moneyStatus() };
      }
      if (action === 'moneyDeleteTxn') { mm.txns = mm.txns.filter(function (t) { return t.id !== p.id; }); saveDb(d); return { deleted: p.id, status: moneyStatus() }; }
      if (action === 'moneyUpdateTxn') {
        var etx = mm.txns.filter(function (t) { return t.id === (p.transaction && p.transaction.id); })[0];
        if (etx) Object.assign(etx, p.transaction);
        saveDb(d); return { transaction: etx || null, status: moneyStatus() };
      }
      if (action === 'moneyDashboard') return moneyDashboardCalc();
      if (action === 'moneySaveBudget') {
        mm.budget = { limit: Number(p.overall) || 0, perCategory: p.perCategory || {}, monthlyIncome: Number(p.monthlyIncome) || 0, savingsGoal: Number(p.savingsGoal) || 0 };
        saveDb(d); return { budget: mm.budget, status: moneyStatus() };
      }
      if (action === 'moneyParseScreenshot' || action === 'moneyParseMessage' || action === 'moneyCoachChat') {
        throw new Error('This needs the online backend (Gemini) — not available in demo mode.');
      }
    }

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
      if (row) { ['grams', 'calories', 'protein', 'carbs', 'fat', 'sugar', 'fiber'].forEach(function (k) { row[k] = p.food[k]; }); saveDb(d); }
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
      var tt = { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 };
      all.forEach(function (x) {
        tt.cal += Number(x.calories) || 0; tt.p += Number(x.protein) || 0; tt.c += Number(x.carbs) || 0;
        tt.f += Number(x.fat) || 0; tt.s += Number(x.sugar) || 0; tt.fb += Number(x.fiber) || 0;
      });
      var days = {}; all.forEach(function (x) { days[x.date] = true; });
      var n = Object.keys(days).length;
      var av = function (v) { return n ? Math.round(v / n) : 0; };
      return { totalCalories: Math.round(tt.cal), daysLogged: n, avgCalories: av(tt.cal),
        avgProtein: av(tt.p), avgCarbs: av(tt.c), avgFat: av(tt.f), avgSugar: av(tt.s), avgFiber: av(tt.fb) };
    }
    if (action === 'saveDay') {
      var day = p.day; day.completed = goalMet(day);
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
    if (action === 'coachChat') return { reply: 'The AI coach needs the online backend (Gemini) — it isn’t available in demo mode.' };
    if (action === 'listGet') { return { items: ((d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) || []).slice() }; }
    if (action === 'listAdd') {
      d.lists = d.lists || {}; d.lists[me.username] = d.lists[me.username] || {};
      var la = d.lists[me.username][p.kind] || (d.lists[me.username][p.kind] = []);
      var rec = Object.assign({ id: 'l_' + Date.now() + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() }, p.item);
      la.push(rec); saveDb(d); return { item: rec };
    }
    if (action === 'listUpdate') {
      var lu = ((d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) || []).filter(function (x) { return x.id === p.id; })[0];
      if (lu) { Object.assign(lu, p.item); saveDb(d); } return { ok: true, id: p.id };
    }
    if (action === 'listDelete') {
      if (d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) d.lists[me.username][p.kind] = d.lists[me.username][p.kind].filter(function (x) { return x.id !== p.id; });
      saveDb(d); return { ok: true, id: p.id };
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
  // 75 Hard vs 75 Soft (per-user, stored in profile).
  function challengeMode() { return (state.profile && state.profile.mode) === 'soft' ? 'soft' : 'hard'; }
  function softTarget() { var t = Number(state.profile && state.profile.softTarget) || 70; return Math.min(100, Math.max(20, t)); }
  function softNeeded() { return Math.max(1, Math.ceil(softTarget() / 100 * TOTAL_ITEMS)); }
  // Does this day count toward streak / "completed days" for the user's chosen mode?
  function goalMet(d) {
    if (challengeMode() === 'soft') return completedCount(d) >= softNeeded();
    return isComplete(d);
  }
  function streakOf(logs) {
    // Count consecutive complete days ending today (or yesterday if today's
    // still in progress, so an unfinished today doesn't zero your streak).
    var set = {};
    logs.forEach(function (l) { if (goalMet(l)) set[l.date] = true; });
    var d = todayStr();
    if (!set[d]) d = addDays(d, -1);
    var s = 0;
    while (set[d]) { s++; d = addDays(d, -1); }
    return s;
  }
  function emptyDay(date) {
    return { date: date, dayNumber: state.user ? dayNumber(state.user.startDate, date) : 1,
      workout1: false, workout2: false, outdoor: false, waterMl: 0,
      reading: false, photo: false, diet: false, noAlcohol: false, completed: false, notes: '', extra: {}, mood: 0, gut: 0, biz: {}, metrics: {} };
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
        username: f.username.value, password: f.password.value, displayName: f.displayName.value,
        startDate: f.startDate.value, email: f.email.value
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
    switchView('home');
    prefetchStats();   // warm Stats averages in the background
  }

  function loadCustomFoods() {
    api('getCustomFoods', {}).then(function (data) {
      state.customFoods = (data.foods || []).map(function (f) {
        return { name: f.name, kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat, s: f.sugar, fb: f.fiber || 0, serving: 100, shared: true };
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
      var d = appDay(); d.notes = this.value; queueSaveDay(d);
    });
    $('#add-habit-btn').addEventListener('click', addHabit);
    $('#new-habit').addEventListener('keydown', function (e) { if (e.key === 'Enter') addHabit(); });
    $('#add-biz-btn').addEventListener('click', addBusiness);
    $('#new-biz').addEventListener('keydown', function (e) { if (e.key === 'Enter') addBusiness(); });
    $('#logout').addEventListener('click', logout);
    $('#reset-challenge').addEventListener('click', resetChallenge);
    $('#save-profile').addEventListener('click', saveProfile);
    $('#acct-email-btn').addEventListener('click', acctEmailSave);
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { pickMode(b.dataset.mode); });
    });
    $('#save-mode').addEventListener('click', saveMode);
    $('#acct-username-btn').addEventListener('click', acctChangeUsername);
    $('#acct-pw-btn').addEventListener('click', acctChangePassword);
    $('#save-startdate').addEventListener('click', saveStartDate);
    $('#delete-account').addEventListener('click', deleteAccount);
    // Journey month navigation + Life Score history chips
    $('#cal-prev').addEventListener('click', function () {
      state.calMonth = ymShift(state.calMonth || ymOf(todayStr()), -1);
      renderCalendar();
    });
    $('#cal-next').addEventListener('click', function () {
      state.calMonth = ymShift(state.calMonth || ymOf(todayStr()), 1);
      renderCalendar();
    });
    $('#month-report').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-ym]');
      if (chip) { state.calMonth = chip.getAttribute('data-ym'); renderCalendar(); }
    });
    $('#home-score').addEventListener('click', function () {
      state.calMonth = ymOf(todayStr());
      switchView('calendar');
    });
    $('#day-close').addEventListener('click', function () { hide('#day-modal'); });
    $('#day-modal').addEventListener('click', function (e) { if (e.target.id === 'day-modal') hide('#day-modal'); });
    $('#day-save').addEventListener('click', saveDayEditor);
    $('#de-notes').addEventListener('input', function () { if (state.editDay) state.editDay.notes = this.value; });
    document.querySelectorAll('[data-calc]').forEach(function (b) {
      b.addEventListener('click', function () { calcDispatch(b.dataset.calc); });
    });
    $('#bf-sex').addEventListener('change', function () {
      $('#bf-hip-wrap').classList.toggle('hidden', this.value !== 'female');
    });
    // Once the user edits an auto-filled Calc field, stop overwriting it —
    // everything else keeps syncing live from the latest Body log.
    $('#view-calc').addEventListener('input', function (e) { if (e.target.id) state.calcTouched[e.target.id] = true; });
    $('#view-calc').addEventListener('change', function (e) { if (e.target.id) state.calcTouched[e.target.id] = true; });
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
    $('#admin-users-list').addEventListener('click', function (e) {
      var r = e.target.closest('[data-resetpw]');
      if (r) adminResetUserPassword(r.getAttribute('data-resetpw'));
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
    // ATLAS home + library
    $('#view-home').addEventListener('click', function (e) {
      var qa = e.target.closest('[data-qa]'); var pil = e.target.closest('[data-pillar]');
      if (e.target.closest('#home-journey-open')) { switchView('calendar'); return; }
      if (qa) homeQuickAction(qa.getAttribute('data-qa'));
      else if (pil) switchView('library');
    });
    $('#library-groups').addEventListener('click', function (e) {
      var t = e.target.closest('[data-app]');
      if (t) openApp(t.getAttribute('data-app'));
    });
    // AI Coach
    $('#coach-fab').addEventListener('click', function () { openCoach('hard'); });
    $('#coach-close').addEventListener('click', function () { hide('#coach-modal'); });
    $('#coach-clear').addEventListener('click', clearCoach);
    $('#coach-send').addEventListener('click', sendCoach);
    $('#coach-modal').addEventListener('click', function (e) { if (e.target.id === 'coach-modal') hide('#coach-modal'); });
    $('#coach-text').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(96, this.scrollHeight) + 'px'; });
    $('#coach-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCoach(); }
    });
    bindDietEvents();
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (name !== 'diet' && name !== 'fast') stopFastTimer();
    if (name !== 'breathe') stopBreathe();
    // Leaving the mini-apps resets day-editing back to today.
    if (name === 'home' || name === 'today' || name === 'library') state.appDate = null;
    if (name === 'home') renderHome();
    if (name === 'library') renderLibrary();
    if (name === 'today') renderToday();
    if (name === 'water') renderWaterApp();
    if (name === 'fast') renderFasting();
    if (name === 'mood') renderMoodApp();
    if (name === 'gut') renderGutApp();
    if (name === 'habits') renderHabitsApp();
    if (name === 'work') renderWorkApp();
    if (name === 'journal') renderJournal();
    if (name === 'reading') renderReading();
    if (name === 'steps') renderSteps();
    if (name === 'sleep') renderSleep();
    if (name === 'body') renderBody();
    if (name === 'gym') renderGym();
    if (name === 'breathe') renderBreathe();
    if (name === 'detox') renderDetox();
    if (name === 'meds') renderMeds();
    if (name === 'money') renderMoney();
    if (name === 'subs') renderSubs();
    if (name === 'savings') renderSavings();
    if (name === 'tasks') renderTasks();
    if (name === 'goals') renderGoals();
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
    if (cd > 2000 || cd < 0) {
      // Start date is clearly wrong (e.g. the year-2000 bug) — nudge to fix it.
      pill.innerHTML = '⚠️ Set start date';
      pill.style.cursor = 'pointer';
      pill.onclick = function () { switchView('settings'); };
    } else if (cd <= LEN) {
      pill.innerHTML = 'Day <span id="hdr-day">' + Math.max(1, cd) + '</span> <span class="muted">/ ' + LEN + '</span>';
      pill.onclick = null; pill.style.cursor = '';
    } else {
      // Life mode — the 75 are conquered, the counter keeps climbing.
      pill.innerHTML = 'Day <span id="hdr-day">' + cd + '</span> <span class="muted">🏆</span>';
      pill.onclick = null; pill.style.cursor = '';
    }
    renderToday();
  }
  function firstName(n) { return String(n || 'athlete').split(' ')[0]; }

  function renderToday() {
    var d = state.today;
    $('#today-date').textContent = prettyDate(d.date);

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
    var met = goalMet(d);
    var soft = challengeMode() === 'soft';
    var ring = $('#ring-fg');
    var circ = 2 * Math.PI * 52;
    ring.style.strokeDashoffset = circ * (1 - count / TOTAL_ITEMS);
    ring.style.stroke = met ? 'var(--green)' : 'var(--primary)';
    $('#ring-pct').textContent = pct + '%';

    var st = $('#today-status');
    if (met) { st.textContent = soft ? 'Goal met! 🎉' : 'Day complete! 🎉'; st.className = 'status-chip done'; }
    else { st.textContent = count + ' / ' + TOTAL_ITEMS + ' done' + (soft ? ' · need ' + softNeeded() : ''); st.className = 'status-chip pending'; }

    $('#streak-line').textContent = '🔥 ' + streakOf(state.logs) + ' day streak';
  }

  /* ----- Journal (mood check-in + note) ----- */
  function renderJournal() {
    var bar = $('#journal-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderJournal); }
    renderMood(appDay(), '#journal-mood');
    $('#day-notes').value = appDay().notes || '';
  }

  /* ----- Mood / Gut mini-apps: selector + colored month calendar ----- */
  function renderMoodApp() {
    var bar = $('#mood-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderMoodApp); }
    renderMood(appDay(), '#mood-buttons');
    var cal = $('#mood-cal');
    if (cal) {
      buildDayPicker(cal, ymOf(appDate()), renderMoodApp, function (date) {
        var l = logFor(date);
        return l && l.mood ? moodColor(l.mood) : null;
      });
      cal.classList.remove('hidden');
    }
    var leg = $('#mood-legend');
    if (leg) leg.innerHTML = MOODS.map(function (mm) {
      return '<span class="gt-key"><i style="background:' + mm.color + '"></i>' + mm.emoji + ' ' + mm.label + '</span>';
    }).join('');
  }
  function renderGutApp() {
    var bar = $('#gut-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderGutApp); }
    renderGut(appDay(), '#gut-buttons');
    var cal = $('#gut-cal');
    if (cal) {
      buildDayPicker(cal, ymOf(appDate()), renderGutApp, function (date) {
        var l = logFor(date);
        return l && l.gut ? gutColor(l.gut) : null;
      });
      cal.classList.remove('hidden');
    }
    var leg = $('#gut-legend');
    if (leg) leg.innerHTML = GUT.map(function (g) {
      return '<span class="gt-key"><i style="background:' + g.color + '"></i>' + g.emoji + ' ' + g.label + '</span>';
    }).join('');
    // last-30-day counts
    var counts = {}, logged = 0, today = todayStr();
    for (var i = 0; i < 30; i++) {
      var l = logFor(addDays(today, -i));
      if (l && l.gut) { counts[l.gut] = (counts[l.gut] || 0) + 1; logged++; }
    }
    var cbox = $('#gut-counts');
    if (cbox) cbox.textContent = logged
      ? 'Last 30 days: ' + GUT.filter(function (g) { return counts[g.v]; }).map(function (g) { return g.label + ' ' + counts[g.v]; }).join(' · ')
      : 'No gut logs yet — tap an option above.';
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
  function renderMood(d, sel) {
    var box = $(sel || '#mood-buttons'); if (!box) return;
    box.innerHTML = '';
    MOODS.forEach(function (m) {
      var on = d.mood === m.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', m.color);
      b.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span>';
      b.addEventListener('click', function () {
        d.mood = (d.mood === m.v) ? 0 : m.v;
        // Reflect on whichever mood widgets exist (Mood app + Journal).
        renderMood(d, '#mood-buttons'); renderMood(d, '#journal-mood');
        queueSaveDay(d);
        if (!$('#view-mood').classList.contains('hidden')) renderMoodApp();
      });
      box.appendChild(b);
    });
  }

  /* ----- Gut health tracker (does NOT affect 75 Hard completion) ----- */
  var GUT = [
    { v: 1, label: 'Didn’t go',   emoji: '🚫', color: '#8da3c4' },
    { v: 2, label: 'Hard',        emoji: '🪨', color: '#ff9f43' },
    { v: 3, label: 'Healthy',     emoji: '✅', color: '#2fd47a' },
    { v: 4, label: 'Soft',        emoji: '💧', color: '#4bb6ff' },
    { v: 5, label: 'Loose',       emoji: '🌊', color: '#ff5470' },
    { v: 6, label: 'Bloated',     emoji: '🎈', color: '#e3b341' },
    { v: 7, label: 'Acidity',     emoji: '🔥', color: '#f97316' }
  ];
  function gutColor(v) { for (var i = 0; i < GUT.length; i++) if (GUT[i].v === v) return GUT[i].color; return null; }
  function gutLabel(v) { for (var i = 0; i < GUT.length; i++) if (GUT[i].v === v) return GUT[i].label; return null; }
  function renderGut(d, sel) {
    var box = $(sel || '#gut-buttons'); if (!box) return;
    box.innerHTML = '';
    GUT.forEach(function (g) {
      var on = d.gut === g.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', g.color);
      b.innerHTML = '<span class="mood-emoji">' + g.emoji + '</span><span class="mood-label">' + g.label + '</span>';
      b.addEventListener('click', function () {
        d.gut = (d.gut === g.v) ? 0 : g.v;
        renderGut(d, '#gut-buttons');
        queueSaveDay(d);
        if (!$('#view-gut').classList.contains('hidden')) renderGutApp();
      });
      box.appendChild(b);
    });
  }

  /* ----- Custom daily habits (do NOT affect 75 Hard completion) ----- */
  function renderHabitsApp() {
    var bar = $('#habits-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderHabitsApp); }
    renderExtraTasks(appDay());
  }
  // Streak of consecutive days this habit was done (ending today or yesterday).
  function habitStreak(id) {
    var d = todayStr();
    var l = logFor(d);
    if (!l || !l.extra || !l.extra[id]) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || !lg.extra || !lg.extra[id]) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  var HABIT_STARTERS = ['🧘 Meditate 10 min', '🚶 Evening walk', '🧴 Skincare', '🙏 Gratitude note', '🧹 Tidy desk', '📵 No phone in bed'];
  function habitEmoji(name) {
    // If the user typed an emoji first, use it as the icon.
    var m = String(name).match(/^(\p{Extended_Pictographic}(?:️)?)\s*/u);
    return m ? m[1] : null;
  }
  function renderExtraTasks(d) {
    var list = $('#extra-tasks'); if (!list) return;
    if (!d.extra) d.extra = {};
    var habits = (state.profile && state.profile.customTasks) || [];
    list.innerHTML = '';

    if (habits.length) {
      // Week header: completion across all habits over the last 7 days.
      var hits = 0, slots = 0, today = todayStr();
      for (var i = 0; i < 7; i++) {
        var lg = logFor(addDays(today, -i));
        habits.forEach(function (h) { slots++; if (lg && lg.extra && lg.extra[h.id]) hits++; });
      }
      var wkPct = slots ? Math.round(hits / slots * 100) : 0;
      var head = el('div', 'card hero-row' + (wkPct >= 80 ? ' goal-hit' : ''));
      head.innerHTML = ringMini(wkPct, 'var(--life-c)', 84, '<b>' + wkPct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>This week</b></div>' +
        '<div class="muted tiny">' + hits + ' of ' + slots + ' habit checks done</div></div>';
      list.appendChild(head);
    }

    habits.forEach(function (h) {
      var done = !!d.extra[h.id];
      var streak = habitStreak(h.id);
      var em = habitEmoji(h.name) || '📌';
      var title = habitEmoji(h.name) ? h.name.replace(/^(\p{Extended_Pictographic}(?:️)?)\s*/u, '') : h.name;
      // Last-7-days dot strip (Loop/Streaks-style).
      var dots = '';
      for (var i = 6; i >= 0; i--) {
        var dte = addDays(todayStr(), -i);
        var lg2 = dte === d.date ? d : logFor(dte);
        dots += '<i class="hdot' + (lg2 && lg2.extra && lg2.extra[h.id] ? ' on' : '') + (dte === todayStr() ? ' td' : '') + '"></i>';
      }
      var row = el('div', 'task habit' + (done ? ' done' : ''));
      row.innerHTML =
        '<div class="check">✓</div>' +
        '<div class="t-emoji">' + em + '</div>' +
        '<div class="t-body"><div class="t-title">' + esc(title) +
          (streak > 1 ? ' <span class="hstreak">🔥' + streak + '</span>' : '') + '</div>' +
        '<div class="hdots">' + dots + '</div></div>' +
        '<button class="habit-del" title="Remove">✕</button>';
      row.addEventListener('click', function (e) {
        if (e.target.classList.contains('habit-del')) return;
        d.extra[h.id] = !d.extra[h.id];
        renderExtraTasks(d);
        queueSaveDay(d);
      });
      row.querySelector('.habit-del').addEventListener('click', function (e) {
        e.stopPropagation();
        removeHabit(h.id);
      });
      list.appendChild(row);
    });

    if (!habits.length) {
      var empty = el('div', 'card');
      empty.innerHTML = '<p class="muted tiny" style="margin:0 0 10px">No habits yet — start with one of these, or add your own below. Tip: start a habit name with an emoji to make it the icon.</p>' +
        '<div class="starter-chips">' + HABIT_STARTERS.map(function (s) {
          return '<button type="button" class="starter-chip" data-starter="' + esc(s) + '">' + s + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-starter]').forEach(function (b) {
        b.addEventListener('click', function () {
          var next = (state.profile.customTasks || []).slice();
          next.push({ id: 'h_' + Date.now().toString(36), name: b.getAttribute('data-starter') });
          saveHabits(next);
        });
      });
      list.appendChild(empty);
    }
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
    renderExtraTasks(appDay());
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
    }).catch(function (e) { toast(e.message); });
  }

  /* ----- Businesses: time + tasks per business per day (not part of 75 Hard) ----- */
  function businesses() { return (state.profile && state.profile.businesses) || []; }
  function hoursMin(min) {
    min = Math.round(Number(min) || 0);
    if (min <= 0) return '0m';
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm' : (h ? '' : '0m'));
  }
  function renderWorkApp() {
    var bar = $('#work-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderWorkApp); }
    renderBusinesses(appDay());
  }
  function renderBusinesses(d) {
    var box = $('#biz-list'); if (!box) return;
    if (!d.biz) d.biz = {};
    var list = businesses();
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="muted tiny" style="margin:2px 2px 10px">No businesses yet — add them in <b>Settings → My businesses</b> to log time &amp; tasks here each day.</p>';
      return;
    }

    // Overall totals for the whole day, across all businesses.
    var totM = 0, totT = 0, worked = 0;
    list.forEach(function (b) { var e = d.biz[b.id] || {}; var m = Number(e.m) || 0, t = Number(e.t) || 0; totM += m; totT += t; if (m > 0 || t > 0) worked++; });
    var overall = el('div', 'biz-overall');
    overall.innerHTML = '<span class="biz-ov-lbl">Day total</span>' +
      '<span class="biz-ov-val">⏱ <b>' + hoursMin(totM) + '</b> · ✅ <b>' + totT + '</b> tasks · ' + worked + '/' + list.length + ' worked</span>';
    box.appendChild(overall);

    // Business chips (Toggl-style): all visible, each shows its day total.
    if (!state.bizSelected || !list.some(function (b) { return b.id === state.bizSelected; })) state.bizSelected = list[0].id;
    var chips = el('div', 'biz-chips');
    list.forEach(function (b) {
      var e = d.biz[b.id] || {};
      var m = Number(e.m) || 0, t = Number(e.t) || 0;
      var c = el('button', 'biz-chip' + (b.id === state.bizSelected ? ' active' : '') + ((m > 0 || t > 0) ? ' worked' : ''));
      c.type = 'button';
      c.innerHTML = '<span class="bc-name">' + esc(b.name) + '</span>' +
        '<span class="bc-sub">' + ((m > 0 || t > 0) ? (hoursMin(m) + (t ? ' · ' + t + '✓' : '')) : '—') + '</span>';
      c.addEventListener('click', function () { state.bizSelected = b.id; renderBusinesses(d); });
      chips.appendChild(c);
    });
    box.appendChild(chips);

    // Editor for the selected business only.
    var b = list.filter(function (x) { return x.id === state.bizSelected; })[0];
    var e = d.biz[b.id] || { m: 0, t: 0 };
    var card = el('div', 'biz-card');
    card.innerHTML =
      '<div class="biz-row"><span class="biz-lbl">Time</span>' +
        '<button class="biz-q" data-add="15">+15m</button>' +
        '<button class="biz-q" data-add="30">+30m</button>' +
        '<button class="biz-q" data-add="60">+1h</button>' +
        '<input class="biz-min" type="number" inputmode="numeric" value="' + (Number(e.m) || 0) + '" /> <span class="muted tiny">min</span>' +
        '<button class="biz-clear" data-clear="m">✕</button></div>' +
      '<div class="biz-row"><span class="biz-lbl">Tasks</span>' +
        '<button class="biz-q" data-tadd="1">+1</button>' +
        '<input class="biz-task" type="number" inputmode="numeric" value="' + (Number(e.t) || 0) + '" />' +
        '<button class="biz-clear" data-clear="t">✕</button></div>';
    function commit(rerender) {
      d.biz[b.id] = { m: Math.max(0, Number(card.querySelector('.biz-min').value) || 0), t: Math.max(0, Number(card.querySelector('.biz-task').value) || 0) };
      queueSaveDay(d);
      if (rerender) renderBusinesses(d);
    }
    card.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inp = card.querySelector('.biz-min'); inp.value = (Number(inp.value) || 0) + Number(btn.getAttribute('data-add')); commit(true);
      });
    });
    card.querySelector('[data-tadd]').addEventListener('click', function () {
      var inp = card.querySelector('.biz-task'); inp.value = (Number(inp.value) || 0) + 1; commit(true);
    });
    card.querySelectorAll('[data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        card.querySelector(btn.getAttribute('data-clear') === 'm' ? '.biz-min' : '.biz-task').value = 0; commit(true);
      });
    });
    card.querySelector('.biz-min').addEventListener('change', function () { commit(true); });
    card.querySelector('.biz-task').addEventListener('change', function () { commit(true); });
    box.appendChild(card);

    // This week — total minutes per day across all businesses (Toggl-style bars).
    var wk = el('div', 'card');
    var today2 = todayStr(), maxMin = 0, days = [];
    for (var i = 6; i >= 0; i--) {
      var dte = addDays(today2, -i);
      var lg = dte === d.date ? d : logFor(dte);
      var tot = 0;
      if (lg && lg.biz) Object.keys(lg.biz).forEach(function (id) { tot += Number(lg.biz[id] && lg.biz[id].m) || 0; });
      days.push({ date: dte, min: tot });
      if (tot > maxMin) maxMin = tot;
    }
    var wkTotal = days.reduce(function (s, x) { return s + x.min; }, 0);
    wk.innerHTML = '<div class="eyebrow">This week · ' + hoursMin(wkTotal) + '</div>' +
      '<div class="wkbars">' + days.map(function (x) {
        var h = maxMin ? Math.max(4, Math.round(x.min / maxMin * 52)) : 4;
        return '<div class="wkcol"><div class="wkbar' + (x.min ? '' : ' empty') + '" style="height:' + h + 'px" title="' + hoursMin(x.min) + '"></div>' +
          '<span class="wklbl">' + parse(x.date).toLocaleDateString(undefined, { weekday: 'narrow' }) + '</span></div>';
      }).join('') + '</div>';
    box.appendChild(wk);
  }
  function addBusiness() {
    var name = $('#new-biz').value.trim();
    if (!name) return;
    var list = businesses().slice();
    if (list.length >= 8) { toast('Up to 8 businesses'); return; }
    list.push({ id: 'b_' + Date.now().toString(36), name: name });
    $('#new-biz').value = '';
    saveBusinesses(list);
  }
  function removeBusiness(id) {
    if (!confirm('Remove this business? Past logged time/tasks stay in your history.')) return;
    var list = businesses().filter(function (b) { return b.id !== id; });
    saveBusinesses(list);
  }
  function saveBusinesses(list) {
    var profile = Object.assign({}, state.profile, { businesses: list });
    state.profile = profile;
    renderBusinesses(appDay());
    renderBizSettings();
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
    }).catch(function (e) { toast(e.message); });
  }
  function renderBizSettings() {
    var box = $('#biz-settings-list'); if (!box) return;
    var list = businesses();
    box.innerHTML = list.length ? '' : '<p class="muted tiny">No businesses yet.</p>';
    list.forEach(function (b) {
      var row = el('div', 'biz-setting-row');
      row.innerHTML = '<span>' + esc(b.name) + '</span><button class="habit-del" data-rm="' + esc(b.id) + '">✕</button>';
      row.querySelector('[data-rm]').addEventListener('click', function () { removeBusiness(b.id); });
      box.appendChild(row);
    });
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
          d.waterMl = newFilled * GLASS;
          afterWaterChange(d);
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
    state.today.completed = goalMet(state.today);
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
    state.today.completed = goalMet(state.today);
    api('saveDay', { day: state.today }).then(function () {
      if (announce) toast(state.today.completed ? (challengeMode() === 'soft' ? 'Goal met — nice! 🔥' : 'Day complete — beast! 🔥') : 'Saved ✓');
    }).catch(function (err) {
      toast('Saved locally · ' + err.message);
    });
  }

  /* ---------------- Mini-app day selection (edit any past date) ----------------
     Every mini-app reads/writes appDay() instead of state.today. A shared date
     bar (‹ date ›, tap for a month picker) sets state.appDate; null = today. */
  function appDate() { return state.appDate || todayStr(); }
  function appDay() {
    var date = appDate();
    if (date === todayStr()) return state.today;
    var found = logFor(date);
    if (!found) {
      found = emptyDay(date);
      state.logs.push(found);
      state.logs.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    }
    return found;
  }
  function queueSaveDay(d) {
    if (!d || d.date === todayStr()) return queueSave();
    d.completed = goalMet(d);
    upsertLocal(d);
    var payload = Object.assign({}, d);
    clearTimeout(state.saveTimerPast);
    state.saveTimerPast = setTimeout(function () {
      api('saveDay', { day: payload }).then(function () {
        toast('Saved ' + shortDate(payload.date) + ' ✓');
      }).catch(function (err) { toast('Saved locally · ' + err.message); });
    }, 700);
  }
  function dayBarHtml() {
    var date = appDate(), isToday = date === todayStr();
    return '<div class="daybar">' +
      '<button class="icon-btn db-prev" type="button" aria-label="Previous day">‹</button>' +
      '<button class="db-mid" type="button">📅 <b>' + (isToday ? 'Today' : prettyDate(date)) + '</b> <span class="db-carat">▾</span></button>' +
      '<button class="icon-btn db-next" type="button"' + (isToday ? ' disabled' : '') + ' aria-label="Next day">›</button>' +
    '</div>' +
    '<div class="db-pick card hidden"></div>' +
    (isToday ? '' : '<p class="db-editing tiny">✏️ Editing a past day — <button class="link-btn db-today" type="button">back to today</button></p>');
  }
  function bindDayBar(scope, rerender) {
    var prev = scope.querySelector('.db-prev'); if (!prev) return;
    var next = scope.querySelector('.db-next'), mid = scope.querySelector('.db-mid');
    var pick = scope.querySelector('.db-pick'), tdy = scope.querySelector('.db-today');
    prev.addEventListener('click', function () { state.appDate = addDays(appDate(), -1); rerender(); });
    if (next) next.addEventListener('click', function () {
      var n = addDays(appDate(), 1);
      state.appDate = (n >= todayStr()) ? null : n;
      rerender();
    });
    if (tdy) tdy.addEventListener('click', function () { state.appDate = null; rerender(); });
    mid.addEventListener('click', function () {
      if (pick.classList.contains('hidden')) {
        buildDayPicker(pick, ymOf(appDate()), rerender, null);
        pick.classList.remove('hidden');
      } else pick.classList.add('hidden');
    });
  }
  // Month grid picker. colorFn(date) may return a CSS color to tint a day
  // (used by Mood/Gut to double as a "status calendar").
  function buildDayPicker(pick, ym, rerender, colorFn) {
    var today = todayStr();
    pick.innerHTML =
      '<div class="cal-nav" style="margin-bottom:8px">' +
        '<button class="icon-btn dp-prev" type="button">‹</button>' +
        '<div class="cal-month-label">' + ymLabel(ym) + '</div>' +
        '<button class="icon-btn dp-next" type="button"' + (ym >= ymOf(today) ? ' disabled' : '') + '>›</button>' +
      '</div><div class="calendar-grid month dp-grid"></div>';
    var grid = pick.querySelector('.dp-grid');
    var p = ym.split('-'), first = new Date(+p[0], +p[1] - 1, 1), lead = (first.getDay() + 6) % 7;
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      (function (date) {
        var cell = el('div', 'cal-cell dp-cell');
        cell.innerHTML = '<span class="cc-num">' + Number(date.slice(8)) + '</span>';
        if (date > today) cell.classList.add('pre');
        else {
          var col = colorFn && colorFn(date);
          if (col) { cell.style.background = 'color-mix(in srgb, ' + col + ' 30%, var(--bg-soft))'; cell.style.borderColor = col; cell.style.color = 'var(--text)'; }
          cell.classList.add('editable');
          if (date === appDate()) cell.classList.add('today');
          cell.addEventListener('click', function () {
            state.appDate = (date === today) ? null : date;
            rerender();
          });
        }
        grid.appendChild(cell);
      })(ym + '-' + pad(day));
    }
    pick.querySelector('.dp-prev').addEventListener('click', function () { buildDayPicker(pick, ymShift(ym, -1), rerender, colorFn); });
    pick.querySelector('.dp-next').addEventListener('click', function () { buildDayPicker(pick, ymShift(ym, 1), rerender, colorFn); });
  }

  /* ---------------- Calendar (real month grid) ---------------- */
  function shortDate(date) {
    return parse(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function ymOf(dateStr) { return String(dateStr).slice(0, 7); }
  function ymShift(ym, n) {
    var p = ym.split('-');
    var d = new Date(+p[0], +p[1] - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function ymLabel(ym) {
    var p = ym.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function ymShort(ym) {
    var p = ym.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  }
  function daysInYm(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  // Dates of `ym` between the user's start date and today (the scoreable days).
  function monthElapsedDates(ym) {
    var start = fmt(parse(state.user.startDate)), today = todayStr();
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    if (from < start) from = start;
    if (to > today) to = today;
    var out = [];
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }

  function renderCalendar() {
    if (!state.calMonth) state.calMonth = ymOf(todayStr());
    var ym = state.calMonth;
    var startYm = ymOf(fmt(parse(state.user.startDate)));
    $('#cal-month-label').textContent = ymLabel(ym);
    $('#cal-prev').disabled = ym <= startYm;
    $('#cal-next').disabled = ym >= ymOf(todayStr());
    renderJourneySummary(ym);
    buildMonthCalendar('#calendar-grid', ym);
    renderMonthReport('#month-report', ym);
  }

  function buildMonthCalendar(gridSel, ym) {
    var grid = $(gridSel); if (!grid) return;
    grid.innerHTML = '';
    var today = todayStr();
    var start = fmt(parse(state.user.startDate));
    var p = ym.split('-');
    var first = new Date(+p[0], +p[1] - 1, 1);
    var lead = (first.getDay() + 6) % 7; // Monday-first offset
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      var date = ym + '-' + pad(day);
      var dn = dayNumber(start, date);
      var cell = el('div', 'cal-cell');
      cell.innerHTML = '<span class="cc-num">' + day + '</span>' +
        '<span class="cc-date">' + (dn >= 1 && date <= today ? 'd' + dn : '') + '</span>';
      if (date < start) cell.classList.add('pre');
      else if (date <= today) {
        var log = logFor(date);
        if (log && goalMet(log)) cell.classList.add('done');
        else if (log && completedCount(log) > 0) cell.classList.add('partial');
        else if (date < today) cell.classList.add('miss');
      }
      if (date === today) cell.classList.add('today');
      if (date <= today) {
        cell.classList.add('editable');
        (function (dt) { cell.addEventListener('click', function () { openDayEditor(dt); }); })(date);
      }
      grid.appendChild(cell);
    }
  }

  function renderJourneySummary(ym) {
    var box = $('#journey-summary'); if (!box) return;
    var dates = monthElapsedDates(ym);
    var completed = 0, taskHits = 0, taskTotal = 0;
    dates.forEach(function (date) {
      var log = logFor(date);
      if (log && goalMet(log)) completed++;
      taskTotal += TOTAL_ITEMS;
      if (log) taskHits += completedCount(log);
    });
    var rate = taskTotal ? Math.round((taskHits / taskTotal) * 100) : 0;
    box.innerHTML =
      '<div class="js-stat"><b>' + completed + ' / ' + dates.length + '</b><span>days complete</span></div>' +
      '<div class="js-stat"><b>' + rate + '%</b><span>tasks done</span></div>';
  }

  /* ---------------- Life Score — monthly pillar grades ---------------- */
  // Per-day sub-scores (0–100). A day with no log scores 0 — discipline counts.
  function dayPillarScores(d) {
    d = d || {};
    var waterPct = pctOf(Number(d.waterMl) || 0, WATER_GOAL);
    var moves = ((d.workout1 ? 1 : 0) + (d.outdoor ? 1 : 0) + (d.diet ? 1 : 0)) / 3 * 100;
    var body = Math.round(moves * 0.7 + waterPct * 0.3);
    // MIND — reading + mood (journalling adds a bonus)
    var mind = d.mood
      ? Math.round((d.reading ? 100 : 0) * 0.6 + (d.mood / 5 * 100) * 0.4)
      : (d.reading ? 100 : 0);
    if (d.notes && String(d.notes).trim()) mind = Math.min(100, mind + 10);
    // LIFE — discipline (photo + no alcohol) blended with habits + work
    var parts = [((d.photo ? 1 : 0) + (d.noAlcohol ? 1 : 0)) / 2 * 100];
    var habits = (state.profile && state.profile.customTasks) || [];
    if (habits.length) parts.push(pctOf(habits.filter(function (h) { return d.extra && d.extra[h.id]; }).length, habits.length));
    var bizList = businesses();
    if (bizList.length) {
      var worked = 0;
      bizList.forEach(function (b) { var e = (d.biz || {})[b.id] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) worked++; });
      parts.push(pctOf(worked, bizList.length));
    }
    var life = Math.round(parts.reduce(function (a, b) { return a + b; }, 0) / parts.length);
    return { body: body, mind: mind, life: life };
  }

  // Month aggregates from the day logs (money is added separately, async).
  function monthScores(ym) {
    var dates = monthElapsedDates(ym);
    if (!dates.length) return null;
    var b = 0, m = 0, l = 0;
    dates.forEach(function (dt) {
      var s = dayPillarScores(logFor(dt));
      b += s.body; m += s.mind; l += s.life;
    });
    var n = dates.length;
    return { ym: ym, days: n, body: Math.round(b / n), mind: Math.round(m / n), life: Math.round(l / n) };
  }

  // Money score per month — fetched once per month & cached.
  // Daily-win driven: every day you stay under your daily budget counts FOR you.
  var moneyMonthCache = {};   // ym -> { spent, limit, perDay: {date: spend} } | 'loading'
  function ensureMoneyMonth(ym, onReady) {
    var c = moneyMonthCache[ym];
    if (c && c !== 'loading') return c;
    if (c === 'loading' || OFFLINE) return null;
    moneyMonthCache[ym] = 'loading';
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    Promise.all([
      api('moneyDashboard', { from: from, to: to }),
      api('moneyGetTxns', { from: from, to: to })
    ]).then(function (res) {
      var perDay = {};
      ((res[1] && res[1].transactions) || []).forEach(function (t) {
        if (t.type !== 'expense') return;
        var dte = String(t.date).slice(0, 10);
        perDay[dte] = (perDay[dte] || 0) + (Number(t.amount) || 0);
      });
      moneyMonthCache[ym] = {
        spent: Number(res[0] && res[0].totalSpend) || 0,
        limit: Number(res[0] && res[0].status && res[0].status.limit) || 0,
        perDay: perDay
      };
      if (onReady) onReady();
    }).catch(function () {
      // Don't poison the cache with zeros — clear so the next render retries.
      delete moneyMonthCache[ym];
      if (onReady) onReady();
    });
    return null;
  }
  // Per-month money detail for the report: daily wins + pace.
  function moneyDetailFor(ym) {
    var c = moneyMonthCache[ym];
    if (!c || c === 'loading' || !c.limit) return null;
    var dailyLimit = c.limit / daysInYm(ym);
    var today = todayStr();
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    if (to > today) to = today;
    var wins = 0, days = 0;
    for (var d = from; d <= to; d = addDays(d, 1)) {
      days++;
      if ((c.perDay[d] || 0) <= dailyLimit) wins++;
    }
    if (!days) return null;
    // Pace: how total spend compares to the elapsed share of the budget.
    var pace = c.limit * (days / daysInYm(ym));
    var paceScore = Math.max(0, Math.min(100, Math.round(100 * (2 - c.spent / Math.max(1, pace)) / 1.1)));
    var winScore = Math.round(wins / days * 100);
    return {
      dailyLimit: dailyLimit, wins: wins, days: days,
      winScore: winScore, paceScore: paceScore,
      score: Math.round(winScore * 0.7 + paceScore * 0.3)
    };
  }
  // → number (scored), null (no budget set), undefined (still loading)
  function moneyScoreFor(ym) {
    var c = moneyMonthCache[ym];
    if (!c || c === 'loading') return OFFLINE ? null : undefined;
    if (!c.limit) return null;
    var det = moneyDetailFor(ym);
    return det ? det.score : null;
  }

  function gradeOf(v) {
    if (typeof v !== 'number') return { g: '—', cls: 'na' };
    if (v >= 90) return { g: 'S', cls: 's' };
    if (v >= 80) return { g: 'A', cls: 'a' };
    if (v >= 70) return { g: 'B', cls: 'b' };
    if (v >= 55) return { g: 'C', cls: 'c' };
    if (v >= 40) return { g: 'D', cls: 'd' };
    return { g: 'F', cls: 'f' };
  }
  function monthOverall(ym) {
    var sc = monthScores(ym);
    if (!sc) return null;
    var vals = [sc.body, sc.mind, sc.life];
    var mv = moneyScoreFor(ym);
    if (typeof mv === 'number') vals.push(mv);
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
  }
  function verdictLine(overall, ym) {
    var now = ym === ymOf(todayStr());
    if (overall == null) return '';
    var t = overall >= 90 ? 'Legendary. All pillars firing 👑'
      : overall >= 80 ? 'Strong month — the machine is running 🔥'
      : overall >= 70 ? 'Solid. Tighten the weakest pillar to level up.'
      : overall >= 55 ? 'Coasting. Discipline beats motivation — lock in.'
      : overall >= 40 ? 'Slipping. Pick ONE pillar and win it this week.'
      : 'Rock bottom is a foundation. Restart today 💪';
    return now ? t + ' (scored on days so far)' : t;
  }

  function renderMonthReport(sel, ym) {
    var box = $(sel); if (!box) return;
    var sc = monthScores(ym);
    if (!sc) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    ensureMoneyMonth(ym, function () {
      // Re-render whichever surface is on screen once money data lands.
      if (!$('#view-calendar').classList.contains('hidden')) renderCalendar();
      if (!$('#view-home').classList.contains('hidden')) renderHome();
    });
    var money = moneyScoreFor(ym);
    var pillars = [
      { name: 'Body', v: sc.body, c: 'var(--body-c)' },
      { name: 'Mind', v: sc.mind, c: 'var(--mind-c)' },
      { name: 'Money', v: money, c: 'var(--money-c)' },
      { name: 'Life', v: sc.life, c: 'var(--life-c)' }
    ];
    var overall = monthOverall(ym);
    var og = gradeOf(overall);
    box.innerHTML =
      '<div class="mr-head">' +
        '<div><span class="eyebrow">Life Score · ' + ymLabel(ym) + '</span>' +
        '<div class="mr-sub muted tiny">' + sc.days + ' day' + (sc.days === 1 ? '' : 's') + ' scored · missed days count as 0</div></div>' +
        '<div class="grade-badge g-' + og.cls + '">' + og.g + '</div>' +
      '</div>' +
      pillars.map(function (p) {
        var loading = p.v === undefined;
        var g = gradeOf(p.v);
        var w = typeof p.v === 'number' ? p.v : 0;
        return '<div class="mr-row">' +
          '<span class="mr-name">' + p.name + '</span>' +
          '<div class="mr-bar"><span style="width:' + w + '%;background:' + p.c + '"></span></div>' +
          '<span class="mr-val mono">' + (loading ? '…' : (p.v == null ? '—' : p.v)) + '</span>' +
          '<span class="grade-chip g-' + (loading ? 'na' : g.cls) + '">' + (loading ? '…' : g.g) + '</span>' +
        '</div>';
      }).join('') +
      (function () {
        if (pillars[2].v === null && !OFFLINE) return '<div class="muted tiny" style="margin-top:6px">Set a monthly budget in Money to score the 💸 pillar.</div>';
        var det = moneyDetailFor(ym);
        if (!det) return '';
        return '<div class="muted tiny" style="margin-top:6px">💸 Money: <b>' + det.wins + '/' + det.days + '</b> days under your ' +
          rupee(det.dailyLimit) + '/day budget — every controlled day scores for you.</div>';
      })() +
      '<div class="mr-note muted tiny">' + verdictLine(overall, ym) + '</div>' +
      '<button type="button" class="link-btn mr-how-btn" id="mr-how-btn">ⓘ How scores work</button>' +
      '<div id="mr-how" class="mr-how hidden muted tiny">' +
        '<p><b style="color:var(--body-c)">Body</b> — daily average of: indoor + outdoor workout and diet (70%) + water goal (30%). A day with nothing logged scores 0.</p>' +
        '<p><b style="color:var(--mind-c)">Mind</b> — reading (60%) + mood (40% when logged), with a +10 bonus for journalling.</p>' +
        '<p><b style="color:var(--money-c)">Money</b> — 70% is <i>daily wins</i>: days you spent under your daily budget (monthly limit ÷ days in month). 30% is overall pace vs budget. Staying under your daily limit is a plus point every single day.</p>' +
        '<p><b style="color:var(--life-c)">Life</b> — discipline (progress photo + no alcohol) blended with your habits done and businesses worked.</p>' +
        '<p>Overall grade = average of available pillars. S ≥ 90 · A ≥ 80 · B ≥ 70 · C ≥ 55 · D ≥ 40.</p>' +
      '</div>' +
      monthHistoryHtml(ym);
    var howBtn = $('#mr-how-btn');
    if (howBtn) howBtn.addEventListener('click', function () { $('#mr-how').classList.toggle('hidden'); });
  }

  // Grade chips for every month since the journey started — the "game map".
  function monthHistoryHtml(activeYm) {
    var startYm = ymOf(fmt(parse(state.user.startDate)));
    var cur = ymOf(todayStr());
    var months = [], ym = startYm, guard = 0;
    while (ym <= cur && guard++ < 36) { months.push(ym); ym = ymShift(ym, 1); }
    if (months.length <= 1) return '';
    return '<div class="mr-hist">' + months.map(function (m) {
      ensureMoneyMonth(m, function () {
        if (!$('#view-calendar').classList.contains('hidden')) renderCalendar();
      });
      var g = gradeOf(monthOverall(m));
      return '<button type="button" class="mr-hchip' + (m === activeYm ? ' active' : '') + '" data-ym="' + m + '">' +
        ymShort(m) + ' <b class="gtext-' + g.cls + '">' + g.g + '</b></button>';
    }).join('') + '</div>';
  }

  /* ----- Day editor (edit any date from Journey) ----- */
  function openDayEditor(date) {
    state.editDay = Object.assign(emptyDay(date), logFor(date) || {});
    state.editDay.date = date;
    $('#day-modal-title').textContent = 'Day ' + dayNumber(state.user.startDate, date) + ' · ' + prettyDate(date);
    renderDayEditorBody();
    dayEditorRenderMood(); dayEditorRenderGut(); dayEditorRenderHabits(); dayEditorRenderWork(); dayEditorRenderMetrics();
    $('#de-notes').value = state.editDay.notes || '';
    show('#day-modal');
  }
  // ----- Day editor: mood / gut / habits / work log / metrics for ANY past day -----
  // Each mutates state.editDay directly; nothing auto-saves — "Save this day" persists it all.
  function dayEditorRenderMood() {
    var box = $('#de-mood'); if (!box) return;
    var d = state.editDay;
    box.innerHTML = '';
    MOODS.forEach(function (m) {
      var on = d.mood === m.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', m.color);
      b.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span>';
      b.addEventListener('click', function () { d.mood = (d.mood === m.v) ? 0 : m.v; dayEditorRenderMood(); });
      box.appendChild(b);
    });
  }
  function dayEditorRenderGut() {
    var box = $('#de-gut'); if (!box) return;
    var d = state.editDay;
    box.innerHTML = '';
    GUT.forEach(function (g) {
      var on = d.gut === g.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', g.color);
      b.innerHTML = '<span class="mood-emoji">' + g.emoji + '</span><span class="mood-label">' + g.label + '</span>';
      b.addEventListener('click', function () { d.gut = (d.gut === g.v) ? 0 : g.v; dayEditorRenderGut(); });
      box.appendChild(b);
    });
  }
  function dayEditorRenderHabits() {
    var box = $('#de-habits'); if (!box) return;
    var d = state.editDay; if (!d.extra) d.extra = {};
    var habits = (state.profile && state.profile.customTasks) || [];
    box.innerHTML = '';
    if (!habits.length) { box.innerHTML = '<p class="muted tiny">No habits set up yet — add them in the Habits app.</p>'; return; }
    habits.forEach(function (h) {
      var done = !!d.extra[h.id];
      var row = el('div', 'task habit' + (done ? ' done' : ''));
      row.innerHTML = '<div class="check">✓</div><div class="t-emoji">📌</div><div class="t-body"><div class="t-title">' + esc(h.name) + '</div></div>';
      row.addEventListener('click', function () { d.extra[h.id] = !d.extra[h.id]; dayEditorRenderHabits(); });
      box.appendChild(row);
    });
  }
  function dayEditorRenderWork() {
    var box = $('#de-work'); if (!box) return;
    var d = state.editDay; if (!d.biz) d.biz = {};
    var list = businesses();
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="muted tiny">No businesses set up yet — add them in Settings.</p>'; return; }
    list.forEach(function (b) {
      var e = d.biz[b.id] || { m: 0, t: 0 };
      var card = el('div', 'biz-card');
      card.innerHTML = '<div class="biz-top"><span class="biz-name">' + esc(b.name) + '</span></div>' +
        '<div class="biz-row"><span class="biz-lbl">Time</span><input class="de-biz-min" type="number" inputmode="numeric" value="' + (Number(e.m) || 0) + '" /> <span class="muted tiny">min</span></div>' +
        '<div class="biz-row"><span class="biz-lbl">Tasks</span><input class="de-biz-task" type="number" inputmode="numeric" value="' + (Number(e.t) || 0) + '" /></div>';
      card.querySelector('.de-biz-min').addEventListener('input', function () {
        d.biz[b.id] = Object.assign({ m: 0, t: 0 }, d.biz[b.id] || {}, { m: Number(this.value) || 0 });
      });
      card.querySelector('.de-biz-task').addEventListener('input', function () {
        d.biz[b.id] = Object.assign({ m: 0, t: 0 }, d.biz[b.id] || {}, { t: Number(this.value) || 0 });
      });
      box.appendChild(card);
    });
  }
  function dayEditorRenderMetrics() {
    var box = $('#de-metrics'); if (!box) return;
    var m = metricsOf(state.editDay);
    box.innerHTML =
      '<div class="manual-grid">' +
      '<label>Steps<input id="de-steps" type="number" inputmode="numeric" value="' + (m.steps || '') + '" /></label>' +
      '<label>Weight (kg)<input id="de-weight" type="number" inputmode="decimal" value="' + (m.weight || '') + '" /></label>' +
      '<label>Sleep (h)<input id="de-sleep-h" type="number" inputmode="numeric" value="' + (m.sleepMin ? Math.floor(m.sleepMin / 60) : '') + '" /></label>' +
      '<label>Sleep (m)<input id="de-sleep-m" type="number" inputmode="numeric" value="' + (m.sleepMin ? m.sleepMin % 60 : '') + '" /></label>' +
      '</div>';
    $('#de-steps').addEventListener('input', function () { m.steps = Number(this.value) || 0; });
    $('#de-weight').addEventListener('input', function () { m.weight = Number(this.value) || 0; });
    function updateSleep() { m.sleepMin = (Number($('#de-sleep-h').value) || 0) * 60 + (Number($('#de-sleep-m').value) || 0); }
    $('#de-sleep-h').addEventListener('input', updateSleep);
    $('#de-sleep-m').addEventListener('input', updateSleep);
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
  function statsCacheKey() { return 'hard_stats_' + (state.username || ''); }
  // Fetch the network-backed averages and cache them. Returns a Promise of the vals.
  function loadStatsVals() {
    var fast = api('getFasts', {}).then(function (d) { return avgFastLabel(d.fasts || []); }).catch(function () { return '—'; });
    var food = api('foodSummary', {}).then(function (d) { return d; }).catch(function () { return {}; });
    return Promise.all([fast, food]).then(function (res) {
      var d = res[1] || {};
      var g = function (v) { return v != null ? (v + ' g') : '—'; };
      var vals = {
        avgFast: res[0],
        avgCal: d.avgCalories ? (d.avgCalories + ' kcal') : '—',
        avgProtein: g(d.avgProtein), avgCarbs: g(d.avgCarbs), avgFat: g(d.avgFat),
        avgSugar: g(d.avgSugar), avgFiber: g(d.avgFiber)
      };
      try { localStorage.setItem(statsCacheKey(), JSON.stringify(vals)); } catch (e) {}
      return vals;
    });
  }
  // Warm the cache in the background at launch so Stats is instant on first open.
  function prefetchStats() { try { loadStatsVals(); } catch (e) {} }
  function renderStats() {
    // Show last-known averages instantly (Apps Script calls are slow), then refresh.
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(statsCacheKey()) || 'null'); } catch (e) {}
    renderStatsBody(cached || { avgFast: '…', avgCal: '…' });
    loadStatsVals().then(renderStatsBody);
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
      return l.date >= start && l.date <= today && goalMet(l);
    }).length;

    var grid = $('#stats-grid');
    grid.innerHTML = '';
    [
      ['Current day', curDay <= LEN ? curDay + ' / ' + LEN : curDay],
      ['Streak', streakOf(logs) + '🔥'],
      ['Days completed', done],
      [curDay > LEN ? '75 Hard' : 'Days left', curDay > LEN ? 'Done 🏆' : Math.max(0, LEN - curDay)],
      ['Avg fast', vals.avgFast],
      ['Avg calories / day', vals.avgCal],
      ['Avg protein / day', vals.avgProtein || '…'],
      ['Avg carbs / day', vals.avgCarbs || '…'],
      ['Avg fat / day', vals.avgFat || '…'],
      ['Avg sugar / day', vals.avgSugar || '…'],
      ['Avg fibre / day', vals.avgFiber || '…']
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
    renderGutTrend();
    renderBizStats();
  }

  function renderBizStats() {
    var box = $('#biz-stats'), card = $('#biz-stats-card'); if (!box) return;
    var list = businesses();
    if (!list.length) { if (card) card.classList.add('hidden'); return; }
    if (card) card.classList.remove('hidden');
    var today = todayStr(), weekAgo = addDays(today, -6);
    var agg = {};
    list.forEach(function (b) { agg[b.id] = { name: b.name, min: 0, tasks: 0, days: {}, wkMin: 0, wkTasks: 0 }; });
    (state.logs || []).forEach(function (l) {
      var biz = l.biz || {};
      Object.keys(biz).forEach(function (id) {
        if (!agg[id]) return; // business since removed
        var e = biz[id] || {}, m = Number(e.m) || 0, t = Number(e.t) || 0;
        if (m <= 0 && t <= 0) return;
        agg[id].min += m; agg[id].tasks += t; agg[id].days[l.date] = true;
        if (l.date >= weekAgo && l.date <= today) { agg[id].wkMin += m; agg[id].wkTasks += t; }
      });
    });
    box.innerHTML = list.map(function (b) {
      var a = agg[b.id], days = Object.keys(a.days).length;
      return '<div class="biz-stat">' +
        '<div class="biz-stat-name">' + esc(a.name) + '</div>' +
        '<div class="biz-stat-nums"><span>⏱ <b>' + hoursMin(a.min) + '</b></span>' +
        '<span>✅ <b>' + a.tasks + '</b></span>' +
        '<span>📅 <b>' + days + '</b>d</span></div>' +
        '<div class="muted tiny">This week: ' + hoursMin(a.wkMin) + ' · ' + a.wkTasks + ' tasks</div>' +
        '</div>';
    }).join('');
  }

  function renderMoodTrend(sel) {
    var box = $(sel || '#mood-trend'); if (!box) return;
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
  function renderGutTrend(sel) {
    var box = $(sel || '#gut-trend'); if (!box) return;
    var today = todayStr(), dots = '', counts = {}, n = 0;
    for (var i = 13; i >= 0; i--) {
      var date = addDays(today, -i);
      var log = logFor(date);
      var gv = log && log.gut ? log.gut : 0;
      var col = gutColor(gv) || 'var(--bg-soft)';
      dots += '<span class="mt-dot" title="' + shortDate(date) + (gv ? (' · ' + gutLabel(gv)) : '') + '" style="background:' + col + '"></span>';
      if (gv) { counts[gv] = (counts[gv] || 0) + 1; n++; }
    }
    var legend = GUT.map(function (g) {
      return '<span class="gt-key"><i style="background:' + g.color + '"></i>' + g.label + (counts[g.v] ? (' ' + counts[g.v]) : '') + '</span>';
    }).join('');
    box.innerHTML = '<div class="mt-dots">' + dots + '</div>' +
      '<div class="gt-legend">' + legend + '</div>' +
      '<div class="muted tiny" style="margin-top:6px">' +
      (n ? (n + ' logged day' + (n > 1 ? 's' : '') + ' in the last 14') : 'No gut entries yet — log it on the Today screen.') + '</div>';
  }
  function bestStreak(logs) {
    var best = 0, cur = 0;
    logs.forEach(function (l) { if (goalMet(l)) { cur++; best = Math.max(best, cur); } else cur = 0; });
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
              (u.mode === 'soft' ? ' <span class="soft-tag">SOFT</span>' : '') +
              '<small>Day ' + u.currentDay + (u.currentDay > LEN ? ' 🏆' : '') + ' · 🔥 ' + u.streak + ' · ' + u.completedDays + ' days done</small></div>' +
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
    renderAccount();
    renderModeCard();
    renderBizSettings();
    var sd = fmt(parse(state.user.startDate));
    // Guard against a corrupted/ancient stored date (e.g. year 2000) — show today instead.
    if (sd < '2025-01-01' || sd > todayStr()) sd = todayStr();
    var inp = $('#set-startdate');
    inp.value = sd; inp.min = '2025-01-01'; inp.max = todayStr();
    prefillGoals();
    renderThemes();
  }

  /* ----- Challenge mode (75 Hard / 75 Soft) ----- */
  function renderModeCard() {
    var mode = challengeMode();
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('#soft-target-wrap').classList.toggle('hidden', mode !== 'soft');
    $('#soft-target').value = String(softTarget());
  }
  function pickMode(mode) {
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('#soft-target-wrap').classList.toggle('hidden', mode !== 'soft');
  }
  function saveMode() {
    var mode = $('#mode-seg [data-mode].active') ? $('#mode-seg [data-mode].active').dataset.mode : 'hard';
    var target = Number($('#soft-target').value) || 70;
    var profile = Object.assign({}, state.profile, { mode: mode, softTarget: target });
    state.profile = profile;
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
      toast(mode === 'soft' ? 'Switched to 75 Soft (' + softNeeded() + '/' + TOTAL_ITEMS + ' tasks/day) ✓' : 'Switched to 75 Hard ✓');
      renderAll();
    }).catch(function (e) { toast(e.message); });
  }

  /* ----- Account: email, username, password ----- */
  function renderAccount() {
    var u = state.user || {};
    if (!document.activeElement || document.activeElement.id !== 'acct-email') $('#acct-email').value = u.email || '';
  }
  function acctEmailSave() {
    var email = $('#acct-email').value.trim();
    var btn = $('#acct-email-btn'); btn.disabled = true;
    api('updateEmail', { email: email }).then(function (d) {
      state.user = Object.assign(state.user, d.user); cacheState();
      toast(email ? 'Email saved ✓' : 'Email cleared');
    }).catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; });
  }
  function acctChangeUsername() {
    var newName = $('#acct-username').value.trim().toLowerCase();
    var pw = $('#acct-username-pw').value;
    if (newName.length < 3 || !pw) { toast('Enter a new username (3+) and your password'); return; }
    if (!confirm('Change your username to "' + newName + '"? You\'ll use it to log in from now on.')) return;
    api('changeUsername', { newUsername: newName, password: pw }).then(function (d) {
      state.token = d.token; state.username = d.user.username; state.user = Object.assign(state.user, d.user);
      localStorage.setItem('hard_token', state.token); localStorage.setItem('hard_user', state.username);
      cacheState();
      $('#acct-username').value = ''; $('#acct-username-pw').value = '';
      $('#set-username').textContent = state.user.username;
      toast('Username changed ✓'); renderAll();
    }).catch(function (e) { toast(e.message); });
  }
  function acctChangePassword() {
    var cur = $('#acct-curpw').value, next = $('#acct-newpw').value;
    if (!cur || next.length < 4) { toast('Enter current + a new password (4+ chars)'); return; }
    api('changePassword', { currentPassword: cur, newPassword: next }).then(function () {
      $('#acct-curpw').value = ''; $('#acct-newpw').value = '';
      toast('Password updated ✓');
    }).catch(function (e) { toast(e.message); });
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
    { name: 'White rice (cooked)', kcal: 130, p: 2.7, c: 28, f: 0.3, s: 0.1, fb: 0.4, serving: 150 },
    { name: 'Brown rice (cooked)', kcal: 123, p: 2.7, c: 26, f: 1, s: 0.4, fb: 1.8, serving: 150 },
    { name: 'Roti / Chapati', kcal: 297, p: 11, c: 50, f: 7, s: 1.5, fb: 4.9, serving: 40 },
    { name: 'Paratha (plain)', kcal: 320, p: 6, c: 40, f: 14, s: 1.5, fb: 4, serving: 60 },
    { name: 'Aloo paratha', kcal: 280, p: 5, c: 38, f: 11, s: 2, fb: 3, serving: 100 },
    { name: 'Naan', kcal: 310, p: 9, c: 50, f: 8, s: 3, fb: 2.2, serving: 90 },
    { name: 'Bread (white slice)', kcal: 265, p: 9, c: 49, f: 3.2, s: 5, fb: 2.7, serving: 30 },
    { name: 'Brown bread (slice)', kcal: 247, p: 13, c: 41, f: 4, s: 4, fb: 7, serving: 30 },
    { name: 'Oats (dry)', kcal: 389, p: 17, c: 66, f: 7, s: 1, fb: 10, serving: 40 },
    { name: 'Poha (cooked)', kcal: 130, p: 2.5, c: 27, f: 1.5, s: 1, fb: 1, serving: 150 },
    { name: 'Upma', kcal: 145, p: 3, c: 24, f: 4, s: 1, fb: 1.5, serving: 150 },
    { name: 'Idli', kcal: 130, p: 4, c: 25, f: 0.8, s: 0.5, fb: 1, serving: 80 },
    { name: 'Dosa (plain)', kcal: 168, p: 3.9, c: 30, f: 3.7, s: 1, fb: 1.5, serving: 80 },
    // Noodles / pasta / wraps
    { name: 'Pasta (cooked)', kcal: 131, p: 5, c: 25, f: 1.1, s: 0.6, fb: 1.8, serving: 150 },
    { name: 'Hakka noodles (cooked)', kcal: 138, p: 4, c: 25, f: 2, s: 1, fb: 1.8, serving: 150 },
    { name: 'Rice vermicelli (cooked)', kcal: 109, p: 1.8, c: 24, f: 0.2, s: 0, fb: 0.9, serving: 150 },
    { name: 'Shirataki noodles (cooked)', kcal: 10, p: 0.2, c: 3, f: 0, s: 0, fb: 3, serving: 100 },
    { name: 'Rice paper / spring roll wrapper', kcal: 330, p: 0.9, c: 81, f: 0.2, s: 0.5, fb: 1.6, serving: 10 },
    // Dals, legumes, soy
    { name: 'Dal (cooked)', kcal: 116, p: 7, c: 17, f: 1.5, s: 1, fb: 4, serving: 150 },
    { name: 'Dal makhani', kcal: 230, p: 9, c: 20, f: 13, s: 3, fb: 5, serving: 150 },
    { name: 'Rajma (cooked)', kcal: 127, p: 8.7, c: 22, f: 0.5, s: 0.6, fb: 6.4, serving: 150 },
    { name: 'Chole / chana masala', kcal: 180, p: 8, c: 22, f: 7, s: 3, fb: 6, serving: 150 },
    { name: 'Boiled chana', kcal: 164, p: 8.9, c: 27, f: 2.6, s: 5, fb: 7.6, serving: 100 },
    { name: 'Tofu', kcal: 76, p: 8, c: 1.9, f: 4.8, s: 0.6, fb: 0.9, serving: 100 },
    { name: 'Soya chunks (dry)', kcal: 345, p: 52, c: 33, f: 0.5, s: 9, fb: 13, serving: 30 },
    // Dairy & fats
    { name: 'Milk (full fat)', kcal: 61, p: 3.2, c: 4.8, f: 3.3, s: 5, fb: 0, serving: 200 },
    { name: 'Milk (toned)', kcal: 47, p: 3.1, c: 4.7, f: 1.5, s: 5, fb: 0, serving: 200 },
    { name: 'Curd / Yogurt', kcal: 98, p: 11, c: 3.4, f: 4.3, s: 4.7, fb: 0, serving: 150 },
    { name: 'Greek yogurt', kcal: 97, p: 9, c: 4, f: 5, s: 4, fb: 0, serving: 150 },
    { name: 'Buttermilk', kcal: 40, p: 3.3, c: 4.8, f: 0.9, s: 4.8, fb: 0, serving: 200 },
    { name: 'Paneer', kcal: 296, p: 18, c: 4, f: 22, s: 1.2, fb: 0, serving: 50 },
    { name: 'Cheddar cheese', kcal: 402, p: 25, c: 1.3, f: 33, s: 0.5, fb: 0, serving: 30 },
    { name: 'Mozzarella', kcal: 280, p: 28, c: 3.1, f: 17, s: 1, fb: 0, serving: 30 },
    { name: 'Fresh cream', kcal: 292, p: 2.1, c: 3, f: 30, s: 3, fb: 0, serving: 30 },
    { name: 'Butter', kcal: 717, p: 0.9, c: 0.1, f: 81, s: 0.1, fb: 0, serving: 10 },
    { name: 'Ghee', kcal: 900, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Coconut oil', kcal: 862, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Mustard oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Olive oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Peanut butter', kcal: 588, p: 25, c: 20, f: 50, s: 9, fb: 6, serving: 20 },
    // Proteins
    { name: 'Egg (whole)', kcal: 155, p: 13, c: 1.1, f: 11, s: 1.1, fb: 0, serving: 50 },
    { name: 'Egg white', kcal: 52, p: 11, c: 0.7, f: 0.2, s: 0.7, fb: 0, serving: 33 },
    { name: 'Chicken breast (cooked)', kcal: 165, p: 31, c: 0, f: 3.6, s: 0, fb: 0, serving: 120 },
    { name: 'Chicken curry', kcal: 180, p: 14, c: 6, f: 11, s: 3, fb: 1, serving: 200 },
    { name: 'Butter chicken', kcal: 240, p: 14, c: 8, f: 16, s: 4, fb: 1, serving: 200 },
    { name: 'Fish (cooked)', kcal: 206, p: 22, c: 0, f: 12, s: 0, fb: 0, serving: 120 },
    { name: 'Mutton (cooked)', kcal: 258, p: 25, c: 0, f: 17, s: 0, fb: 0, serving: 120 },
    { name: 'Whey protein (scoop)', kcal: 400, p: 80, c: 8, f: 6, s: 6, fb: 0, serving: 30 },
    // Veg, fruit
    { name: 'Mixed vegetables', kcal: 65, p: 2.6, c: 13, f: 0.4, s: 5, fb: 4, serving: 150 },
    { name: 'Mixed veg sabzi', kcal: 110, p: 3, c: 12, f: 6, s: 4, fb: 4, serving: 150 },
    { name: 'Palak paneer', kcal: 180, p: 8, c: 8, f: 13, s: 3, fb: 3, serving: 150 },
    { name: 'Potato (boiled)', kcal: 87, p: 1.9, c: 20, f: 0.1, s: 0.8, fb: 1.8, serving: 150 },
    { name: 'Spinach (cooked)', kcal: 23, p: 2.9, c: 3.6, f: 0.4, s: 0.4, fb: 2.4, serving: 100 },
    { name: 'Cucumber', kcal: 15, p: 0.7, c: 3.6, f: 0.1, s: 1.7, fb: 0.5, serving: 100 },
    { name: 'Tomato', kcal: 18, p: 0.9, c: 3.9, f: 0.2, s: 2.6, fb: 1.2, serving: 100 },
    { name: 'Banana', kcal: 89, p: 1.1, c: 23, f: 0.3, s: 12, fb: 2.6, serving: 120 },
    { name: 'Apple', kcal: 52, p: 0.3, c: 14, f: 0.2, s: 10, fb: 2.4, serving: 180 },
    { name: 'Mango', kcal: 60, p: 0.8, c: 15, f: 0.4, s: 14, fb: 1.6, serving: 150 },
    // Fruits
    { name: 'Pineapple', kcal: 50, p: 0.5, c: 13, f: 0.1, s: 10, fb: 1.4, serving: 165 },
    { name: 'Guava (Amrood)', kcal: 68, p: 2.6, c: 14, f: 1, s: 9, fb: 5.4, serving: 100 },
    { name: 'Orange', kcal: 47, p: 0.9, c: 12, f: 0.1, s: 9, fb: 2.4, serving: 130 },
    { name: 'Sweet lime (Mosambi)', kcal: 43, p: 0.8, c: 9.3, f: 0.3, s: 8, fb: 2, serving: 130 },
    { name: 'Grapes', kcal: 69, p: 0.7, c: 18, f: 0.2, s: 16, fb: 0.9, serving: 100 },
    { name: 'Watermelon', kcal: 30, p: 0.6, c: 8, f: 0.2, s: 6, fb: 0.4, serving: 150 },
    { name: 'Muskmelon (Cantaloupe)', kcal: 34, p: 0.8, c: 8, f: 0.2, s: 8, fb: 0.9, serving: 150 },
    { name: 'Papaya', kcal: 43, p: 0.5, c: 11, f: 0.3, s: 8, fb: 1.7, serving: 140 },
    { name: 'Pomegranate (Anar)', kcal: 83, p: 1.7, c: 19, f: 1.2, s: 14, fb: 4, serving: 100 },
    { name: 'Pear', kcal: 57, p: 0.4, c: 15, f: 0.1, s: 10, fb: 3.1, serving: 150 },
    { name: 'Peach', kcal: 39, p: 0.9, c: 10, f: 0.3, s: 8, fb: 1.5, serving: 150 },
    { name: 'Plum', kcal: 46, p: 0.7, c: 11, f: 0.3, s: 10, fb: 1.4, serving: 65 },
    { name: 'Kiwi', kcal: 61, p: 1.1, c: 15, f: 0.5, s: 9, fb: 3, serving: 75 },
    { name: 'Strawberry', kcal: 32, p: 0.7, c: 8, f: 0.3, s: 5, fb: 2, serving: 100 },
    { name: 'Litchi (Lychee)', kcal: 66, p: 0.8, c: 17, f: 0.4, s: 15, fb: 1.3, serving: 100 },
    { name: 'Sapota (Chikoo)', kcal: 83, p: 0.4, c: 20, f: 1.1, s: 15, fb: 5.3, serving: 100 },
    { name: 'Custard apple (Sitaphal)', kcal: 94, p: 2.1, c: 24, f: 0.3, s: 19, fb: 4.4, serving: 100 },
    { name: 'Jackfruit', kcal: 95, p: 1.7, c: 23, f: 0.6, s: 19, fb: 1.5, serving: 100 },
    { name: 'Fig (Anjeer, fresh)', kcal: 74, p: 0.8, c: 19, f: 0.3, s: 16, fb: 2.9, serving: 50 },
    { name: 'Amla (Indian gooseberry)', kcal: 44, p: 0.9, c: 10, f: 0.6, s: 6, fb: 3.4, serving: 50 },
    { name: 'Dates (Khajoor)', kcal: 277, p: 1.8, c: 75, f: 0.2, s: 66, fb: 6.7, serving: 24 },
    { name: 'Coconut (fresh)', kcal: 354, p: 3.3, c: 15, f: 33, s: 6, fb: 9, serving: 50 },
    { name: 'Avocado', kcal: 160, p: 2, c: 9, f: 15, s: 0.7, fb: 6.7, serving: 100 },
    { name: 'Blueberries', kcal: 57, p: 0.7, c: 14, f: 0.3, s: 10, fb: 2.4, serving: 100 },
    // Nuts
    { name: 'Almonds', kcal: 579, p: 21, c: 22, f: 50, s: 4, fb: 12.5, serving: 28 },
    { name: 'Peanuts', kcal: 567, p: 26, c: 16, f: 49, s: 4, fb: 8.5, serving: 30 },
    { name: 'Cashews', kcal: 553, p: 18, c: 30, f: 44, s: 6, fb: 3.3, serving: 30 },
    { name: 'Walnuts', kcal: 654, p: 15, c: 14, f: 65, s: 2.6, fb: 6.7, serving: 30 },
    { name: 'Pistachios', kcal: 562, p: 20, c: 28, f: 45, s: 8, fb: 10, serving: 30 },
    { name: 'Hazelnuts', kcal: 628, p: 15, c: 17, f: 61, s: 4.3, fb: 9.7, serving: 28 },
    // Dry fruits & seeds
    { name: 'Raisins (Kishmish)', kcal: 299, p: 3.1, c: 79, f: 0.5, s: 59, fb: 3.7, serving: 30 },
    { name: 'Dried apricots (Khubani)', kcal: 241, p: 3.4, c: 63, f: 0.5, s: 53, fb: 7.3, serving: 30 },
    { name: 'Prunes (dried plums)', kcal: 240, p: 2.2, c: 64, f: 0.4, s: 38, fb: 7, serving: 30 },
    { name: 'Dried figs (Anjeer)', kcal: 249, p: 3.3, c: 64, f: 0.9, s: 48, fb: 9.8, serving: 30 },
    { name: 'Pumpkin seeds', kcal: 559, p: 30, c: 11, f: 49, s: 1, fb: 6, serving: 28 },
    { name: 'Sunflower seeds', kcal: 584, p: 21, c: 20, f: 51, s: 2.6, fb: 8.6, serving: 28 },
    { name: 'Chia seeds', kcal: 486, p: 17, c: 42, f: 31, s: 0, fb: 34, serving: 15 },
    { name: 'Flax seeds (Alsi)', kcal: 534, p: 18, c: 29, f: 42, s: 1.5, fb: 27, serving: 15 },
    // Vegetables (raw unless noted)
    { name: 'Broccoli', kcal: 34, p: 2.8, c: 7, f: 0.4, s: 1.7, fb: 2.6, serving: 100 },
    { name: 'Cauliflower (Gobi)', kcal: 25, p: 1.9, c: 5, f: 0.3, s: 1.9, fb: 2, serving: 100 },
    { name: 'Cabbage (Patta gobi)', kcal: 25, p: 1.3, c: 6, f: 0.1, s: 3.2, fb: 2.5, serving: 100 },
    { name: 'Capsicum / Bell pepper', kcal: 31, p: 1, c: 6, f: 0.3, s: 4.2, fb: 2.1, serving: 100 },
    { name: 'French beans', kcal: 31, p: 1.8, c: 7, f: 0.2, s: 3.3, fb: 3.4, serving: 100 },
    { name: 'Okra (Bhindi)', kcal: 33, p: 1.9, c: 7, f: 0.2, s: 1.5, fb: 3.2, serving: 100 },
    { name: 'Carrot', kcal: 41, p: 0.9, c: 10, f: 0.2, s: 4.7, fb: 2.8, serving: 100 },
    { name: 'Onion', kcal: 40, p: 1.1, c: 9, f: 0.1, s: 4.2, fb: 1.7, serving: 100 },
    { name: 'Green peas', kcal: 81, p: 5.4, c: 14, f: 0.4, s: 6, fb: 5.5, serving: 100 },
    { name: 'Brinjal / Eggplant (Baingan)', kcal: 25, p: 1, c: 6, f: 0.2, s: 3.5, fb: 3, serving: 100 },
    { name: 'Bottle gourd (Lauki)', kcal: 14, p: 0.6, c: 3.4, f: 0, s: 1.4, fb: 1.2, serving: 100 },
    { name: 'Bitter gourd (Karela)', kcal: 17, p: 1, c: 3.7, f: 0.2, s: 0, fb: 2.8, serving: 100 },
    { name: 'Pumpkin (Kaddu)', kcal: 26, p: 1, c: 7, f: 0.1, s: 2.8, fb: 0.5, serving: 100 },
    { name: 'Beetroot', kcal: 43, p: 1.6, c: 10, f: 0.2, s: 7, fb: 2.8, serving: 100 },
    { name: 'Sweet potato (Shakarkandi)', kcal: 86, p: 1.6, c: 20, f: 0.1, s: 4.2, fb: 3, serving: 100 },
    { name: 'Mushroom', kcal: 22, p: 3.1, c: 3.3, f: 0.3, s: 2, fb: 1, serving: 100 },
    { name: 'Sweet corn', kcal: 86, p: 3.2, c: 19, f: 1.2, s: 6.3, fb: 2.7, serving: 100 },
    { name: 'Radish (Mooli)', kcal: 16, p: 0.7, c: 3.4, f: 0.1, s: 1.9, fb: 1.6, serving: 100 },
    // Raw meat & seafood (per 100 g, uncooked)
    { name: 'Chicken breast (raw, skinless)', kcal: 120, p: 22.5, c: 0, f: 2.6, s: 0, fb: 0, serving: 100 },
    { name: 'Chicken thigh (raw, skinless)', kcal: 121, p: 19.7, c: 0, f: 4.3, s: 0, fb: 0, serving: 100 },
    { name: 'Chicken (whole, raw, with skin)', kcal: 215, p: 18, c: 0, f: 15, s: 0, fb: 0, serving: 100 },
    { name: 'Mutton / Goat (raw)', kcal: 109, p: 20.6, c: 0, f: 2.3, s: 0, fb: 0, serving: 100 },
    { name: 'Lamb (raw)', kcal: 294, p: 25, c: 0, f: 21, s: 0, fb: 0, serving: 100 },
    { name: 'Pork (raw)', kcal: 242, p: 27, c: 0, f: 14, s: 0, fb: 0, serving: 100 },
    { name: 'Pork (lean, raw)', kcal: 143, p: 21, c: 0, f: 6, s: 0, fb: 0, serving: 100 },
    { name: 'Beef (raw)', kcal: 250, p: 26, c: 0, f: 15, s: 0, fb: 0, serving: 100 },
    { name: 'Fish (raw, white)', kcal: 96, p: 20, c: 0, f: 1.5, s: 0, fb: 0, serving: 100 },
    { name: 'Rohu fish (raw)', kcal: 97, p: 16.6, c: 0, f: 1.4, s: 0, fb: 0, serving: 100 },
    { name: 'Salmon (raw)', kcal: 208, p: 20, c: 0, f: 13, s: 0, fb: 0, serving: 100 },
    { name: 'Prawns / Shrimp (raw)', kcal: 99, p: 24, c: 0.2, f: 0.3, s: 0, fb: 0, serving: 100 },
    { name: 'Egg (raw, whole)', kcal: 143, p: 12.6, c: 0.7, f: 9.5, s: 0.4, fb: 0, serving: 50 },
    // Snacks, sweets, drinks
    { name: 'Samosa', kcal: 308, p: 5, c: 32, f: 18, s: 2, fb: 3, serving: 50 },
    { name: 'Veg biryani', kcal: 180, p: 4, c: 28, f: 6, s: 2, fb: 2, serving: 200 },
    { name: 'Chicken biryani', kcal: 200, p: 9, c: 26, f: 7, s: 2, fb: 1.5, serving: 200 },
    { name: 'Curd rice', kcal: 150, p: 4, c: 22, f: 5, s: 3, fb: 0.5, serving: 200 },
    { name: 'Dark chocolate', kcal: 546, p: 4.9, c: 61, f: 31, s: 48, fb: 7, serving: 20 },
    { name: 'Honey', kcal: 304, p: 0.3, c: 82, f: 0, s: 82, fb: 0.2, serving: 20 },
    { name: 'Jaggery', kcal: 383, p: 0.4, c: 98, f: 0.1, s: 97, fb: 0, serving: 10 },
    { name: 'Sugar', kcal: 387, p: 0, c: 100, f: 0, s: 100, fb: 0, serving: 5 },
    { name: 'Tea with milk & sugar', kcal: 40, p: 1, c: 6, f: 1, s: 5, fb: 0, serving: 150 },
    { name: 'Black coffee (no sugar)', kcal: 1, p: 0.1, c: 0, f: 0, s: 0, fb: 0, serving: 240 },
    { name: 'Cola / soft drink', kcal: 42, p: 0, c: 10.6, f: 0, s: 10.6, fb: 0, serving: 330 },
    { name: 'Orange juice', kcal: 45, p: 0.7, c: 10, f: 0.2, s: 8, fb: 0.2, serving: 200 }
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
    return { name: a[0], kcal: Math.round(a[1] * k), c: round1(a[2] * k), p: round1(a[3] * k), f: round1(a[4] * k), s: round1(a[5] * k), fb: 0, serving: sg };
  });

  function dietGoals() {
    var p = state.profile || {};
    return {
      cal: Number(p.calorieGoal) || 0,
      protein: Number(p.proteinGoal) || 0,
      carbs: Number(p.carbGoal) || 0,
      fat: Number(p.fatGoal) || 0,
      sugar: Number(p.sugarGoal) || 0,
      fiber: Number(p.fiberGoal) || 0
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
  }
  function setDietDate(date) {
    if (date > todayStr()) return;
    state.dietDate = date;
    renderDiet();
  }

  /* ----- Intermittent fasting ----- */
  // Milestones (hours). The "mark" you earn is the highest one you reach.
  // Every hour from 12h to 24h (so 17/19/21h fasts get their own mark), then long-haul marks.
  var MILESTONES = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 36, 48];

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
          '<div class="fast-chips">' + [12, 14, 16, 18, 20, 24].map(function (h) {
            return '<span class="fast-chip" data-fm="' + h + '">' + h + 'h</span>';
          }).join('') + '</div>' +
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
          '<button id="fast-manual-toggle" class="link-btn" style="margin-top:8px">＋ Log a past fast</button>' +
          '<div id="fast-manual" class="fast-edit-box hidden">' +
            '<label class="tiny">Start<input type="datetime-local" id="fm-start"></label>' +
            '<label class="tiny">End<input type="datetime-local" id="fm-end"></label>' +
            '<div class="row-2"><button id="fm-save" class="btn primary">Save fast</button>' +
            '<button id="fm-cancel" class="btn">Cancel</button></div></div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="cal-nav" style="margin-bottom:8px">' +
            '<button id="fc-prev" class="icon-btn" type="button">‹</button>' +
            '<div id="fc-label" class="cal-month-label"></div>' +
            '<button id="fc-next" class="icon-btn" type="button">›</button>' +
          '</div>' +
          '<div id="fast-cal" class="calendar-grid month"></div>' +
          '<div class="gt-legend" style="margin-top:10px">' +
            '<span class="gt-key"><i style="background:var(--green)"></i>18h+</span>' +
            '<span class="gt-key"><i style="background:#38bdf8"></i>16–18h</span>' +
            '<span class="gt-key"><i style="background:var(--amber)"></i>14–16h</span>' +
            '<span class="gt-key"><i style="background:#8da3c4"></i>under 14h</span>' +
          '</div>' +
          '<p class="muted tiny" style="margin:8px 0 0">Tap a fast to edit it · tap an empty day to log one.</p>' +
        '</div>' +
        '<div class="card" style="padding-top:12px"><div id="fast-history" class="fast-history"></div></div>';
      $('#fast-start-input').value = toLocalInput(new Date().toISOString());
      $('#fast-start').addEventListener('click', function () {
        var v = $('#fast-start-input').value;
        if (v && new Date(v).getTime() > Date.now()) { toast('Start time can’t be in the future'); return; }
        startFast(v ? fromLocalInput(v) : new Date().toISOString());
      });
      $('#fast-manual-toggle').addEventListener('click', function () { fastManualOpen(); });
      $('#fm-cancel').addEventListener('click', function () { $('#fast-manual').classList.add('hidden'); });
      $('#fm-save').addEventListener('click', saveManualFast);
      loadFastHistory();
    }
  }

  // Prefill + open the manual past-fast form (dateStr optional: 8pm that day → noon next).
  function fastManualOpen(dateStr) {
    var fm = $('#fast-manual'); if (!fm) return;
    fm.classList.remove('hidden');
    if (dateStr) {
      $('#fm-start').value = dateStr + 'T20:00';
      $('#fm-end').value = addDays(dateStr, 1) + 'T12:00';
    } else if (!$('#fm-start').value) {
      var y = addDays(todayStr(), -1);
      $('#fm-start').value = y + 'T20:00';
      $('#fm-end').value = todayStr() + 'T12:00';
    }
    fm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function saveManualFast() {
    var s = $('#fm-start').value, e = $('#fm-end').value;
    if (!s || !e) { toast('Set both times'); return; }
    var sT = new Date(s).getTime(), eT = new Date(e).getTime();
    if (eT <= sT) { toast('End must be after start'); return; }
    if (eT > Date.now()) { toast('End time can’t be in the future'); return; }
    if (eT - sT > 72 * 3600000) { toast('That’s over 72h — double-check the dates'); return; }
    var btn = $('#fm-save'); btn.disabled = true; btn.textContent = 'Saving…';
    // No dedicated endpoint needed: create an open fast, then close it with updateFast.
    api('startFast', { startAt: fromLocalInput(s) }).then(function (data) {
      return api('updateFast', { id: data.fast.id, startAt: fromLocalInput(s), endAt: fromLocalInput(e) });
    }).then(function () {
      state.activeFast = null;
      var mark = milestoneInfo((eT - sT) / 3600000).reached;
      toast(mark ? 'Past fast logged — ' + mark + 'h mark 🎉' : 'Past fast logged ✓');
      renderFasting();
    }).catch(function (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Save fast'; });
  }

  // Month calendar of fasts (colored by duration tier, keyed to the START date).
  function fastTierColor(hours) {
    if (hours >= 18) return 'var(--green)';
    if (hours >= 16) return '#38bdf8';
    if (hours >= 14) return 'var(--amber)';
    return '#8da3c4';
  }
  function buildFastCal(fasts) {
    var grid = $('#fast-cal'), label = $('#fc-label');
    if (!grid || !label) return;
    var ym = state.fastCalYm || (state.fastCalYm = ymOf(todayStr()));
    label.textContent = ymLabel(ym);
    $('#fc-next').disabled = ym >= ymOf(todayStr());
    var byDate = {};
    (fasts || []).forEach(function (f) {
      var dte = fmt(parse(new Date(f.startAt)));
      var h = (new Date(f.endAt) - new Date(f.startAt)) / 3.6e6;
      if (!byDate[dte] || h > byDate[dte].h) byDate[dte] = { h: h, f: f };
    });
    grid.innerHTML = '';
    var today = todayStr();
    var p = ym.split('-'), first = new Date(+p[0], +p[1] - 1, 1), lead = (first.getDay() + 6) % 7;
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      (function (date) {
        var cell = el('div', 'cal-cell');
        var hit = byDate[date];
        cell.innerHTML = '<span class="cc-num">' + Number(date.slice(8)) + '</span>' +
          '<span class="cc-date">' + (hit ? Math.floor(hit.h) + 'h' : '') + '</span>';
        if (date > today) cell.classList.add('pre');
        else {
          cell.classList.add('editable');
          if (hit) {
            var col = fastTierColor(hit.h);
            cell.style.background = 'color-mix(in srgb, ' + col + ' 30%, var(--bg-soft))';
            cell.style.borderColor = col; cell.style.color = 'var(--text)';
            cell.addEventListener('click', function () {
              var row = document.querySelector('[data-fast-row="' + hit.f.id + '"]');
              if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(function () { row.classList.remove('flash'); }, 1200); }
            });
          } else {
            cell.addEventListener('click', function () { fastManualOpen(date); });
          }
        }
        if (date === today) cell.classList.add('today');
        grid.appendChild(cell);
      })(ym + '-' + pad(day));
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
    if (st) {
      var mins = mi.next ? Math.max(0, Math.round((mi.next - hours) * 60)) : 0;
      st.textContent = mi.next ? ('next: ' + mi.next + 'h in ' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm')) : 'beast mode 🦾';
    }
    document.querySelectorAll('[data-fm]').forEach(function (c) {
      c.classList.toggle('hit', hours >= Number(c.getAttribute('data-fm')));
    });
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
      var all = data.fasts || [];
      buildFastCal(all);
      var fcPrev = $('#fc-prev'), fcNext = $('#fc-next');
      if (fcPrev && !fcPrev._bound) {
        fcPrev._bound = true;
        fcPrev.addEventListener('click', function () { state.fastCalYm = ymShift(state.fastCalYm, -1); buildFastCal(all); });
        fcNext.addEventListener('click', function () { state.fastCalYm = ymShift(state.fastCalYm, 1); buildFastCal(all); });
      }
      var box = $('#fast-history'); if (!box) return;
      var list = all.slice(0, 10);
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<p class="muted tiny">No fasts yet — start your first one above.</p>'; return; }
      box.appendChild(el('div', 'muted tiny fh-title', 'Recent fasts'));
      list.forEach(function (f) { box.appendChild(buildFastRow(f)); });
    }).catch(function () {});
  }

  function buildFastRow(f) {
    var dur = new Date(f.endAt).getTime() - new Date(f.startAt).getTime();
    var mark = milestoneInfo(dur / 3600000).reached;
    var wrap = el('div', 'fh-item');
    wrap.setAttribute('data-fast-row', f.id);
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
      s.cal += f.calories; s.p += f.protein; s.c += f.carbs; s.f += f.fat; s.s += (f.sugar || 0); s.fb += (f.fiber || 0); return s;
    }, { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 });

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
     ['f', 'Fat', t.f, g.fat], ['s', 'Sugar', t.s, g.sugar], ['fb', 'Fibre', t.fb, g.fiber]].forEach(function (m) {
      // Sugar is a cap (going over is bad); fibre is a target (more is good).
      var over = m[0] !== 'fb' && m[3] && m[2] > m[3];
      var pct = m[3] ? Math.min(100, Math.round((m[2] / m[3]) * 100)) : 0;
      var row = el('div', 'macro ' + m[0] + (over ? ' over' : ''));
      var goalTxt = m[3] ? ' / ' + m[3] + 'g' + (m[0] === 's' ? ' max' : (m[0] === 'fb' ? ' goal' : '')) : '';
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
          '<div class="fi-sub">' + (f.grams ? Math.round(f.grams) + ' g · ' : '') + 'P' + Math.round(f.protein) + ' C' + Math.round(f.carbs) + ' F' + Math.round(f.fat) + ' S' + Math.round(f.sugar || 0) + ' Fb' + Math.round(f.fiber || 0) + ' · <span class="fi-edit-hint">tap to edit</span></div></div>' +
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
      name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s, fb: food.fb || 0,
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
      c: f.carbs / g * 100, f: f.fat / g * 100, s: (f.sugar || 0) / g * 100, fb: (f.fiber || 0) / g * 100
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
    var k = f.kcal * x, p = f.p * x, c = f.c * x, ft = f.f * x, su = (f.s || 0) * x, fi = (f.fb || 0) * x;
    $('#p-macros').innerHTML =
      '<div class="pm-chip"><b>' + Math.round(k) + '</b>kcal</div>' +
      '<div class="pm-chip"><b>' + Math.round(p) + '</b>protein</div>' +
      '<div class="pm-chip"><b>' + Math.round(c) + '</b>carbs</div>' +
      '<div class="pm-chip"><b>' + Math.round(ft) + '</b>fat</div>' +
      '<div class="pm-chip"><b>' + Math.round(su) + '</b>sugar</div>' +
      '<div class="pm-chip"><b>' + Math.round(fi) + '</b>fibre</div>';
  }
  function addPortion() {
    var f = state.pendingFood; if (!f) return;
    var grams = portionGrams();
    var x = grams / 100;
    var macros = { calories: f.kcal * x, protein: f.p * x, carbs: f.c * x, fat: f.f * x, sugar: (f.s || 0) * x, fiber: (f.fb || 0) * x };
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
    var fibre = Number($('#m-fiber').value) || sd.fiber || 0;
    var food = {
      name: name,
      kcal: Number($('#m-cal').value) || 0,
      p: Number($('#m-protein').value) || 0,
      c: Number($('#m-carbs').value) || 0,
      f: Number($('#m-fat').value) || 0,
      s: Number($('#m-sugar').value) || 0,
      fb: fibre,
      serving: 100,
      // full panel (from a scan) — stored in the backend dataset, not shown here
      satFat: sd.saturatedFat || 0, transFat: sd.transFat || 0, fiber: fibre, addedSugar: sd.addedSugar || 0,
      sodium: sd.sodium || 0, cholesterol: sd.cholesterol || 0, calcium: sd.calcium || 0, iron: sd.iron || 0,
      servingSize: sd.servingSize || '', data: state.scanData
    };
    saveCustomFood(food);   // share with everyone so it's searchable
    pickFood(food);
    state.scanData = null;
    $('#m-name').value = $('#m-cal').value = $('#m-protein').value = $('#m-carbs').value = $('#m-fat').value = $('#m-sugar').value = $('#m-fiber').value = '';
  }
  function saveCustomFood(food) {
    var exists = (state.customFoods || []).some(function (f) { return f.name.toLowerCase() === food.name.toLowerCase(); });
    if (!exists) state.customFoods.push({ name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s, fb: food.fb || food.fiber || 0, serving: 100, shared: true });
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
    put('#m-cal', d.calories, true); put('#m-protein', d.protein); put('#m-carbs', d.carbs); put('#m-fat', d.fat); put('#m-sugar', d.sugar); put('#m-fiber', d.fiber);
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
    var fiber = firstNumAfter(t, 'dietary fibre'); if (fiber == null) fiber = firstNumAfter(t, 'dietary fiber');
    if (fiber == null) fiber = firstNumAfter(t, 'fibre'); if (fiber == null) fiber = firstNumAfter(t, 'fiber');

    // Convert per-serving labels to per-100.
    var scale = 1, note = 'per 100';
    var ps = t.match(/per\s*serv\w*[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i) || t.match(/serving\s*size[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i);
    if (ps) { var sz = parseFloat(ps[1].replace(',', '.')); if (sz > 0 && Math.abs(sz - 100) > 1) { scale = 100 / sz; note = 'converted from per ' + sz + ps[2]; } }

    var any = false;
    function put(sel, v, intval) { if (v != null) { var x = v * scale; $(sel).value = intval ? Math.round(x) : Math.round(x * 10) / 10; any = true; } }
    put('#m-cal', kcal, true); put('#m-protein', protein); put('#m-carbs', carbs); put('#m-fat', fat); put('#m-sugar', sugar); put('#m-fiber', fiber);
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
    var fiber = Math.round(cal / 1000 * 14); // ~14 g fibre per 1000 kcal (USDA guideline)
    $('#g-cal').value = cal; $('#g-protein').value = protein; $('#g-carbs').value = carbs; $('#g-fat').value = fat;
    $('#g-sugar').value = sugar; $('#g-fiber').value = fiber;
    toast('Targets calculated — tap Save');
  }

  function saveGoals() {
    // Merge into the existing profile so we don't wipe mode/softTarget/customTasks.
    var profile = Object.assign({}, state.profile, {
      sex: $('#g-sex').value, age: +$('#g-age').value || '', heightCm: +$('#g-height').value || '',
      weightKg: +$('#g-weight').value || '', activity: $('#g-activity').value, goalType: $('#g-goaltype').value,
      calorieGoal: +$('#g-cal').value || 0, proteinGoal: +$('#g-protein').value || 0,
      carbGoal: +$('#g-carbs').value || 0, fatGoal: +$('#g-fat').value || 0, sugarGoal: +$('#g-sugar').value || 0,
      fiberGoal: +$('#g-fiber').value || 0
    });
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
    // Prefer the latest weight logged in Body over the older manual profile value.
    $('#g-weight').value = (lastMetric('weight') || {}).v || p.weightKg || '';
    $('#g-cal').value = p.calorieGoal || '';
    $('#g-protein').value = p.proteinGoal || '';
    $('#g-carbs').value = p.carbGoal || '';
    $('#g-fat').value = p.fatGoal || '';
    $('#g-sugar').value = p.sugarGoal || '';
    $('#g-fiber').value = p.fiberGoal || '';
  }

  /* ---------------- Fitness calculators ---------------- */
  var ACT_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };

  // Auto-fills a field from Body/profile data, unless the user has directly
  // edited that field this session (tracked via state.calcTouched). Always
  // re-syncs untouched fields, so a fresh Body log shows up immediately.
  if (!state.calcTouched) state.calcTouched = {};
  function calcAutoFill(sel, v) {
    var e = $(sel); if (!e || state.calcTouched[e.id]) return;
    if (!(v || v === 0)) return;
    e.value = v;
  }
  function calcAutoSelect(sel, v) {
    var e = $(sel); if (!e || !v || state.calcTouched[e.id]) return;
    e.value = v;
  }
  function renderCalc() {
    var p = state.profile || {};
    var weight = (lastMetric('weight') || {}).v || p.weightKg;
    var neck = (lastMetric('neck') || {}).v;
    var waist = (lastMetric('waist') || {}).v;
    var hip = (lastMetric('hips') || {}).v;

    calcAutoFill('#bmi-h', p.heightCm); calcAutoFill('#bmi-w', weight);
    calcAutoFill('#bf-h', p.heightCm); calcAutoSelect('#bf-sex', p.sex);
    calcAutoFill('#bf-neck', neck); calcAutoFill('#bf-waist', waist); calcAutoFill('#bf-hip', hip);
    $('#bf-hip-wrap').classList.toggle('hidden', $('#bf-sex').value !== 'female');
    calcAutoSelect('#cal-sex', p.sex); calcAutoFill('#cal-age', p.age); calcAutoFill('#cal-h', p.heightCm); calcAutoFill('#cal-w', weight);
    calcAutoSelect('#cal-act', p.activity); calcAutoSelect('#cal-goal', p.goalType);
    calcAutoFill('#mac-cal', p.calorieGoal);
    calcAutoSelect('#iw-sex', p.sex); calcAutoFill('#iw-h', p.heightCm);
    calcAutoFill('#wtr-w', weight);
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
      if (sex === 'female' && !hip) return calcOut('#bf-out', 'Enter hip measurement.');
      if (sex !== 'female' && waist - neck <= 0) return calcOut('#bf-out', 'Waist must be larger than neck.');
      var bf = navyBodyFat(sex, H, neck, waist, hip);
      // ACE body-fat categories differ by sex.
      var tag = sex === 'female'
        ? (bf < 14 ? 'essential' : bf < 21 ? 'athlete' : bf < 25 ? 'fitness' : bf < 32 ? 'acceptable' : 'obese range')
        : (bf < 6 ? 'essential' : bf < 14 ? 'athlete' : bf < 18 ? 'fitness' : bf < 25 ? 'acceptable' : 'obese range');
      calcOut('#bf-out', '<b>' + bf.toFixed(1) + '%</b> body fat (' + (sex === 'female' ? 'women' : 'men') + ', US Navy estimate) · ' + tag);
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
          '🍽 ' + u.foodLogs + ' food logs · joined ' + esc(joined) + ' · started ' + esc(u.startDate) + ' · last active ' + (u.lastActive ? esc(u.lastActive) : '—') +
          (u.email ? ' · ✉️ ' + esc(u.email) : '') + '</div>' +
          '<button class="btn fr-mini au-reset" data-resetpw="' + esc(u.username) + '">Reset password</button></div>';
      }).join('');
  }
  function adminResetUserPassword(username) {
    var npw = prompt('Set a new password for @' + username + ' (tell them this; they can change it later):');
    if (npw == null) return;
    npw = String(npw).trim();
    if (npw.length < 4) { toast('Password must be at least 4 characters'); return; }
    api('adminResetPassword', { username: username, newPassword: npw }).then(function () {
      toast('Password reset for @' + username + ' ✓');
    }).catch(function (e) { toast(e.message); });
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

  /* ---------------- ATLAS home + app library ---------------- */
  var APPS = [
    { id: 'challenge', name: 'Challenge', icon: '🔥', pillar: 'body', open: function () { switchView('today'); } },
    { id: 'diet',      name: 'Diet',      icon: '🥗', pillar: 'body', open: function () { switchView('diet'); } },
    { id: 'fast',      name: 'Fast',      icon: '⏳', pillar: 'body', open: function () { switchView('fast'); } },
    { id: 'water',     name: 'Water',     icon: '💧', pillar: 'body', open: function () { switchView('water'); } },
    { id: 'mood',      name: 'Mood',      icon: '🙂', pillar: 'body', open: function () { switchView('mood'); } },
    { id: 'gut',       name: 'Gut',       icon: '🌿', pillar: 'body', open: function () { switchView('gut'); } },
    { id: 'steps',     name: 'Steps',     icon: '👟', pillar: 'body', open: function () { switchView('steps'); } },
    { id: 'sleep',     name: 'Sleep',     icon: '😴', pillar: 'body', open: function () { switchView('sleep'); } },
    { id: 'body',      name: 'Body',      icon: '⚖️', pillar: 'body', open: function () { switchView('body'); } },
    { id: 'gym',       name: 'Gym Log',   icon: '🏋️', pillar: 'body', open: function () { switchView('gym'); } },
    { id: 'meds',      name: 'Meds',      icon: '💊', pillar: 'body', open: function () { switchView('meds'); } },
    { id: 'calc',      name: 'Calc',      icon: '🧮', pillar: 'body', open: function () { switchView('calc'); } },
    { id: 'journal',   name: 'Journal',   icon: '📓', pillar: 'mind', open: function () { switchView('journal'); } },
    { id: 'reading',   name: 'Reading',   icon: '📖', pillar: 'mind', open: function () { switchView('reading'); } },
    { id: 'breathe',   name: 'Breathe',   icon: '🫁', pillar: 'mind', open: function () { switchView('breathe'); } },
    { id: 'detox',     name: 'Detox',     icon: '📵', pillar: 'mind', open: function () { switchView('detox'); } },
    { id: 'money',     name: 'Money',     icon: '💸', pillar: 'money', open: function () { switchView('money'); } },
    { id: 'subs',      name: 'Subs',      icon: '🔁', pillar: 'money', open: function () { switchView('subs'); } },
    { id: 'savings',   name: 'Savings',   icon: '🐷', pillar: 'money', open: function () { switchView('savings'); } },
    { id: 'habits',    name: 'Habits',    icon: '🔗', pillar: 'life', open: function () { switchView('habits'); } },
    { id: 'work',      name: 'Work',      icon: '💼', pillar: 'life', open: function () { switchView('work'); } },
    { id: 'tasks',     name: 'Tasks',     icon: '✅', pillar: 'life', open: function () { switchView('tasks'); } },
    { id: 'goals',     name: 'Goals',     icon: '🎯', pillar: 'life', open: function () { switchView('goals'); } },
    { id: 'friends',   name: 'Friends',   icon: '👥', pillar: 'life', open: function () { switchView('board'); } },
    { id: 'coach',     name: 'Coach',     icon: '✨', pillar: 'life', open: function () { openCoach(); } },
    { id: 'stats',     name: 'Stats',     icon: '📈', pillar: 'life', open: function () { switchView('stats'); } },
    { id: 'journey',   name: 'Journey',   icon: '🗓️', pillar: 'life', open: function () { switchView('calendar'); } }
  ];
  var PILLARS = [
    { id: 'body', name: 'BODY', color: 'var(--body-c)' },
    { id: 'mind', name: 'MIND', color: 'var(--mind-c)' },
    { id: 'money', name: 'MONEY', color: 'var(--money-c)' },
    { id: 'life', name: 'LIFE', color: 'var(--life-c)' }
  ];

  function pctOf(a, b) { return b ? Math.min(100, Math.round(a / b * 100)) : 0; }
  function pillarScores() {
    var d = state.today || {};
    var taskPct = pctOf(completedCount(d), TOTAL_ITEMS);
    var waterPct = pctOf(Number(d.waterMl) || 0, WATER_GOAL);
    var body = Math.round(taskPct * 0.6 + waterPct * 0.4);
    // MIND — mood + reading
    var moodPct = d.mood ? Math.round(d.mood / 5 * 100) : null;
    var readPct = d.reading ? 100 : 0;
    var mind = moodPct == null ? readPct : Math.round(moodPct * 0.6 + readPct * 0.4);
    // LIFE — habits done + businesses worked today
    var habits = (state.profile && state.profile.customTasks) || [];
    var hPct = habits.length ? pctOf(habits.filter(function (h) { return d.extra && d.extra[h.id]; }).length, habits.length) : null;
    var bizList = businesses(), worked = 0;
    bizList.forEach(function (b) { var e = (d.biz || {})[b.id] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) worked++; });
    var wPct = bizList.length ? pctOf(worked, bizList.length) : null;
    var lp = [hPct, wPct].filter(function (x) { return x != null; });
    var life = lp.length ? Math.round(lp.reduce(function (a, b) { return a + b; }, 0) / lp.length) : null;
    return { body: body, mind: mind, money: null, life: life }; // money apps arrive later
  }

  function renderHome() {
    if (!state.user) return;
    var d = state.today || {};
    var cd = Math.max(1, state.user.currentDay);
    var chip = $('#home-daychip');
    if (chip) chip.innerHTML = 'DAY ' + cd + (cd > LEN ? ' 🏆' : '') + ' · ' + streakOf(state.logs) + '🔥';

    var sc = pillarScores();
    var rings = $('#home-rings');
    if (rings) {
      var circ = 2 * Math.PI * 26;
      rings.innerHTML = PILLARS.map(function (p) {
        var v = sc[p.id];
        var frac = v == null ? 0 : v / 100;
        return '<button class="pillar" data-pillar="' + p.id + '" style="--pc:' + p.color + '">' +
          '<span class="pring-wrap"><svg viewBox="0 0 64 64" class="pring">' +
          '<circle class="pring-bg" cx="32" cy="32" r="26"></circle>' +
          '<circle class="pring-fg" cx="32" cy="32" r="26" stroke-dasharray="' + circ + '" stroke-dashoffset="' + (circ * (1 - frac)) + '"></circle></svg>' +
          '<span class="pillar-val">' + (v == null ? '—' : v) + '</span></span>' +
          '<span class="pillar-name eyebrow">' + p.name + '</span></button>';
      }).join('');
    }

    var brief = $('#home-brief');
    if (brief) {
      var parts = [];
      parts.push(completedCount(d) + '/' + TOTAL_ITEMS + ' tasks');
      parts.push(litres(Number(d.waterMl) || 0) + '/' + litres(WATER_GOAL) + ' L water');
      if (state.activeFast) parts.push('fasting');
      if (d.mood) parts.push('mood ' + d.mood + '/5');
      brief.innerHTML = '<span class="eyebrow">ATLAS Brief</span><div class="brief-line">' +
        (goalMet(d) ? '🎉 Day goal met — keep the streak alive.' : 'Today so far: ' + parts.join(' · ') + '.') + '</div>';
    }

    var spot = $('#home-spotlight');
    if (spot) {
      var left = TOTAL_ITEMS - completedCount(d);
      var html;
      if (!goalMet(d)) {
        var dayLine = cd <= LEN ? 'Day ' + cd + ' of ' + LEN : 'Day ' + cd + ' · 75 Hard conquered 🏆';
        html = '<span class="eyebrow">Spotlight · Challenge</span>' +
          '<div class="spot-big">' + left + ' task' + (left === 1 ? '' : 's') + ' left today</div>' +
          '<div class="muted tiny">' + dayLine + ' · ' + streakOf(state.logs) + '-day streak</div>' +
          '<button class="btn primary block spot-cta" data-qa="today">Open Challenge</button>';
      } else {
        html = '<span class="eyebrow">Spotlight · Coach</span>' +
          '<div class="spot-big">Nice work today 💪</div>' +
          '<div class="muted tiny">Ask your AI coach what to focus on next.</div>' +
          '<button class="btn primary block spot-cta" data-qa="coach">Ask Coach</button>';
      }
      spot.innerHTML = html;
    }

    // Life Score card — this month's game grade
    var scoreBox = $('#home-score');
    if (scoreBox) {
      var ym = ymOf(todayStr());
      ensureMoneyMonth(ym, function () {
        if (!$('#view-home').classList.contains('hidden')) renderHome();
      });
      var msc = monthScores(ym);
      if (!msc) scoreBox.classList.add('hidden');
      else {
        scoreBox.classList.remove('hidden');
        var money = moneyScoreFor(ym);
        var overall = monthOverall(ym);
        var og = gradeOf(overall);
        var minis = [
          ['Body', msc.body, 'var(--body-c)'], ['Mind', msc.mind, 'var(--mind-c)'],
          ['Money', money, 'var(--money-c)'], ['Life', msc.life, 'var(--life-c)']
        ];
        scoreBox.innerHTML =
          '<div class="mr-head">' +
            '<div><span class="eyebrow">Life Score · ' + ymShort(ym) + '</span>' +
            '<div class="hs-minis">' + minis.map(function (x) {
              var g = gradeOf(x[1]);
              return '<span class="hs-mini" style="--pc:' + x[2] + '">' + x[0] + ' <b class="gtext-' + g.cls + '">' + (x[1] === undefined ? '…' : g.g) + '</b></span>';
            }).join('') + '</div></div>' +
            '<div class="grade-badge g-' + og.cls + '">' + og.g + '</div>' +
          '</div>';
      }
    }

    var tiles = $('#home-tiles');
    if (tiles) {
      var t = [
        ['💧 Water', litres(Number(d.waterMl) || 0) + ' / ' + litres(WATER_GOAL) + ' L'],
        ['✓ Tasks', completedCount(d) + ' / ' + TOTAL_ITEMS],
        ['🔥 Streak', streakOf(state.logs) + ' days'],
        ['⚖ Mode', (challengeMode() === 'soft' ? '75 Soft' : '75 Hard') + (cd > LEN ? ' ✓' : '')]
      ];
      tiles.innerHTML = t.map(function (x) {
        return '<div class="htile"><div class="htile-lbl eyebrow">' + x[0] + '</div><div class="htile-val">' + x[1] + '</div></div>';
      }).join('');
    }
    buildMonthCalendar('#home-calendar', ymOf(todayStr()));
  }

  // Re-render every visible view that shows water, so a change reflects everywhere.
  function afterWaterChange(d) {
    if (d && d.date !== todayStr()) queueSaveDay(d); else queueSave();
    if (!$('#view-today').classList.contains('hidden')) renderToday();
    if (!$('#view-water').classList.contains('hidden')) renderWaterApp();
    if (!$('#view-home').classList.contains('hidden')) renderHome();
  }
  // Animated water jar — the level glides to the new value on every sip.
  var lastJarPct = -1;
  function waterNote(ml, pct) {
    if (pct >= 100) return 'Goal smashed — hydration king 👑';
    if (pct >= 75) return 'Almost there — one more push 💪';
    if (pct >= 50) return 'Halfway. Keep sipping 🌊';
    if (ml > 0) return 'Good start — stay on it.';
    return 'First sip of the day?';
  }
  function renderWaterApp() {
    var box = $('#water-app'); if (!box) return;
    var d = appDay();
    var ml = Number(d.waterMl) || 0, pct = pctOf(ml, WATER_GOAL);
    var prev = lastJarPct < 0 ? pct : lastJarPct;
    var yFor = function (p) { return Math.round(150 * (1 - p / 100)); }; // interior height
    box.innerHTML = dayBarHtml();
    bindDayBar(box, renderWaterApp);
    var card = el('div', 'card water-card' + (pct >= 100 ? ' full' : '') + (pct >= 20 ? ' has-water' : ''));
    card.innerHTML =
      '<div class="jar-wrap">' +
        '<svg viewBox="0 0 150 200" class="jar" aria-hidden="true">' +
          '<defs><clipPath id="jarclip"><rect x="25" y="24" width="100" height="150" rx="16"/></clipPath></defs>' +
          '<rect class="jar-lid" x="43" y="8" width="64" height="12" rx="6"/>' +
          '<rect class="jar-glass" x="25" y="24" width="100" height="150" rx="16"/>' +
          '<g clip-path="url(#jarclip)"><g class="jar-water" style="transform:translateY(' + yFor(prev) + 'px)">' +
            '<path class="wave w2" d="M0 30 Q 15 22, 30 30 T 60 30 T 90 30 T 120 30 T 150 30 T 180 30 T 210 30 T 240 30 T 270 30 T 300 30 V 240 H 0 Z"/>' +
            '<path class="wave w1" d="M0 32 Q 12 25, 24 32 T 48 32 T 72 32 T 96 32 T 120 32 T 144 32 T 168 32 T 192 32 T 216 32 T 240 32 T 264 32 T 288 32 V 240 H 0 Z"/>' +
            '<circle class="bub b1" cx="55" cy="150" r="3"/>' +
            '<circle class="bub b2" cx="82" cy="165" r="2.4"/>' +
            '<circle class="bub b3" cx="102" cy="145" r="2"/>' +
          '</g></g>' +
          '<rect class="jar-glass-line" x="25" y="24" width="100" height="150" rx="16"/>' +
          '<line class="jar-tick" x1="112" y1="61" x2="122" y2="61"/>' +
          '<line class="jar-tick" x1="112" y1="99" x2="122" y2="99"/>' +
          '<line class="jar-tick" x1="112" y1="136" x2="122" y2="136"/>' +
        '</svg>' +
        '<div class="jar-side">' +
          '<div class="water-big"><b>' + litres(ml) + '</b> <span class="muted">/ ' + litres(WATER_GOAL) + ' L</span></div>' +
          '<div class="jar-pct mono">' + pct + '%</div>' +
          '<div class="muted tiny jar-note">' + waterNote(ml, pct) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="water-quick">' +
        '<button class="btn" data-w="250">+250 ml</button>' +
        '<button class="btn" data-w="500">+500 ml</button>' +
        '<button class="btn" data-w="1000">+1 L</button>' +
        '<button class="btn danger" data-w="-250">−250</button>' +
      '</div>';
    box.appendChild(card);
    box.appendChild(renderWater(d));
    // Two rAFs so the browser paints the previous level first, then glides.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var w = card.querySelector('.jar-water');
      if (w) w.style.transform = 'translateY(' + yFor(pct) + 'px)';
    }); });
    lastJarPct = pct;
    card.querySelectorAll('[data-w]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = Number(b.getAttribute('data-w'));
        var was = Number(d.waterMl) || 0;
        d.waterMl = Math.max(0, Math.min(WATER_GOAL * 3, was + v));
        if (was < WATER_GOAL && d.waterMl >= WATER_GOAL) toast('4 L done — goal smashed! 💧👑');
        afterWaterChange(d);
      });
    });
  }
  function renderReading() {
    var box = $('#reading-app'); if (!box) return;
    var d = appDay(), r = (state.profile && state.profile.reading) || {};
    box.innerHTML = dayBarHtml() +
      '<div class="card"><div class="eyebrow">' + (appDate() === todayStr() ? 'Today' : prettyDate(appDate())) + ' · 75 Hard</div>' +
        '<label class="fx-toggle" style="margin-top:8px"><input type="checkbox" id="reading-done"' + (d.reading ? ' checked' : '') + ' /> Read 10 pages</label></div>' +
      '<div class="card"><div class="eyebrow">Current book</div>' +
        '<label style="margin-top:8px">Title<input id="rd-book" value="' + esc(r.book || '') + '" placeholder="e.g. Atomic Habits" /></label>' +
        '<div class="manual-grid"><label>Current page<input id="rd-page" type="number" inputmode="numeric" value="' + (r.page || '') + '" /></label>' +
        '<label>Total pages<input id="rd-total" type="number" inputmode="numeric" value="' + (r.total || '') + '" /></label></div>' +
        (r.total ? '<div class="fc-bar" style="margin:6px 0 12px"><span style="width:' + pctOf(r.page || 0, r.total) + '%"></span></div><div class="muted tiny">Page ' + (r.page || 0) + ' / ' + r.total + ' · ' + pctOf(r.page || 0, r.total) + '%</div>' : '') +
        '<button id="rd-save" class="btn primary block" style="margin-top:10px">Save book</button></div>';
    bindDayBar(box, renderReading);
    $('#reading-done').addEventListener('change', function () { d.reading = this.checked; queueSaveDay(d); });
    $('#rd-save').addEventListener('click', function () {
      var prof = Object.assign({}, state.profile, { reading: { book: $('#rd-book').value.trim(), page: Number($('#rd-page').value) || 0, total: Number($('#rd-total').value) || 0 } });
      state.profile = prof;
      api('saveGoals', { profile: prof }).then(function (dd) { if (dd && dd.profile) state.profile = dd.profile; toast('Saved ✓'); renderReading(); }).catch(function (e) { toast(e.message); });
    });
  }

  /* ----- Steps / Sleep / Body — stored in day-log metrics {} ----- */
  function metricsOf(d) { if (!d.metrics) d.metrics = {}; return d.metrics; }
  function setMetric(k, v) { metricsOf(state.today)[k] = v; queueSave(); }
  // Small progress ring used by mini-app heroes.
  function ringMini(pct, color, size, inner) {
    var circ = 2 * Math.PI * 26;
    var off = circ * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return '<span class="ring-mini" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg viewBox="0 0 64 64"><circle class="rm-bg" cx="32" cy="32" r="26"></circle>' +
      '<circle class="rm-fg" cx="32" cy="32" r="26" style="stroke:' + color + ';stroke-dasharray:' + circ + ';stroke-dashoffset:' + off + '"></circle></svg>' +
      '<span class="rm-center">' + inner + '</span></span>';
  }
  // Latest non-zero metric value on or before today, scanning back through logs.
  function lastMetric(key) {
    var today = todayStr();
    for (var i = state.logs.length - 1; i >= 0; i--) {
      var l = state.logs[i];
      if (l.date > today) continue;
      var v = l.metrics && Number(l.metrics[key]);
      if (v) return { v: v, date: l.date };
    }
    return null;
  }
  // First (earliest) non-zero metric value — the baseline.
  function firstMetric(key) {
    for (var i = 0; i < state.logs.length; i++) {
      var v = state.logs[i].metrics && Number(state.logs[i].metrics[key]);
      if (v) return { v: v, date: state.logs[i].date };
    }
    return null;
  }
  function metricTrend(key, sel, unit, div) {
    var box = $(sel); if (!box) return;
    var today = todayStr(), bars = '', max = 0, vals = [];
    for (var i = 6; i >= 0; i--) { var lg = logFor(addDays(today, -i)); var v = lg && lg.metrics ? Number(lg.metrics[key]) || 0 : 0; vals.push(v); if (v > max) max = v; }
    vals.forEach(function (v) {
      var h = max ? Math.max(4, Math.round(v / max * 46)) : 4;
      bars += '<div class="mbar" style="height:' + h + 'px"' + (v ? ' title="' + (div ? (v / div).toFixed(1) : v) + unit + '"' : '') + '></div>';
    });
    box.innerHTML = '<div class="mbars">' + bars + '</div><div class="muted tiny" style="margin-top:6px">Last 7 days</div>';
  }
  function renderSteps() {
    var box = $('#steps-app'); if (!box) return;
    var day = appDay(), m = metricsOf(day);
    var steps = Number(m.steps) || 0, goal = Number(state.profile && state.profile.stepGoal) || 10000;
    var pct = pctOf(steps, goal);
    box.innerHTML = dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--body-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + steps.toLocaleString() + '</b></div>' +
        '<div class="muted tiny">of <button class="inline-edit" id="steps-goal-btn">' + goal.toLocaleString() + '</button> steps' +
        (pct >= 100 ? ' · crushed 🎉' : '') + '</div></div></div>' +
      '<div class="card"><div class="water-quick">' +
        '<button class="btn" data-s="1000">+1,000</button><button class="btn" data-s="2500">+2,500</button>' +
        '<button class="btn" data-s="5000">+5,000</button><button class="btn" data-s="set">Set exact</button></div>' +
      '<div class="manual-grid" style="margin-top:12px">' +
      '<label>Calories burned<input id="mt-burn" type="number" inputmode="numeric" value="' + (m.burn || '') + '" /></label>' +
      '<label>Active min<input id="mt-active" type="number" inputmode="numeric" value="' + (m.active || '') + '" /></label></div>' +
      '<button id="mt-save" class="btn block">Save</button></div>' +
      '<div class="card"><div class="eyebrow">Steps · last 7 days</div><div id="steps-trend"></div></div>';
    bindDayBar(box, renderSteps);
    box.querySelectorAll('[data-s]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-s');
        if (v === 'set') { var x = prompt('Steps:', steps); if (x == null) return; m.steps = Math.max(0, Number(x) || 0); }
        else m.steps = steps + Number(v);
        queueSaveDay(day); renderSteps();
      });
    });
    $('#steps-goal-btn').addEventListener('click', function () {
      var x = prompt('Daily step goal:', goal); if (x == null) return;
      saveProfileKey('stepGoal', Math.max(1000, Number(x) || 10000), renderSteps);
    });
    $('#mt-save').addEventListener('click', function () { m.burn = Number($('#mt-burn').value) || 0; m.active = Number($('#mt-active').value) || 0; queueSaveDay(day); toast('Saved ✓'); });
    metricTrend('steps', '#steps-trend', '');
  }
  function renderSleep() {
    var box = $('#sleep-app'); if (!box) return;
    var day = appDay(), m = metricsOf(day);
    var mins = Number(m.sleepMin) || 0;
    var goalH = Number(state.profile && state.profile.sleepGoal) || 8;
    var pct = pctOf(mins, goalH * 60);
    var q = Number(m.sleepQ) || 0;
    var note = !mins ? 'Log last night to see your trend.'
      : mins >= goalH * 60 ? 'Fully charged 🔋' : mins >= goalH * 60 * 0.8 ? 'Decent — a little short.' : 'Running on fumes — sleep earlier tonight 😴';
    box.innerHTML = dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + (mins ? Math.floor(mins / 60) + 'h' + (mins % 60 ? (mins % 60) + '' : '') : '—') + '</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + (mins ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : 'No log yet') + '</b></div>' +
        '<div class="muted tiny">goal <button class="inline-edit" id="sleep-goal-btn">' + goalH + 'h</button> · ' + note + '</div></div></div>' +
      '<div class="card"><div class="manual-grid"><label>Hours<input id="sl-h" type="number" inputmode="numeric" value="' + (mins ? Math.floor(mins / 60) : '') + '" /></label>' +
      '<label>Minutes<input id="sl-m" type="number" inputmode="numeric" value="' + (mins ? mins % 60 : '') + '" /></label></div>' +
      '<div class="eyebrow" style="margin:6px 0 6px">Sleep quality</div>' +
      '<div class="star-row" id="sl-stars">' + [1, 2, 3, 4, 5].map(function (s) {
        return '<button class="star' + (q >= s ? ' on' : '') + '" data-star="' + s + '">★</button>';
      }).join('') + '</div>' +
      '<button id="sl-save" class="btn primary block" style="margin-top:10px">Save sleep</button></div>' +
      '<div class="card"><div class="eyebrow">Sleep · hours · last 7 days</div><div id="sleep-trend"></div></div>';
    $('#sleep-goal-btn').addEventListener('click', function () {
      var x = prompt('Sleep goal (hours):', goalH); if (x == null) return;
      saveProfileKey('sleepGoal', Math.min(14, Math.max(4, Number(x) || 8)), renderSleep);
    });
    bindDayBar(box, renderSleep);
    box.querySelectorAll('[data-star]').forEach(function (b) {
      b.addEventListener('click', function () {
        // Update stars in place — a re-render would wipe unsaved hour/min inputs.
        m.sleepQ = Number(b.getAttribute('data-star'));
        box.querySelectorAll('[data-star]').forEach(function (s) {
          s.classList.toggle('on', Number(s.getAttribute('data-star')) <= m.sleepQ);
        });
        queueSaveDay(day);
      });
    });
    $('#sl-save').addEventListener('click', function () {
      m.sleepMin = (Number($('#sl-h').value) || 0) * 60 + (Number($('#sl-m').value) || 0);
      queueSaveDay(day); toast('Saved ✓'); renderSleep();
    });
    metricTrend('sleepMin', '#sleep-trend', 'h', 60);
  }

  /* ----- Body metric engine: series, trend, chart ----- */
  var BODY_METRICS = [
    { k: 'weight',  label: 'Weight', unit: 'kg', dec: 1, downGood: true },
    { k: 'bodyfat', label: 'Fat',    unit: '%',  dec: 1, downGood: true },
    { k: 'waist',   label: 'Waist',  unit: 'cm', dec: 0, downGood: true },
    { k: 'chest',   label: 'Chest',  unit: 'cm', dec: 0, downGood: false },
    { k: 'arms',    label: 'Arms',   unit: 'cm', dec: 0, downGood: false },
    { k: 'hips',    label: 'Hips',   unit: 'cm', dec: 0, downGood: true },
    { k: 'neck',    label: 'Neck',   unit: 'cm', dec: 0, downGood: true }
  ];
  function bodyMetricDef(k) { return BODY_METRICS.filter(function (x) { return x.k === k; })[0] || BODY_METRICS[0]; }
  // All logged points for a metric, oldest → newest.
  function metricSeries(key) {
    var today = todayStr(), out = [];
    (state.logs || []).forEach(function (l) {
      if (l.date > today) return;
      var v = l.metrics && Number(l.metrics[key]);
      if (v) out.push({ date: l.date, v: v });
    });
    return out;
  }
  // Least-squares slope in units/week over the last `days` (default 42).
  function metricTrendWk(key, days) {
    var cut = addDays(todayStr(), -(days || 42));
    var pts = metricSeries(key).filter(function (p) { return p.date >= cut; });
    if (pts.length < 3) return null;
    var x0 = parseDateLocal(pts[0].date);
    var sx = 0, sy = 0, sxx = 0, sxy = 0, n = pts.length;
    pts.forEach(function (p) {
      var x = (parseDateLocal(p.date) - x0) / 864e5;
      sx += x; sy += p.v; sxx += x * x; sxy += x * p.v;
    });
    var denom = n * sxx - sx * sx;
    if (!denom) return null;
    return (n * sxy - sx * sy) / denom * 7;
  }
  function parseDateLocal(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); }

  // Mock-style area chart for any body metric: gradient fill, start/trend/today axis.
  function bodyChartSvg(def) {
    var pts = metricSeries(def.k);
    if (pts.length < 2) return '<p class="muted tiny" style="margin:10px 0 4px">Log ' + def.label.toLowerCase() + ' on a few days to unlock the trend chart.</p>';
    var min = pts[0].v, max = pts[0].v;
    pts.forEach(function (p) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
    var padV = Math.max(def.dec ? 0.5 : 1, (max - min) * 0.2); min -= padV; max += padV;
    var t0 = parseDateLocal(pts[0].date), t1 = parseDateLocal(pts[pts.length - 1].date);
    var span = Math.max(1, t1 - t0);
    var W = 320, H = 96, L = 4, R = 4, T = 8, B = 6;
    var X = function (p) { return L + (parseDateLocal(p.date) - t0) / span * (W - L - R); };
    var Y = function (v) { return T + (1 - (v - min) / (max - min)) * (H - T - B); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + X(pts[pts.length - 1]).toFixed(1) + ' ' + (H - B) + ' L' + X(pts[0]).toFixed(1) + ' ' + (H - B) + ' Z';
    var last = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="bchart" preserveAspectRatio="none">' +
      '<defs><linearGradient id="bgrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="var(--green)" stop-opacity=".28"/>' +
        '<stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path class="bc-area" d="' + area + '"/><path class="bc-line" d="' + line + '"/>' +
      '<circle class="bc-end" cx="' + X(last).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="3.5"/>' +
    '</svg>';
  }

  // Latest value + change since the first log of that metric.
  function metricNow(key) {
    var s = metricSeries(key);
    if (!s.length) return null;
    var first = s[0], last = s[s.length - 1];
    return { v: last.v, delta: s.length > 1 ? last.v - first.v : null, firstV: first.v, firstDate: first.date };
  }

  // Auto insight: trend + recomposition + ETA to goal weight.
  function bodyInsight(goal) {
    var bits = [];
    var w = metricNow('weight'), tw = metricTrendWk('weight');
    var wa = metricNow('waist'), ch = metricNow('chest');
    var waistDown = wa && wa.delta != null && wa.delta < 0;
    var chestUp = ch && ch.delta != null && ch.delta > 0;
    if (waistDown && chestUp) {
      bits.push('Waist down ' + Math.abs(wa.delta).toFixed(0) + ' cm, chest up ' + ch.delta.toFixed(0) + ' cm — that’s recomposition, not just loss');
    } else if (waistDown) {
      bits.push('Waist down ' + Math.abs(wa.delta).toFixed(0) + ' cm since day 1');
    }
    if (tw != null && Math.abs(tw) >= 0.05) {
      bits.push('weight trending ' + (tw < 0 ? '−' : '+') + Math.abs(tw).toFixed(2) + ' kg/wk');
    }
    if (goal && w && tw != null && Math.abs(tw) >= 0.05) {
      var gap = goal - w.v;
      if (gap * tw > 0) { // moving toward the goal
        var daysToGoal = Math.round(gap / (tw / 7));
        if (daysToGoal > 0 && daysToGoal < 400) {
          var eta = parse(addDays(todayStr(), daysToGoal)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          bits.push('on pace for ' + goal + ' kg by ' + eta);
        }
      }
    }
    if (!bits.length) return null;
    var s = bits.join(' — ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }

  // Shared U.S. Navy circumference body-fat formula — used by Body's live
  // estimate AND the Calculators app, so both always agree.
  function navyBodyFat(sex, heightCm, neck, waist, hip) {
    if (!heightCm || !neck || !waist) return null;
    if (sex === 'female') {
      if (!hip) return null;
      return 495 / (1.29579 - 0.35004 * log10(waist + hip - neck) + 0.22100 * log10(heightCm)) - 450;
    }
    if (waist - neck <= 0) return null;
    return 495 / (1.0324 - 0.19077 * log10(waist - neck) + 0.15456 * log10(heightCm)) - 450;
  }

  function renderBody() {
    var box = $('#body-app'); if (!box) return;
    var day = appDay(), m = metricsOf(day);
    var goal = Number(state.profile && state.profile.weightGoal) || 0;
    var heightCm = Number(state.profile && state.profile.heightCm) || 0;
    var sex = (state.profile && state.profile.sex) || '';
    var neckV = Number(m.neck) || (lastMetric('neck') || {}).v || 0;
    var waistV = Number(m.waist) || (lastMetric('waist') || {}).v || 0;
    var hipV = Number(m.hips) || (lastMetric('hips') || {}).v || 0;
    var manualBf = m.bodyfat || (lastMetric('bodyfat') || {}).v || 0;
    var autoBf = manualBf ? null : navyBodyFat(sex, heightCm, neckV, waistV, hipV);

    // Selected hero metric (chips at top switch it).
    if (!state.bodyMetric) state.bodyMetric = 'weight';
    var def = bodyMetricDef(state.bodyMetric);
    var now = metricNow(def.k);
    // Fat has a computed fallback when never logged manually.
    if (!now && def.k === 'bodyfat' && autoBf) now = { v: autoBf, delta: null, firstV: null, firstDate: null };
    var cur = now ? now.v : 0;
    var heroDelta = now && now.delta != null && Math.abs(now.delta) >= 0.05 ? now.delta : null;
    var deltaGood = heroDelta != null && ((heroDelta < 0) === def.downGood);
    var tw = metricTrendWk(def.k);
    var bmiW = metricNow('weight');
    var bmi = bmiW && heightCm ? bmiW.v / Math.pow(heightCm / 100, 2) : 0;
    var bmiTag = !bmi ? '' : bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy' : bmi < 30 ? 'overweight' : 'obese';
    var series = metricSeries(def.k);
    var insight = bodyInsight(goal);

    box.innerHTML = dayBarHtml() +
      // Metric selector
      '<div class="bm-chips">' + BODY_METRICS.map(function (x) {
        return '<button type="button" class="bm-chip' + (x.k === def.k ? ' active' : '') + '" data-bm="' + x.k + '">' + x.label + '</button>';
      }).join('') + '</div>' +
      // Hero: current value + delta + area chart
      '<div class="card body-hero2">' +
        '<div class="bh2-top"><span class="eyebrow">Current · ' + def.label + '</span>' +
          (def.k === 'weight' && goal ? '<span class="eyebrow">Goal ' + goal + ' kg</span>' : '') + '</div>' +
        '<div class="bh2-main">' +
          '<div class="bh2-val"><b>' + (cur ? cur.toFixed(def.dec) : '—') + '</b><span class="bh2-unit">' + def.unit + '</span>' +
            (!manualBf && def.k === 'bodyfat' && cur ? '<span class="muted tiny" style="margin-left:6px">Navy est.</span>' : '') + '</div>' +
          (heroDelta != null ? '<div class="bh2-delta ' + (deltaGood ? 'good' : 'warn') + '">' +
            (heroDelta < 0 ? '−' : '+') + Math.abs(heroDelta).toFixed(def.dec) + ' ' + def.unit +
            '<small>since day 1</small></div>' : '') +
        '</div>' +
        bodyChartSvg(def) +
        (series.length >= 2 ?
          '<div class="bh2-axis mono">' +
            '<span>' + parse(series[0].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase() + ' · ' + series[0].v.toFixed(def.dec) + '</span>' +
            '<span>' + (tw != null ? 'TREND ' + (tw < 0 ? '−' : '+') + Math.abs(tw).toFixed(2) + ' ' + def.unit.toUpperCase() + '/WK' : '') + '</span>' +
            '<span>TODAY</span>' +
          '</div>' : '') +
      '</div>' +
      // Comparison tiles for every other metric (tap = switch)
      '<div class="bm-tiles">' + BODY_METRICS.filter(function (x) { return x.k !== def.k; }).map(function (x) {
        var n = metricNow(x.k);
        if (!n && x.k === 'bodyfat' && autoBf) n = { v: autoBf, delta: null, est: true };
        var dTxt = n && n.delta != null && Math.abs(n.delta) >= 0.05
          ? '<span class="bmt-delta ' + (((n.delta < 0) === x.downGood) ? 'good' : 'warn') + '">' + (n.delta < 0 ? '−' : '+') + Math.abs(n.delta).toFixed(x.dec) + '</span>' : '';
        return '<button type="button" class="bm-tile" data-bm="' + x.k + '">' +
          '<span class="eyebrow">' + x.label + '</span>' +
          '<span class="bmt-val">' + (n ? (n.est ? '~' : '') + n.v.toFixed(x.dec) : '—') + ' <small>' + x.unit + '</small>' + dTxt + '</span></button>';
      }).join('') +
        (bmi ? '<button type="button" class="bm-tile" data-bm="weight"><span class="eyebrow">BMI</span><span class="bmt-val">' + bmi.toFixed(1) + ' <small>' + bmiTag + '</small></span></button>' : '') +
      '</div>' +
      // Insight
      (insight ? '<div class="card body-insight"><span class="bi-ico">◆</span><span>' + insight + '</span></div>' : '') +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Log this day</div>' +
        '<div class="manual-grid">' +
        '<label>Weight (kg)<input id="bd-w" type="number" inputmode="decimal" value="' + (m.weight || '') + '" /></label>' +
        '<label>Body fat (%) <span class="muted tiny">optional</span><input id="bd-bf" type="number" inputmode="decimal" value="' + (m.bodyfat || '') + '" placeholder="' + (autoBf ? autoBf.toFixed(1) + ' est.' : '') + '" /></label>' +
        '<label>Neck (cm)<input id="bd-neck" type="number" inputmode="decimal" value="' + (m.neck || '') + '" /></label>' +
        '<label>Waist (cm)<input id="bd-waist" type="number" inputmode="decimal" value="' + (m.waist || '') + '" /></label>' +
        '<label>Chest (cm)<input id="bd-chest" type="number" inputmode="decimal" value="' + (m.chest || '') + '" /></label>' +
        '<label>Arms (cm)<input id="bd-arms" type="number" inputmode="decimal" value="' + (m.arms || '') + '" /></label>' +
        '<label>Hips (cm)<input id="bd-hips" type="number" inputmode="decimal" value="' + (m.hips || '') + '" /></label>' +
        '</div>' +
        '<div class="manual-grid">' +
        '<label>Sex <span class="muted tiny">for BMR/body-fat calcs</span><select id="bd-sex"><option value="">—</option><option value="male"' + (sex === 'male' ? ' selected' : '') + '>Male</option><option value="female"' + (sex === 'female' ? ' selected' : '') + '>Female</option></select></label>' +
        '<label>Height (cm)<input id="bd-height" type="number" inputmode="decimal" value="' + (heightCm || '') + '" /></label>' +
        '<label>Goal weight (kg)<input id="bd-goal" type="number" inputmode="decimal" value="' + (goal || '') + '" /></label>' +
        '</div>' +
        '<p class="muted tiny" style="margin:4px 2px 10px">These feed straight into the <b>Calc</b> app — log once here, use everywhere.</p>' +
        '<button id="bd-save" class="btn primary block">Log this day</button></div>';
    bindDayBar(box, renderBody);
    box.querySelectorAll('[data-bm]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.bodyMetric = b.getAttribute('data-bm');
        renderBody();
        window.scrollTo(0, 0);
      });
    });
    $('#bd-save').addEventListener('click', function () {
      m.weight = Number($('#bd-w').value) || 0; m.waist = Number($('#bd-waist').value) || 0; m.bodyfat = Number($('#bd-bf').value) || 0;
      m.neck = Number($('#bd-neck').value) || 0;
      m.chest = Number($('#bd-chest').value) || 0; m.arms = Number($('#bd-arms').value) || 0; m.hips = Number($('#bd-hips').value) || 0;
      state.profile = Object.assign({}, state.profile, {
        sex: $('#bd-sex').value || state.profile.sex || '',
        weightGoal: Number($('#bd-goal').value) || 0,
        heightCm: Number($('#bd-height').value) || 0
      });
      queueSaveDay(day);
      api('saveGoals', { profile: state.profile }).catch(function () {});
      toast('Logged ✓'); renderBody();
    });
  }

  /* ================= Gym Log (Body) ================= */
  var GYM_PRESETS = ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Pull-ups', 'Lat Pulldown', 'Bicep Curl', 'Leg Press', 'Shoulder Press', 'Dips', 'Lunges'];
  function gymOf(d) { var m = metricsOf(d); if (!m.gym) m.gym = []; return m.gym; }
  function gymPRs() {
    var prs = {};
    (state.logs || []).forEach(function (l) {
      ((l.metrics && l.metrics.gym) || []).forEach(function (e) {
        var k = String(e.n || '').trim(); if (!k) return;
        if (!prs[k] || Number(e.kg) > prs[k].kg) prs[k] = { kg: Number(e.kg) || 0, reps: Number(e.reps) || 0, date: l.date };
      });
    });
    return prs;
  }
  function lastGymDay() {
    var today = todayStr();
    for (var i = state.logs.length - 1; i >= 0; i--) {
      var l = state.logs[i];
      if (l.date >= today) continue;
      if (l.metrics && l.metrics.gym && l.metrics.gym.length) return l;
    }
    return null;
  }
  function renderGym() {
    var box = $('#gym-app'); if (!box) return;
    var day = appDay();
    var list = gymOf(day);
    var vol = 0;
    list.forEach(function (e) { vol += (Number(e.sets) || 0) * (Number(e.reps) || 0) * (Number(e.kg) || 0); });
    var weekDays = 0, today = todayStr();
    for (var i = 0; i < 7; i++) {
      var l = logFor(addDays(today, -i));
      if (l && l.metrics && l.metrics.gym && l.metrics.gym.length) weekDays++;
    }
    var prs = gymPRs();
    var names = Object.keys(prs);
    var options = GYM_PRESETS.slice();
    names.forEach(function (n) { if (options.indexOf(n) < 0) options.push(n); });
    var prev = lastGymDay();

    box.innerHTML = dayBarHtml() +
      '<div class="card"><div class="gym-stats">' +
        '<div class="js-stat"><b>' + list.length + '</b><span>exercises</span></div>' +
        '<div class="js-stat"><b>' + (vol ? (vol >= 1000 ? (vol / 1000).toFixed(1) + 't' : vol + 'kg') : '0') + '</b><span>volume</span></div>' +
        '<div class="js-stat"><b>' + weekDays + '/7</b><span>days this week</span></div>' +
      '</div></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Add exercise</div>' +
        '<select id="gym-name">' + options.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '<option value="__custom">✏️ Custom…</option></select>' +
        '<div class="gym-grid">' +
          '<label>Sets<input id="gym-sets" type="number" inputmode="numeric" value="3" /></label>' +
          '<label>Reps<input id="gym-reps" type="number" inputmode="numeric" value="10" /></label>' +
          '<label>Weight kg<input id="gym-kg" type="number" inputmode="decimal" value="" placeholder="0" /></label>' +
        '</div>' +
        '<button id="gym-add" class="btn primary block">Add exercise</button>' +
        (!list.length && prev ? '<button id="gym-copy" class="btn block" style="margin-top:8px">↻ Repeat ' + shortDate(prev.date) + ' workout (' + prev.metrics.gym.length + ' lifts)</button>' : '') +
      '</div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:4px">' + (appDate() === todayStr() ? 'Today' : prettyDate(appDate())) + '</div><div id="gym-today">' +
        (list.length ? list.map(function (e, i) {
          var pr = prs[e.n] && Number(e.kg) >= prs[e.n].kg && Number(e.kg) > 0;
          return '<div class="list-row"><div><b>' + esc(e.n) + '</b>' + (pr ? ' <span class="pr-badge">PR 🏅</span>' : '') +
            '<div class="muted tiny">' + e.sets + ' × ' + e.reps + (e.kg ? ' @ ' + e.kg + ' kg' : ' · bodyweight') + '</div></div>' +
            '<button class="list-del" data-gi="' + i + '">✕</button></div>';
        }).join('') : '<p class="muted tiny">Nothing logged yet — hit your first set 💪</p>') +
      '</div></div>' +
      (names.length ? '<div class="card"><div class="eyebrow" style="margin-bottom:4px">Personal records</div>' +
        names.sort(function (a, b) { return prs[b].kg - prs[a].kg; }).slice(0, 8).map(function (n) {
          return '<div class="list-row"><div><b>' + esc(n) + '</b><div class="muted tiny">' + shortDate(prs[n].date) + '</div></div>' +
            '<span class="mono">' + prs[n].kg + ' kg</span></div>';
        }).join('') + '</div>' : '');

    $('#gym-add').addEventListener('click', function () {
      var sel = $('#gym-name').value, name = sel;
      if (sel === '__custom') { name = (prompt('Exercise name:') || '').trim(); if (!name) return; }
      var entry = {
        n: name.slice(0, 40),
        sets: Math.max(1, Number($('#gym-sets').value) || 1),
        reps: Math.max(1, Number($('#gym-reps').value) || 1),
        kg: Math.max(0, Number($('#gym-kg').value) || 0)
      };
      var prevBest = prs[entry.n] ? prs[entry.n].kg : 0;
      gymOf(day).push(entry);
      queueSaveDay(day);
      if (entry.kg > 0 && entry.kg > prevBest) toast('New PR on ' + entry.n + ' — ' + entry.kg + ' kg! 🏅');
      renderGym();
    });
    var copyBtn = $('#gym-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      prev.metrics.gym.forEach(function (e) { gymOf(day).push({ n: e.n, sets: e.sets, reps: e.reps, kg: e.kg }); });
      queueSaveDay(day); toast('Workout copied — beat it today 🔥'); renderGym();
    });
    bindDayBar(box, renderGym);
    box.querySelectorAll('[data-gi]').forEach(function (b) {
      b.addEventListener('click', function () {
        gymOf(day).splice(Number(b.getAttribute('data-gi')), 1);
        queueSaveDay(day); renderGym();
      });
    });
  }

  /* ================= Breathe (Mind) ================= */
  var BREATHE_MODES = [
    { id: 'box', name: 'Box', desc: '4·4·4·4 — focus', phases: [['Breathe in', 4, 1.35], ['Hold', 4, 1.35], ['Breathe out', 4, 1], ['Hold', 4, 1]] },
    { id: '478', name: '4-7-8', desc: 'calm & sleep', phases: [['Breathe in', 4, 1.35], ['Hold', 7, 1.35], ['Breathe out', 8, 1]] },
    { id: 'coh', name: '5-5', desc: 'coherent balance', phases: [['Breathe in', 5, 1.35], ['Breathe out', 5, 1]] }
  ];
  var breathe = { mode: 'box', mins: 3, running: false, tick: null, phaseAt: 0, endAt: 0 };
  function stopBreathe(silent) {
    if (breathe.tick) { clearInterval(breathe.tick); breathe.tick = null; }
    breathe.running = false;
    if (!silent) {
      var c = $('#br-circle');
      if (c) { c.style.transitionDuration = '.8s'; c.style.transform = 'scale(1)'; }
    }
  }
  function renderBreathe() {
    var box = $('#breathe-app'); if (!box) return;
    stopBreathe(true);
    var day = appDay(), m = metricsOf(day);
    var doneMin = Number(m.breathMin) || 0;
    var mode = BREATHE_MODES.filter(function (x) { return x.id === breathe.mode; })[0] || BREATHE_MODES[0];
    if (appDate() !== todayStr()) {
      // Past day: sessions are live-only — show/edit that day's banked minutes.
      box.innerHTML = dayBarHtml() +
        '<div class="card"><div class="eyebrow">' + prettyDate(appDate()) + '</div>' +
        '<div class="metric-big" style="margin-top:8px"><b>' + doneMin + '</b> <span class="muted">min breathed</span></div>' +
        '<div class="manual-grid" style="margin-top:10px"><label>Adjust minutes<input id="br-past" type="number" inputmode="numeric" value="' + (doneMin || '') + '" /></label></div>' +
        '<button id="br-past-save" class="btn primary block">Save</button></div>';
      bindDayBar(box, renderBreathe);
      $('#br-past-save').addEventListener('click', function () {
        m.breathMin = Math.max(0, Number($('#br-past').value) || 0);
        queueSaveDay(day); toast('Saved ✓'); renderBreathe();
      });
      return;
    }
    box.innerHTML = dayBarHtml() +
      '<div class="seg" id="br-modes">' + BREATHE_MODES.map(function (x) {
        return '<button data-brm="' + x.id + '"' + (x.id === breathe.mode ? ' class="active"' : '') + '>' + x.name + '</button>';
      }).join('') + '</div>' +
      '<p class="muted tiny center" style="margin:0 0 6px">' + mode.desc + '</p>' +
      '<div class="card breathe-card">' +
        '<div class="br-stage"><div class="br-ring"></div><div id="br-circle" class="br-circle"><span id="br-label">Ready?</span><span id="br-count" class="br-count"></span></div></div>' +
        '<div class="seg" id="br-mins" style="max-width:240px;margin:14px auto 10px">' +
          [1, 3, 5].map(function (n) { return '<button data-brt="' + n + '"' + (n === breathe.mins ? ' class="active"' : '') + '>' + n + ' min</button>'; }).join('') +
        '</div>' +
        '<button id="br-start" class="btn primary block">Start session</button>' +
        (doneMin ? '<p class="muted tiny center" style="margin:10px 0 0">🫁 ' + doneMin + ' min breathed today</p>' : '') +
      '</div>';
    bindDayBar(box, renderBreathe);
    $('#br-modes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-brm]'); if (!b) return;
      breathe.mode = b.getAttribute('data-brm'); renderBreathe();
    });
    $('#br-mins').addEventListener('click', function (e) {
      var b = e.target.closest('[data-brt]'); if (!b) return;
      breathe.mins = Number(b.getAttribute('data-brt')); renderBreathe();
    });
    $('#br-start').addEventListener('click', function () {
      if (breathe.running) { stopBreathe(); $('#br-start').textContent = 'Start session'; $('#br-label').textContent = 'Paused'; $('#br-count').textContent = ''; return; }
      startBreathe(mode);
    });
  }
  function startBreathe(mode) {
    breathe.running = true;
    breathe.endAt = Date.now() + breathe.mins * 60000;
    $('#br-start').textContent = 'Stop';
    var phaseIdx = -1, phaseLeft = 0;
    var next = function () {
      phaseIdx = (phaseIdx + 1) % mode.phases.length;
      var p = mode.phases[phaseIdx];
      phaseLeft = p[1];
      $('#br-label').textContent = p[0];
      $('#br-count').textContent = phaseLeft;
      var c = $('#br-circle');
      c.style.transitionDuration = p[1] + 's';
      c.style.transform = 'scale(' + p[2] + ')';
    };
    next();
    breathe.tick = setInterval(function () {
      if (!breathe.running) return;
      phaseLeft--;
      if (Date.now() >= breathe.endAt) {
        stopBreathe();
        var m = metricsOf(state.today);
        m.breathMin = (Number(m.breathMin) || 0) + breathe.mins;
        queueSave();
        toast('Session complete — ' + breathe.mins + ' min of calm 🫁✨');
        renderBreathe();
        return;
      }
      if (phaseLeft <= 0) next();
      else $('#br-count').textContent = phaseLeft;
    }, 1000);
  }

  /* ================= Digital Detox (Mind) ================= */
  function detoxKey() { return 'hard_detox_' + (state.username || ''); }
  function renderDetox() {
    var box = $('#detox-app'); if (!box) return;
    if (state.detoxTimer) { clearInterval(state.detoxTimer); state.detoxTimer = null; }
    var day = appDay(), m = metricsOf(day);
    var total = Number(m.detoxMin) || 0;
    var goal = Number(state.profile && state.profile.detoxGoal) || 60;
    var isToday = appDate() === todayStr();
    var startedAt = isToday ? (Number(localStorage.getItem(detoxKey())) || 0) : 0;
    var pct = pctOf(total, goal);
    box.innerHTML = dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + total + '</b> <span class="muted">min offline</span></div>' +
        '<div class="muted tiny">goal <button class="inline-edit" id="dx-goal-btn">' + goal + ' min</button> / day' + (pct >= 100 ? ' · unplugged 🏆' : '') + '</div></div></div>' +
      (isToday
        ? '<div class="card detox-card' + (startedAt ? ' active' : '') + '">' +
          (startedAt
            ? '<div class="eyebrow">Detox running</div><div id="dx-elapsed" class="dx-elapsed mono">00:00</div>' +
              '<p class="muted tiny center" style="margin:4px 0 12px">Phone down. Live a little 🌿</p>' +
              '<button id="dx-stop" class="btn primary block">End detox &amp; bank minutes</button>'
            : '<div class="eyebrow">Start a phone-free block</div>' +
              '<p class="muted tiny" style="margin:8px 0 12px">Start the timer, put the phone face-down. End it when you pick the phone back up — the minutes get banked here.</p>' +
              '<button id="dx-start" class="btn primary block">📵 Start detox</button>') +
          '</div>'
        : '<div class="card"><div class="eyebrow">Edit ' + prettyDate(appDate()) + '</div>' +
          '<div class="manual-grid" style="margin-top:8px"><label>Offline minutes<input id="dx-past" type="number" inputmode="numeric" value="' + (total || '') + '" /></label></div>' +
          '<button id="dx-past-save" class="btn primary block">Save</button></div>') +
      '<div class="card"><div class="eyebrow">Offline minutes · last 7 days</div><div id="detox-trend"></div></div>';
    bindDayBar(box, renderDetox);
    $('#dx-goal-btn').addEventListener('click', function () {
      var x = prompt('Daily phone-free goal (minutes):', goal); if (x == null) return;
      saveProfileKey('detoxGoal', Math.max(10, Number(x) || 60), renderDetox);
    });
    if (!isToday) {
      $('#dx-past-save').addEventListener('click', function () {
        m.detoxMin = Math.max(0, Number($('#dx-past').value) || 0);
        queueSaveDay(day); toast('Saved ✓'); renderDetox();
      });
      metricTrend('detoxMin', '#detox-trend', 'm');
      return;
    }
    if (startedAt) {
      var elapsedEl = $('#dx-elapsed');
      var tickFn = function () {
        var s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        var hh = Math.floor(s / 3600), mm2 = Math.floor((s % 3600) / 60), ss = s % 60;
        elapsedEl.textContent = (hh ? hh + ':' : '') + (mm2 < 10 ? '0' : '') + mm2 + ':' + (ss < 10 ? '0' : '') + ss;
      };
      tickFn();
      state.detoxTimer = setInterval(tickFn, 1000);
      $('#dx-stop').addEventListener('click', function () {
        var mins = Math.round((Date.now() - startedAt) / 60000);
        localStorage.removeItem(detoxKey());
        if (state.detoxTimer) { clearInterval(state.detoxTimer); state.detoxTimer = null; }
        if (mins >= 1) {
          m.detoxMin = (Number(m.detoxMin) || 0) + mins;
          queueSave();
          toast('+' + mins + ' min banked 📵✨');
        } else {
          toast('Under a minute — not banked.');
        }
        renderDetox();
      });
    } else {
      $('#dx-start').addEventListener('click', function () {
        localStorage.setItem(detoxKey(), String(Date.now()));
        renderDetox();
      });
    }
    metricTrend('detoxMin', '#detox-trend', 'm');
  }

  /* ================= Meds — medicines & supplements (Body) ================= */
  var MED_SLOTS = [
    { id: 'morning',   label: 'Morning',   emoji: '☀️' },
    { id: 'afternoon', label: 'Afternoon', emoji: '🌤️' },
    { id: 'evening',   label: 'Evening',   emoji: '🌇' },
    { id: 'night',     label: 'Night',     emoji: '🌙' }
  ];
  function medsList() { return (state.profile && state.profile.meds) || []; }
  function medTakenMap(d) { var m = metricsOf(d); if (!m.meds) m.meds = {}; return m.meds; }
  function medDoseCount(list) {
    return list.reduce(function (s, md) { return s + ((md.times || []).length || 0); }, 0);
  }
  function medTakenCount(d, list) {
    var taken = (d.metrics && d.metrics.meds) || {};
    var n = 0;
    list.forEach(function (md) {
      (md.times || []).forEach(function (t) { if (taken[md.id + '@' + t]) n++; });
    });
    return n;
  }
  // Adherence color for a date: green = all doses, amber = some, null = none logged.
  function medDayColor(date) {
    var l = logFor(date); if (!l) return null;
    var list = medsList(); if (!list.length) return null;
    var taken = medTakenCount(l, list);
    if (!taken) return null;
    return taken >= medDoseCount(list) ? 'var(--green)' : 'var(--amber)';
  }
  function medStreak() {
    var list = medsList(); if (!list.length || !medDoseCount(list)) return 0;
    var d = todayStr();
    // an unfinished today shouldn't zero the streak
    var l = logFor(d);
    if (!l || medTakenCount(l, list) < medDoseCount(list)) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || medTakenCount(lg, list) < medDoseCount(list)) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  function renderMeds() {
    var box = $('#meds-app'); if (!box) return;
    var day = appDay(), taken = medTakenMap(day), list = medsList();
    var total = medDoseCount(list), done = medTakenCount(day, list);
    var pct = pctOf(done, total);
    var html = dayBarHtml();

    if (list.length) {
      html +=
        '<div class="card hero-row' + (total && done >= total ? ' goal-hit' : '') + '">' +
          ringMini(pct, 'var(--body-c)', 92, '<b>' + done + '/' + total + '</b>') +
          '<div class="hero-meta"><div class="metric-big"><b>' + (total && done >= total ? 'All taken 🎉' : (total - done) + ' dose' + (total - done === 1 ? '' : 's') + ' left') + '</b></div>' +
          '<div class="muted tiny">💊 ' + list.length + ' med' + (list.length === 1 ? '' : 's') + ' · 🔥 ' + medStreak() + '-day streak</div></div></div>';
      MED_SLOTS.forEach(function (slot) {
        var rows = list.filter(function (md) { return (md.times || []).indexOf(slot.id) >= 0; });
        if (!rows.length) return;
        html += '<div class="extra-head">' + slot.emoji + ' ' + slot.label + '</div><div class="tasklist">' +
          rows.map(function (md) {
            var key = md.id + '@' + slot.id;
            var on = !!taken[key];
            return '<div class="task med' + (on ? ' done' : '') + '" data-med="' + key + '">' +
              '<div class="check">✓</div><div class="t-emoji">💊</div>' +
              '<div class="t-body"><div class="t-title">' + esc(md.name) + '</div>' +
              (md.dose ? '<div class="t-sub">' + esc(md.dose) + '</div>' : '') + '</div></div>';
          }).join('') + '</div>';
      });
    } else {
      html += '<div class="card"><p class="muted tiny" style="margin:0">No meds yet — add your medicines or supplements below, pick when to take them, and tick them off each day.</p></div>';
    }

    // Adherence calendar (doubles as the date picker)
    if (list.length) {
      html += '<div class="card"><h3>Adherence</h3><p class="muted tiny" style="margin:0 0 8px">Tap a day to view or edit it.</p><div id="meds-cal"></div>' +
        '<div class="gt-legend" style="margin-top:10px">' +
          '<span class="gt-key"><i style="background:var(--green)"></i>All taken</span>' +
          '<span class="gt-key"><i style="background:var(--amber)"></i>Partial</span>' +
        '</div></div>';
    }

    // Manage meds
    html += '<div class="card"><div class="eyebrow" style="margin-bottom:6px">My meds</div><div id="meds-manage">' +
      list.map(function (md) {
        var slots = (md.times || []).map(function (t) {
          var s = MED_SLOTS.filter(function (x) { return x.id === t; })[0];
          return s ? s.emoji : '';
        }).join(' ');
        return '<div class="list-row"><div><b>' + esc(md.name) + '</b>' +
          '<div class="muted tiny">' + (md.dose ? esc(md.dose) + ' · ' : '') + slots + '</div></div>' +
          '<button class="list-del" data-medrm="' + md.id + '">✕</button></div>';
      }).join('') + '</div>' +
      '<div class="manual-grid" style="margin-top:10px">' +
        '<label>Name<input id="med-name" placeholder="e.g. Vitamin D3" maxlength="40" /></label>' +
        '<label>Dose <span class="muted tiny">(optional)</span><input id="med-dose" placeholder="e.g. 1 tab · after food" maxlength="40" /></label>' +
      '</div>' +
      '<div class="med-slot-picker" id="med-slots">' + MED_SLOTS.map(function (s) {
        return '<button type="button" class="med-slot' + (s.id === 'morning' ? ' on' : '') + '" data-slot="' + s.id + '">' + s.emoji + ' ' + s.label + '</button>';
      }).join('') + '</div>' +
      '<button id="med-add" class="btn primary block">Add med</button></div>';

    box.innerHTML = html;
    bindDayBar(box, renderMeds);

    // Tick off a dose
    box.querySelectorAll('[data-med]').forEach(function (row) {
      row.addEventListener('click', function () {
        var key = row.getAttribute('data-med');
        taken[key] = !taken[key];
        queueSaveDay(day);
        if (taken[key] && medTakenCount(day, list) >= total && total > 1) toast('All doses done today 💊✨');
        renderMeds();
      });
    });
    // Adherence calendar
    var cal = $('#meds-cal');
    if (cal) buildDayPicker(cal, ymOf(appDate()), renderMeds, medDayColor);
    // Manage: slot chips toggle
    box.querySelectorAll('[data-slot]').forEach(function (b) {
      b.addEventListener('click', function () { b.classList.toggle('on'); });
    });
    $('#med-add').addEventListener('click', function () {
      var name = $('#med-name').value.trim();
      if (!name) { toast('Give the med a name'); return; }
      var times = [];
      box.querySelectorAll('[data-slot].on').forEach(function (b) { times.push(b.getAttribute('data-slot')); });
      if (!times.length) { toast('Pick at least one time of day'); return; }
      var next = medsList().slice();
      next.push({ id: 'md_' + Date.now().toString(36), name: name.slice(0, 40), dose: $('#med-dose').value.trim().slice(0, 40), times: times });
      saveProfileKey('meds', next, renderMeds);
    });
    box.querySelectorAll('[data-medrm]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Remove this med? Past taken-history stays in your logs.')) return;
        saveProfileKey('meds', medsList().filter(function (md) { return md.id !== b.getAttribute('data-medrm'); }), renderMeds);
      });
    });
  }

  /* ----- Money / Subs / Savings / Tasks / Goals (generic list apps) ----- */
  function rupee(v) { return '₹' + (Math.round(Number(v) || 0)).toLocaleString('en-IN'); }
  function saveProfileKey(key, val, cb) {
    var p = Object.assign({}, state.profile); p[key] = val; state.profile = p;
    api('saveGoals', { profile: p }).then(function (d) { if (d && d.profile) state.profile = d.profile; toast('Saved ✓'); if (cb) cb(); }).catch(function (e) { toast(e.message); });
  }
  function truthy(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true'; }

  /* ================= Money Manager (full) ================= */
  var GUARD_LABEL = { ok: 'On track', warn: 'Slow down', critical: 'Critical', stop: 'Over budget', none: 'No budget set' };
  var GUARD_CLASS = { ok: 'g-ok', warn: 'g-warn', critical: 'g-critical', stop: 'g-stop', none: 'g-none' };
  function moneyCatById(id) { return (state.money.categories || []).filter(function (c) { return c.id === id; })[0]; }
  function moneyAcctById(id) { return (state.money.accounts || []).filter(function (a) { return a.id === id; })[0]; }
  function moneyCatOptions(selectedId) {
    var groups = {};
    (state.money.categories || []).forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
    return Object.keys(groups).sort().map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }
  function moneyAcctOptions(selectedId) {
    var accts = state.money.accounts || [];
    if (!accts.length) return '<option value="">No accounts yet</option>';
    return '<option value="">—</option>' + accts.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === selectedId ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('');
  }

  function moneyCacheKey() { return 'hard_money_' + (state.username || ''); }
  function moneyBlank() { return { accounts: [], categories: [], budget: {}, status: {}, dashboard: null, loaded: false, tab: 'overview' }; }
  // moneyGetState now returns accounts+categories+budget+status+dashboard in ONE round-trip
  // (previously Overview made a second 'moneyDashboard' call after this — two slow Apps
  // Script calls in sequence). Cache the result so reopening Money is instant.
  function moneyInit() {
    if (!state.money) state.money = moneyBlank();
    return api('moneyGetState', {}).then(function (d) {
      state.money.accounts = d.accounts || []; state.money.categories = d.categories || [];
      state.money.budget = d.budget || {}; state.money.status = d.status || {};
      state.money.dashboard = d.dashboard || null; state.money.loaded = true;
      try { localStorage.setItem(moneyCacheKey(), JSON.stringify({ accounts: state.money.accounts, categories: state.money.categories, budget: state.money.budget, status: state.money.status, dashboard: state.money.dashboard })); } catch (e) {}
    });
  }
  function renderMoney() {
    if (!state.money) state.money = moneyBlank();
    if (!renderMoney.bound) {
      renderMoney.bound = true;
      document.querySelectorAll('#money-tabs [data-mtab]').forEach(function (b) {
        b.addEventListener('click', function () {
          document.querySelectorAll('#money-tabs [data-mtab]').forEach(function (x) { x.classList.toggle('active', x === b); });
          var t = b.getAttribute('data-mtab'); state.money.tab = t;
          document.querySelectorAll('.money-pane').forEach(function (p) { p.classList.add('hidden'); });
          $('#money-pane-' + t).classList.remove('hidden');
          moneyRenderTab(t);
        });
      });
      $('#money-ask-penny').addEventListener('click', function () { openCoach('money'); });
    }
    if (!state.money.loaded) {
      // Show last-known data instantly (if any), then refresh in the background.
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(moneyCacheKey()) || 'null'); } catch (e) {}
      if (cached) {
        state.money.accounts = cached.accounts || []; state.money.categories = cached.categories || [];
        state.money.budget = cached.budget || {}; state.money.status = cached.status || {}; state.money.dashboard = cached.dashboard || null;
        moneyRenderTab(state.money.tab || 'overview');
      } else {
        $('#money-overview').innerHTML = '<p class="muted tiny">Loading…</p>';
      }
      moneyInit().then(function () { moneyRenderTab(state.money.tab || 'overview'); });
    } else {
      moneyRenderTab(state.money.tab || 'overview');
    }
  }
  function moneyRenderTab(t) {
    if (t === 'overview') moneyRenderOverview();
    else if (t === 'add') moneyRenderAdd();
    else if (t === 'history') moneyRenderHistory();
    else if (t === 'accounts') moneyRenderAccounts();
    else if (t === 'categories') moneyRenderCategories();
    else if (t === 'budget') moneyRenderBudget();
  }

  // Renders synchronously from state.money.dashboard (already fetched by moneyGetState /
  // cached) — no separate network call, so switching to Overview is instant.
  function moneyRenderOverview() {
    var box = $('#money-overview'); if (!box) return;
    var d = state.money.dashboard;
    if (!d) { box.innerHTML = '<p class="muted tiny">Loading…</p>'; return; }
    var s = state.money.status || d.status || {};
    var level = s.level || 'none';
    var groups = { need: 0, want: 0, saving: 0 };
    if (d.byKind) { groups.need = d.byKind.need; groups.want = d.byKind.want; groups.saving = d.byKind.saving; }
    var totalKind = (groups.need + groups.want + groups.saving) || 1;
    box.innerHTML =
      '<div class="card guard-card ' + GUARD_CLASS[level] + '">' +
        '<div class="guard-top"><span class="eyebrow">This month</span><span class="guard-chip">' + esc(GUARD_LABEL[level]) + '</span></div>' +
        '<div class="metric-big"><b>' + rupee(s.spent) + '</b> <span class="muted">' + (s.limit ? ('/ ' + rupee(s.limit)) : 'spent · no budget set') + '</span></div>' +
        (s.limit ? '<div class="fc-bar' + (s.pct >= 1 ? ' over' : '') + '" style="margin:10px 0"><span style="width:' + Math.min(100, Math.round(s.pct * 100)) + '%"></span></div>' +
          '<div class="guard-grid">' +
            '<div><span class="muted tiny">Remaining</span><b>' + rupee(s.remaining) + '</b></div>' +
            '<div><span class="muted tiny">Safe / day</span><b>' + rupee(s.safePerDay) + '</b></div>' +
            '<div><span class="muted tiny">Days left</span><b>' + s.daysLeft + '</b></div>' +
            '<div><span class="muted tiny">Projected</span><b>' + rupee(s.projection) + '</b></div>' +
          '</div>' : '<p class="muted tiny" style="margin-top:8px">Set a monthly budget in the <b>Budget</b> tab to see your guard-rail.</p>') +
      '</div>' +
      (s.limit ? '<div class="card"><div class="eyebrow">Daily discipline · last 7 days</div><div id="money-discipline" class="disc-row"><span class="muted tiny">Loading…</span></div>' +
        '<p class="muted tiny" style="margin-top:8px">Green = you stayed under ' + rupee(s.limit / (s.daysInMonth || 30)) + '/day. Every green day lifts your Money score.</p></div>' : '') +
      '<div class="card"><div class="eyebrow">Needs / Wants / Savings</div>' +
        '<div class="nws-bar"><span class="nws-need" style="width:' + Math.round(groups.need / totalKind * 100) + '%"></span>' +
        '<span class="nws-want" style="width:' + Math.round(groups.want / totalKind * 100) + '%"></span>' +
        '<span class="nws-save" style="width:' + Math.round(groups.saving / totalKind * 100) + '%"></span></div>' +
        '<div class="nws-legend"><span><i class="nws-dot nws-need"></i>Needs ' + rupee(groups.need) + '</span><span><i class="nws-dot nws-want"></i>Wants ' + rupee(groups.want) + '</span><span><i class="nws-dot nws-save"></i>Savings ' + rupee(groups.saving) + '</span></div>' +
        '<p class="muted tiny" style="margin-top:8px">Target roughly 50 / 30 / 20.</p></div>' +
      '<div class="card"><div class="eyebrow">Top categories</div>' + (
        (d.byCategory || []).length ? d.byCategory.slice(0, 6).map(function (c) {
          var pct = d.totalSpend ? Math.round(c.total / d.totalSpend * 100) : 0;
          return '<div class="bar-row"><div class="bl"><span>' + c.icon + ' ' + esc(c.name) + '</span><span>' + rupee(c.total) + '</span></div><div class="bar"><span style="width:' + pct + '%;background:' + c.color + '"></span></div></div>';
        }).join('') : '<p class="muted tiny">No spending logged yet this month.</p>'
      ) + '</div>' +
      '<div class="card"><div class="eyebrow">Top merchants</div>' + (
        (d.topMerchants || []).length ? d.topMerchants.map(function (m) {
          return '<div class="list-row"><span>' + esc(m.merchant) + '</span><b>' + rupee(m.total) + '</b></div>';
        }).join('') : '<p class="muted tiny">—</p>'
      ) + '</div>';
    if (s.limit) moneyRenderDiscipline();
  }
  // Last-7-days under/over daily-budget dots on the Money overview.
  function moneyRenderDiscipline() {
    var slot = $('#money-discipline'); if (!slot) return;
    var ym = ymOf(todayStr());
    var c = ensureMoneyMonth(ym, moneyRenderDiscipline);
    if (!c) return; // still loading — callback re-renders
    if (!c.limit) { slot.innerHTML = '<span class="muted tiny">Set a budget to track this.</span>'; return; }
    var dailyLimit = c.limit / daysInYm(ym);
    var today = todayStr(), out = '';
    for (var i = 6; i >= 0; i--) {
      var dte = addDays(today, -i);
      var inMonth = ymOf(dte) === ym;
      var spend = inMonth ? (c.perDay[dte] || 0) : 0;
      var win = spend <= dailyLimit;
      out += '<div class="disc-day' + (!inMonth ? ' na' : win ? ' win' : ' over') + '">' +
        '<span class="disc-dot">' + (!inMonth ? '·' : win ? '✓' : '✗') + '</span>' +
        '<span class="disc-lbl">' + parse(dte).toLocaleDateString(undefined, { weekday: 'narrow' }) + '</span>' +
        '<span class="disc-amt">' + (inMonth ? '₹' + Math.round(spend) : '') + '</span></div>';
    }
    slot.innerHTML = out;
  }
  // Fire-and-forget refresh after a mutation (add/delete txn, save budget) so
  // the Overview breakdown catches up without blocking the UI on a network call.
  function moneyRefreshSilently() {
    delete moneyMonthCache[ymOf(todayStr())]; // txns changed — recompute daily wins & Life Score
    moneyInit().then(function () { if (state.money.tab === 'overview') moneyRenderOverview(); }).catch(function () {});
  }

  function moneyRenderAdd() {
    var box = $('#money-add'); if (!box) return;
    var today = todayStr();
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add manually</div>' +
        '<div class="manual-grid">' +
          '<label>Amount (₹)<input id="mo-amt" type="number" inputmode="decimal" /></label>' +
          '<label>Type<select id="mo-type"><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select></label>' +
          '<label>Category<select id="mo-cat">' + moneyCatOptions() + '</select></label>' +
          '<label>Account<select id="mo-acct">' + moneyAcctOptions() + '</select></label>' +
          '<label>Date<input id="mo-date" type="date" value="' + today + '" max="' + today + '" /></label>' +
          '<label>Merchant<input id="mo-merch" placeholder="e.g. Swiggy" /></label>' +
        '</div><label>Note<input id="mo-note" placeholder="optional" /></label>' +
        '<button id="mo-add-btn" class="btn primary block">Add transaction</button></div>' +
      '<div class="card"><div class="eyebrow">📷 Scan a screenshot</div>' +
        '<p class="muted tiny">Banking app, UPI (GPay/PhonePe/Paytm), card statement, or order history.</p>' +
        '<div class="scan-row"><button id="mo-scan-btn" class="btn" type="button">🖼️ Upload image</button></div>' +
        '<input type="file" id="mo-scan-file" accept="image/*" class="hidden" />' +
        '<div id="mo-scan-status" class="muted tiny scan-status"></div></div>' +
      '<div class="card"><div class="eyebrow">📋 Paste a bank / UPI message</div>' +
        '<textarea id="mo-sms" rows="3" placeholder="Paste the SMS or notification text…"></textarea>' +
        '<button id="mo-sms-btn" class="btn block" style="margin-top:8px">Parse message</button></div>' +
      '<div id="mo-review"></div>';
    $('#mo-add-btn').addEventListener('click', function () {
      var amt = Number($('#mo-amt').value) || 0;
      if (amt <= 0) { toast('Enter an amount'); return; }
      var t = { date: $('#mo-date').value || today, amount: amt, type: $('#mo-type').value, categoryId: $('#mo-cat').value, accountId: $('#mo-acct').value, merchant: $('#mo-merch').value.trim(), note: $('#mo-note').value.trim(), source: 'manual' };
      api('moneyAddTxn', { transaction: t }).then(function (d) {
        state.money.status = d.status || state.money.status;
        toast('Added ✓'); $('#mo-amt').value = ''; $('#mo-merch').value = ''; $('#mo-note').value = '';
        moneyRefreshSilently();
      }).catch(function (e) { toast(e.message); });
    });
    $('#mo-scan-btn').addEventListener('click', function () { $('#mo-scan-file').click(); });
    $('#mo-scan-file').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = ''; if (!f) return;
      $('#mo-scan-status').textContent = 'Reading screenshot…';
      compressImage(f).then(function (b64) { return api('moneyParseScreenshot', { image: b64, mime: 'image/jpeg' }); })
        .then(function (d) {
          $('#mo-scan-status').textContent = (d.transactions || []).length ? '' : 'No transactions found in that image.';
          moneyRenderReview(d.transactions || []);
        }).catch(function (e) { $('#mo-scan-status').textContent = e.message || 'Scan failed.'; });
    });
    $('#mo-sms-btn').addEventListener('click', function () {
      var text = $('#mo-sms').value.trim(); if (!text) { toast('Paste a message first'); return; }
      var btn = $('#mo-sms-btn'); btn.disabled = true; btn.textContent = 'Parsing…';
      api('moneyParseMessage', { text: text }).then(function (d) {
        moneyRenderReview(d.transactions || []);
        if ((d.transactions || []).length) $('#mo-sms').value = '';
      }).catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; btn.textContent = 'Parse message'; });
    });
  }
  function moneyRenderReview(list) {
    var box = $('#mo-review'); if (!box) return;
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card"><div class="eyebrow">Review · ' + list.length + ' found</div>' +
      list.map(function (t, i) {
        var cat = moneyCatById(t.categoryId);
        var acctNote = t.accountId ? '<span class="muted tiny">✓ matched from label</span>' : (!state.money.accounts || !state.money.accounts.length ? '<span class="muted tiny">Add a bank/card in the Accounts tab to tag transactions</span>' : '');
        return '<div class="review-row" data-i="' + i + '">' +
          '<div class="manual-grid">' +
            '<label>Amount<input class="rv-amt" type="number" value="' + t.amount + '" /></label>' +
            '<label>Category<select class="rv-cat">' + moneyCatOptions(t.categoryId) + '</select></label>' +
            '<label>Date<input class="rv-date" type="date" value="' + t.date + '" /></label>' +
            '<label>Type<select class="rv-type"><option value="expense"' + (t.type === 'expense' ? ' selected' : '') + '>Expense</option><option value="income"' + (t.type === 'income' ? ' selected' : '') + '>Income</option><option value="transfer"' + (t.type === 'transfer' ? ' selected' : '') + '>Transfer</option></select></label>' +
            '<label>Account<select class="rv-acct">' + moneyAcctOptions(t.accountId) + '</select></label>' +
          '</div>' + acctNote +
          '<label>Merchant<input class="rv-merch" value="' + esc(t.merchant || '') + '" /></label>' +
          '<button class="list-del" data-rv-remove="' + i + '">✕ Skip this one</button></div>';
      }).join('') +
      '<button id="mo-review-save" class="btn primary block">Add all to Money</button></div>';
    box.querySelectorAll('[data-rv-remove]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('.review-row').remove(); });
    });
    $('#mo-review-save').addEventListener('click', function () {
      var rows = box.querySelectorAll('.review-row');
      var txns = [];
      rows.forEach(function (r) {
        txns.push({
          amount: Number(r.querySelector('.rv-amt').value) || 0, categoryId: r.querySelector('.rv-cat').value,
          date: r.querySelector('.rv-date').value, type: r.querySelector('.rv-type').value,
          accountId: r.querySelector('.rv-acct').value,
          merchant: r.querySelector('.rv-merch').value.trim(), source: 'screenshot', clientId: 'rv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
        });
      });
      txns = txns.filter(function (t) { return t.amount > 0; });
      if (!txns.length) { toast('Nothing to add'); return; }
      api('moneyAddTxns', { transactions: txns }).then(function (d) {
        state.money.status = d.status || state.money.status;
        toast('Added ' + d.added + ' transaction' + (d.added === 1 ? '' : 's') + ' ✓');
        box.innerHTML = '';
        moneyRefreshSilently();
      }).catch(function (e) { toast(e.message); });
    });
  }

  function moneyRenderHistory() {
    var box = $('#money-history'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('moneyGetTxns', { limit: 100 }).then(function (d) {
      state.money.editingTxnId = null;
      moneyRenderHistoryList(d.transactions || []);
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }
  function moneyRenderHistoryList(items) {
    var box = $('#money-history'); if (!box) return;
    if (!items.length) { box.innerHTML = '<p class="muted tiny">No transactions yet — add one in the Add tab.</p>'; return; }
    var editingId = state.money.editingTxnId;
    var today = todayStr();
    box.innerHTML = items.map(function (t) {
      if (t.id === editingId) {
        return '<div class="txn-edit-card" data-editcard="' + t.id + '">' +
          '<div class="manual-grid">' +
            '<label>Amount (₹)<input class="te-amt" type="number" inputmode="decimal" value="' + t.amount + '" /></label>' +
            '<label>Type<select class="te-type">' +
              '<option value="expense"' + (t.type === 'expense' ? ' selected' : '') + '>Expense</option>' +
              '<option value="income"' + (t.type === 'income' ? ' selected' : '') + '>Income</option>' +
              '<option value="transfer"' + (t.type === 'transfer' ? ' selected' : '') + '>Transfer</option>' +
            '</select></label>' +
            '<label>Category<select class="te-cat">' + moneyCatOptions(t.categoryId) + '</select></label>' +
            '<label>Account<select class="te-acct">' + moneyAcctOptions(t.accountId) + '</select></label>' +
            '<label>Date<input class="te-date" type="date" value="' + esc(t.date) + '" max="' + today + '" /></label>' +
            '<label>Merchant<input class="te-merch" value="' + esc(t.merchant || '') + '" /></label>' +
          '</div><label>Note<input class="te-note" value="' + esc(t.note || '') + '" /></label>' +
          '<div class="fr-acts" style="margin-top:10px">' +
            '<button class="btn primary" data-save="' + t.id + '">Save</button>' +
            '<button class="btn" data-cancel="1">Cancel</button>' +
          '</div></div>';
      }
      var cat = moneyCatById(t.categoryId);
      var acct = moneyAcctById(t.accountId);
      var sign = t.type === 'income' ? '+' : (t.type === 'transfer' ? '' : '−');
      var cls = t.type === 'income' ? 'amt-income' : (t.type === 'transfer' ? 'amt-transfer' : 'amt-expense');
      return '<div class="list-row txn-row" data-edit="' + t.id + '">' +
        '<div><b>' + (cat ? cat.icon + ' ' : '') + esc(t.merchant || (cat ? cat.name : 'Uncategorised')) + '</b>' +
        '<div class="muted tiny">' + esc(t.date) + (acct ? ' · ' + esc(acct.name) : '') + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
        '<span class="fr-acts"><b class="' + cls + '">' + sign + rupee(t.amount) + '</b><button class="list-del" data-del="' + t.id + '">✕</button></span></div>';
    }).join('');
    box.querySelectorAll('[data-edit]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-del]')) return;
        state.money.editingTxnId = row.getAttribute('data-edit');
        moneyRenderHistoryList(items);
      });
    });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api('moneyDeleteTxn', { id: b.getAttribute('data-del') }).then(function (d) {
          state.money.status = d.status || state.money.status; moneyRenderHistory(); moneyRefreshSilently();
        });
      });
    });
    box.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', function () { state.money.editingTxnId = null; moneyRenderHistoryList(items); });
    });
    box.querySelectorAll('[data-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-save');
        var card = b.closest('.txn-edit-card');
        var amt = Number(card.querySelector('.te-amt').value) || 0;
        if (amt <= 0) { toast('Enter a valid amount'); return; }
        var payload = {
          transaction: {
            id: id, amount: amt, type: card.querySelector('.te-type').value,
            categoryId: card.querySelector('.te-cat').value, accountId: card.querySelector('.te-acct').value,
            date: card.querySelector('.te-date').value, merchant: card.querySelector('.te-merch').value.trim(),
            note: card.querySelector('.te-note').value.trim()
          }
        };
        b.disabled = true; b.textContent = 'Saving…';
        api('moneyUpdateTxn', payload).then(function (d) {
          state.money.status = d.status || state.money.status;
          state.money.editingTxnId = null;
          toast('Updated ✓');
          moneyRenderHistory();
          moneyRefreshSilently();
        }).catch(function (e) { toast(e.message); b.disabled = false; b.textContent = 'Save'; });
      });
    });
  }

  function moneyRenderAccounts() {
    var box = $('#money-accounts'); if (!box) return;
    var accts = state.money.accounts || [];
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add account / card</div>' +
        '<div class="manual-grid">' +
          '<label>Name<input id="ac-name" placeholder="e.g. HDFC Bank" /></label>' +
          '<label>Type<select id="ac-type"><option value="bank">Bank</option><option value="credit_card">Credit card</option><option value="cash">Cash</option><option value="wallet">Wallet</option></select></label>' +
          '<label>Issuer<input id="ac-issuer" placeholder="optional" /></label>' +
          '<label>Last 4 digits<input id="ac-last4" inputmode="numeric" maxlength="4" /></label>' +
        '</div><button id="ac-add-btn" class="btn primary block">Add account</button></div>' +
      (accts.length ? accts.map(function (a) {
        return '<div class="card"><div class="list-row"><div><b>' + esc(a.name) + '</b><div class="muted tiny">' + esc(a.type.replace('_', ' ')) + (a.last4 ? ' · •••• ' + esc(a.last4) : '') + '</div></div><button class="list-del" data-ac-del="' + a.id + '">✕</button></div></div>';
      }).join('') : '<p class="muted tiny">No accounts yet.</p>');
    $('#ac-add-btn').addEventListener('click', function () {
      var name = $('#ac-name').value.trim(); if (!name) { toast('Enter a name'); return; }
      api('moneyAddAccount', { account: { name: name, type: $('#ac-type').value, issuer: $('#ac-issuer').value.trim(), last4: $('#ac-last4').value.trim() } })
        .then(function (d) { state.money.accounts.push(d.account); toast('Added ✓'); moneyRenderAccounts(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-ac-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ac-del');
        api('moneyDeleteAccount', { id: id }).then(function () { state.money.accounts = state.money.accounts.filter(function (a) { return a.id !== id; }); moneyRenderAccounts(); });
      });
    });
  }

  function moneyRenderCategories() {
    var box = $('#money-categories'); if (!box) return;
    var cats = state.money.categories || [];
    var groups = {}; cats.forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add custom category</div>' +
        '<div class="manual-grid">' +
          '<label>Name<input id="ct-name" placeholder="e.g. Side project" /></label>' +
          '<label>Group<input id="ct-group" placeholder="e.g. Other" /></label>' +
          '<label>Kind<select id="ct-kind"><option value="need">Need</option><option value="want" selected>Want</option><option value="saving">Saving</option></select></label>' +
          '<label>Icon (emoji)<input id="ct-icon" placeholder="📦" maxlength="4" /></label>' +
        '</div><button id="ct-add-btn" class="btn primary block">Add category</button></div>' +
      Object.keys(groups).sort().map(function (g) {
        return '<div class="card"><div class="eyebrow">' + esc(g) + '</div>' + groups[g].map(function (c) {
          return '<div class="list-row"><span>' + c.icon + ' ' + esc(c.name) + ' <span class="cat-kind">' + c.kind + '</span></span><button class="list-del" data-ct-del="' + c.id + '">✕</button></div>';
        }).join('') + '</div>';
      }).join('');
    $('#ct-add-btn').addEventListener('click', function () {
      var name = $('#ct-name').value.trim(); if (!name) { toast('Enter a name'); return; }
      api('moneyAddCategory', { category: { name: name, group: $('#ct-group').value.trim() || 'Other', kind: $('#ct-kind').value, icon: $('#ct-icon').value.trim() || '📦' } })
        .then(function (d) { state.money.categories.push(d.category); toast('Added ✓'); moneyRenderCategories(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-ct-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ct-del');
        api('moneyDeleteCategory', { id: id }).then(function () { state.money.categories = state.money.categories.filter(function (c) { return c.id !== id; }); moneyRenderCategories(); });
      });
    });
  }

  function moneyRenderBudget() {
    var box = $('#money-budget'); if (!box) return;
    var b = state.money.budget || {};
    var caps = b.perCategory || {};
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Monthly budget</div>' +
        '<label>Overall limit (₹)<input id="bg-limit" type="number" inputmode="numeric" value="' + (b.limit || '') + '" /></label>' +
        '<div class="manual-grid"><label>Monthly income (₹)<input id="bg-income" type="number" inputmode="numeric" value="' + (b.monthlyIncome || '') + '" /></label>' +
        '<label>Savings goal (₹/mo)<input id="bg-savings" type="number" inputmode="numeric" value="' + (b.savingsGoal || '') + '" /></label></div>' +
        '<button id="bg-save-btn" class="btn primary block">Save budget</button></div>' +
      '<div class="card"><div class="eyebrow">Per-category caps</div>' +
        '<div class="manual-grid"><label>Category<select id="bg-cat">' + moneyCatOptions() + '</select></label>' +
        '<label>Cap (₹/mo)<input id="bg-cap-amt" type="number" inputmode="numeric" /></label></div>' +
        '<button id="bg-cap-add" class="btn block">Set cap</button>' +
        '<div id="bg-cap-list" style="margin-top:8px">' + Object.keys(caps).map(function (cid) {
          var c = moneyCatById(cid); if (!c) return '';
          return '<div class="list-row"><span>' + c.icon + ' ' + esc(c.name) + '</span><span>' + rupee(caps[cid]) + ' <button class="list-del" data-cap-del="' + cid + '">✕</button></span></div>';
        }).join('') + '</div></div>';
    $('#bg-save-btn').addEventListener('click', function () {
      var payload = { overall: Number($('#bg-limit').value) || 0, perCategory: caps, monthlyIncome: Number($('#bg-income').value) || 0, savingsGoal: Number($('#bg-savings').value) || 0 };
      api('moneySaveBudget', payload).then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Saved ✓'); moneyRenderBudget(); moneyRefreshSilently(); }).catch(function (e) { toast(e.message); });
    });
    $('#bg-cap-add').addEventListener('click', function () {
      var cid = $('#bg-cat').value, amt = Number($('#bg-cap-amt').value) || 0;
      if (!cid || amt <= 0) { toast('Pick a category and amount'); return; }
      caps[cid] = amt;
      api('moneySaveBudget', { overall: Number(b.limit) || 0, perCategory: caps, monthlyIncome: b.monthlyIncome || 0, savingsGoal: b.savingsGoal || 0 })
        .then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Cap set ✓'); moneyRenderBudget(); moneyRefreshSilently(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-cap-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cid = btn.getAttribute('data-cap-del'); delete caps[cid];
        api('moneySaveBudget', { overall: Number(b.limit) || 0, perCategory: caps, monthlyIncome: b.monthlyIncome || 0, savingsGoal: b.savingsGoal || 0 })
          .then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Removed'); moneyRenderBudget(); moneyRefreshSilently(); });
      });
    });
  }

  function renderSubs() {
    var box = $('#subs-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'sub' }).then(function (dd) {
      var items = (dd.items || []);
      function monthly(x) { var a = Number(x.amount) || 0; return String(x.cycle) === 'yearly' ? a / 12 : a; }
      var active = items.filter(function (x) { return truthy(x.active); });
      var burn = active.reduce(function (s, x) { return s + monthly(x); }, 0);
      box.innerHTML =
        '<div class="card"><div class="eyebrow">Monthly burn</div><div class="metric-big"><b>' + rupee(burn) + '</b> <span class="muted">/mo</span></div><div class="muted tiny">' + rupee(burn * 12) + ' / year · ' + active.length + ' active</div></div>' +
        '<div class="card"><div class="eyebrow">Add subscription</div>' +
          '<label>Name<input id="sb-name" placeholder="e.g. Spotify" /></label>' +
          '<div class="manual-grid"><label>Amount (₹)<input id="sb-amt" type="number" inputmode="numeric" /></label>' +
          '<label>Cycle<select id="sb-cycle"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label></div>' +
          '<button id="sb-add" class="btn primary block">Add</button></div>' +
        '<div class="card"><div class="eyebrow">Your subscriptions · ' + items.length + '</div><div id="sb-list">' +
          (items.length ? items.map(function (x) { var on = truthy(x.active); return '<div class="list-row' + (on ? '' : ' off') + '"><div><b>' + esc(x.name) + '</b> <span class="muted tiny">' + rupee(x.amount) + '/' + (String(x.cycle) === 'yearly' ? 'yr' : 'mo') + '</span></div><span class="fr-acts"><button class="btn fr-mini" data-toggle="' + x.id + '">' + (on ? 'Pause' : 'Resume') + '</button><button class="list-del" data-del="' + x.id + '">✕</button></span></div>'; }).join('') : '<p class="muted tiny">No subscriptions yet.</p>') +
          '</div></div>';
      $('#sb-add').addEventListener('click', function () {
        var name = $('#sb-name').value.trim(), amt = Number($('#sb-amt').value) || 0;
        if (!name || amt <= 0) { toast('Enter name & amount'); return; }
        api('listAdd', { kind: 'sub', item: { name: name, amount: amt, cycle: $('#sb-cycle').value, renewDay: '', active: true } }).then(function () { toast('Added ✓'); renderSubs(); }).catch(function (e) { toast(e.message); });
      });
      $('#sb-list').addEventListener('click', function (e) {
        var del = e.target.closest('[data-del]'), tg = e.target.closest('[data-toggle]');
        if (del) api('listDelete', { kind: 'sub', id: del.getAttribute('data-del') }).then(renderSubs);
        else if (tg) { var id = tg.getAttribute('data-toggle'); var it = items.filter(function (x) { return x.id === id; })[0]; api('listUpdate', { kind: 'sub', id: id, item: { active: !truthy(it.active) } }).then(renderSubs); }
      });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function renderSavings() {
    var box = $('#savings-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'saving' }).then(function (dd) {
      var items = (dd.items || []);
      var total = items.reduce(function (s, x) { return s + (Number(x.saved) || 0); }, 0);
      box.innerHTML =
        '<div class="card"><div class="eyebrow">Total saved</div><div class="metric-big"><b>' + rupee(total) + '</b></div></div>' +
        '<div class="card"><div class="eyebrow">New goal</div>' +
          '<label>Name<input id="sv-name" placeholder="e.g. Emergency fund" /></label>' +
          '<label>Target (₹)<input id="sv-target" type="number" inputmode="numeric" /></label>' +
          '<button id="sv-add" class="btn primary block">Create goal</button></div>' +
        items.map(function (x) { var saved = Number(x.saved) || 0, target = Number(x.target) || 0, pct = target ? Math.min(100, Math.round(saved / target * 100)) : 0; return '<div class="card"><div class="list-row"><b>' + esc(x.name) + '</b><button class="list-del" data-del="' + x.id + '">✕</button></div><div class="muted tiny">' + rupee(saved) + ' / ' + rupee(target) + ' · ' + pct + '%</div><div class="fc-bar" style="margin:8px 0"><span style="width:' + pct + '%"></span></div><button class="btn block" data-add-amt="' + x.id + '">+ Add money</button></div>'; }).join('');
      $('#sv-add').addEventListener('click', function () {
        var name = $('#sv-name').value.trim(), target = Number($('#sv-target').value) || 0;
        if (!name) { toast('Enter a name'); return; }
        api('listAdd', { kind: 'saving', item: { name: name, target: target, saved: 0 } }).then(function () { toast('Created ✓'); renderSavings(); }).catch(function (e) { toast(e.message); });
      });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'saving', id: b.getAttribute('data-del') }).then(renderSavings); }); });
      box.querySelectorAll('[data-add-amt]').forEach(function (b) { b.addEventListener('click', function () { var id = b.getAttribute('data-add-amt'); var it = items.filter(function (x) { return x.id === id; })[0]; var x = prompt('Add how much to ' + it.name + '? (₹)'); if (x == null) return; var add = Number(x) || 0; if (add <= 0) return; api('listUpdate', { kind: 'saving', id: id, item: { saved: (Number(it.saved) || 0) + add } }).then(function () { toast('Added ✓'); renderSavings(); }); }); });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function renderTasks() {
    var box = $('#tasks-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'task' }).then(function (dd) {
      var items = (dd.items || []), today = todayStr();
      var open = items.filter(function (x) { return !truthy(x.done); }).sort(function (a, b) { return String(a.due || '9999') < String(b.due || '9999') ? -1 : 1; });
      var done = items.filter(function (x) { return truthy(x.done); });
      function row(x) { var over = x.due && String(x.due) < today && !truthy(x.done); return '<div class="list-row"><label class="tk-check"><input type="checkbox" data-done="' + x.id + '"' + (truthy(x.done) ? ' checked' : '') + ' /> <span class="' + (truthy(x.done) ? 'tk-done' : '') + '">' + esc(x.title) + '</span></label><span class="fr-acts">' + (x.due ? '<span class="muted tiny' + (over ? ' tk-over' : '') + '">' + esc(String(x.due)) + '</span>' : '') + '<button class="list-del" data-del="' + x.id + '">✕</button></span></div>'; }
      box.innerHTML =
        '<div class="card"><div class="eyebrow">Add task</div>' +
          '<label>Task<input id="tk-title" placeholder="e.g. Submit tax documents" /></label>' +
          '<div class="manual-grid"><label>Due<input id="tk-due" type="date" /></label>' +
          '<label>Priority<select id="tk-pri"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label></div>' +
          '<button id="tk-add" class="btn primary block">Add task</button></div>' +
        '<div class="card"><div class="eyebrow">Open · ' + open.length + '</div>' + (open.length ? open.map(row).join('') : '<p class="muted tiny">Nothing open 🎉</p>') + '</div>' +
        (done.length ? '<div class="card"><div class="eyebrow">Done · ' + done.length + '</div>' + done.map(row).join('') + '</div>' : '');
      $('#tk-add').addEventListener('click', function () { var t = $('#tk-title').value.trim(); if (!t) { toast('Enter a task'); return; } api('listAdd', { kind: 'task', item: { title: t, due: $('#tk-due').value, priority: $('#tk-pri').value, done: false } }).then(function () { toast('Added ✓'); renderTasks(); }).catch(function (e) { toast(e.message); }); });
      box.querySelectorAll('[data-done]').forEach(function (c) { c.addEventListener('change', function () { api('listUpdate', { kind: 'task', id: c.getAttribute('data-done'), item: { done: c.checked } }).then(renderTasks); }); });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'task', id: b.getAttribute('data-del') }).then(renderTasks); }); });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  // Per-goal progress % lives in the profile blob (no backend schema change).
  function goalProgress() { return (state.profile && state.profile.goalProgress) || {}; }
  var GOAL_STATUS = {
    'on-track': { label: 'On track', cls: 'gs-ok' },
    'behind':   { label: 'At risk',  cls: 'gs-warn' },
    'done':     { label: 'Done 🏆',  cls: 'gs-done' }
  };
  function renderGoals() {
    var box = $('#goals-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'goal' }).then(function (dd) {
      var items = (dd.items || []);
      var prog = goalProgress();
      // Year pace header (Strides-style): where the year is vs where your goals are.
      var now = new Date();
      var year = now.getFullYear();
      var dayOfYear = Math.floor((now - new Date(year, 0, 1)) / 864e5) + 1;
      var yearPct = Math.round(dayOfYear / 365 * 100);
      var doneCount = items.filter(function (x) { return String(x.status) === 'done'; }).length;
      var avg = items.length ? Math.round(items.reduce(function (s, x) {
        return s + (String(x.status) === 'done' ? 100 : (Number(prog[x.id]) || 0));
      }, 0) / items.length) : 0;
      box.innerHTML =
        (items.length ?
          '<div class="card"><div class="eyebrow">' + year + ' · Year check</div>' +
          '<div class="yeartrack"><div class="yt-row"><span>Year gone</span><b>' + yearPct + '%</b></div>' +
          '<div class="fc-bar"><span style="width:' + yearPct + '%;background:var(--muted)"></span></div>' +
          '<div class="yt-row" style="margin-top:8px"><span>Goals progress</span><b>' + avg + '%' + (avg >= yearPct ? ' · ahead 🔥' : ' · behind pace') + '</b></div>' +
          '<div class="fc-bar"><span style="width:' + avg + '%"></span></div></div>' +
          '<div class="muted tiny" style="margin-top:8px">' + doneCount + '/' + items.length + ' goals completed</div></div>' : '') +
        (items.length ? items.map(function (x) {
          var st = GOAL_STATUS[String(x.status)] || GOAL_STATUS['on-track'];
          var p = String(x.status) === 'done' ? 100 : Math.max(0, Math.min(100, Number(prog[x.id]) || 0));
          return '<div class="card goal-card">' +
            '<div class="list-row" style="border:0;padding:0"><b>' + esc(x.title) + '</b>' +
              '<span style="display:flex;gap:6px;align-items:center"><button class="goal-status ' + st.cls + '" data-cycle="' + x.id + '" data-cur="' + esc(String(x.status || 'on-track')) + '">' + st.label + '</button>' +
              '<button class="list-del" data-del="' + x.id + '">✕</button></span></div>' +
            '<div class="goal-progress"><input type="range" min="0" max="100" step="5" value="' + p + '" data-prog="' + x.id + '"' + (String(x.status) === 'done' ? ' disabled' : '') + ' />' +
              '<span class="mono goal-pct" id="gp-' + x.id + '">' + p + '%</span></div>' +
            '<div class="fc-bar' + (p >= 100 ? '' : '') + '" style="margin-top:2px"><span id="gpb-' + x.id + '" style="width:' + p + '%"></span></div>' +
            (x.note ? '<div class="muted tiny" style="margin-top:8px">' + esc(x.note) + '</div>' : '') +
          '</div>';
        }).join('') : '<div class="card"><p class="muted tiny" style="margin:0">No goals yet — what do you want ' + year + ' to be remembered for? Add the first one below 🎯</p></div>') +
        '<div class="card"><div class="eyebrow">New yearly goal</div>' +
          '<label>Goal<input id="gl-title" placeholder="e.g. Read 12 books" /></label>' +
          '<div class="manual-grid"><label>Status<select id="gl-status"><option value="on-track">On track</option><option value="behind">At risk</option><option value="done">Done</option></select></label>' +
          '<label>Note<input id="gl-note" placeholder="optional" /></label></div>' +
          '<button id="gl-add" class="btn primary block">Add goal</button></div>';
      $('#gl-add').addEventListener('click', function () { var t = $('#gl-title').value.trim(); if (!t) { toast('Enter a goal'); return; } api('listAdd', { kind: 'goal', item: { title: t, status: $('#gl-status').value, note: $('#gl-note').value.trim() } }).then(function () { toast('Added ✓'); renderGoals(); }).catch(function (e) { toast(e.message); }); });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'goal', id: b.getAttribute('data-del') }).then(renderGoals); }); });
      // Tap the status chip to cycle On track → At risk → Done.
      box.querySelectorAll('[data-cycle]').forEach(function (b) {
        b.addEventListener('click', function () {
          var order = ['on-track', 'behind', 'done'];
          var next = order[(order.indexOf(b.getAttribute('data-cur')) + 1) % order.length];
          api('listUpdate', { kind: 'goal', id: b.getAttribute('data-cycle'), item: { status: next } })
            .then(function () { if (next === 'done') toast('Goal done — legend! 🏆'); renderGoals(); })
            .catch(function (e) { toast(e.message); });
        });
      });
      // Progress slider: live bar update, save on release (debounced via change).
      box.querySelectorAll('[data-prog]').forEach(function (r) {
        var id = r.getAttribute('data-prog');
        r.addEventListener('input', function () {
          $('#gp-' + id).textContent = r.value + '%';
          $('#gpb-' + id).style.width = r.value + '%';
        });
        r.addEventListener('change', function () {
          var gp = Object.assign({}, goalProgress()); gp[id] = Number(r.value) || 0;
          saveProfileKey('goalProgress', gp);
        });
      });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function renderLibrary() {
    var box = $('#library-groups'); if (!box) return;
    var live = APPS.filter(function (a) { return a.open; }).length;
    $('#lib-count').textContent = APPS.length + ' apps · ' + live + ' live';
    box.innerHTML = PILLARS.map(function (p) {
      var apps = APPS.filter(function (a) { return a.pillar === p.id; });
      var tiles = apps.map(function (a) {
        return '<button class="app-tile' + (a.open ? '' : ' soon') + '" data-app="' + a.id + '" style="--pc:' + p.color + '">' +
          '<span class="app-ico">' + a.icon + '</span><span class="app-name">' + a.name + '</span>' +
          (a.open ? '' : '<span class="app-soon">soon</span>') + '</button>';
      }).join('');
      return '<div class="lib-group"><div class="lib-group-head eyebrow" style="color:' + p.color + '">' + p.name + '</div>' +
        '<div class="app-grid">' + tiles + '</div></div>';
    }).join('');
  }
  function openApp(id) {
    var a = APPS.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    if (a.open) a.open();
    else toast(a.name + ' — coming soon ✨');
  }
  function homeQuickAction(qa) {
    if (qa === 'water') {
      state.today.waterMl = (Number(state.today.waterMl) || 0) + 250;
      afterWaterChange();
      toast('+250 ml 💧');
    } else if (qa === 'scan') {
      openFoodModal('Snacks');
      setTimeout(function () { $('#food-manual').classList.remove('hidden'); }, 150);
    } else if (qa === 'coach') {
      openCoach();
    } else if (qa === 'today') {
      switchView('today');
    }
  }

  /* ---------------- AI Coach chat ---------------- */
  function coachKey() { return 'hard_coach_' + (state.coachDomain || 'hard') + '_' + (state.username || ''); }
  function loadCoachHistory() {
    try { return JSON.parse(localStorage.getItem(coachKey()) || '[]'); } catch (e) { return []; }
  }
  function saveCoachHistory() {
    try { localStorage.setItem(coachKey(), JSON.stringify((state.coachHistory || []).slice(-20))); } catch (e) {}
  }
  function openCoach(domain) {
    state.coachDomain = domain || 'hard';
    state.coachHistory = loadCoachHistory();
    $('#coach-title').textContent = state.coachDomain === 'money' ? '💰 Penny' : '✨ AI Coach';
    show('#coach-modal');
    renderCoachMsgs();
    setTimeout(function () { $('#coach-text').focus(); }, 120);
  }
  function coachFormat(text) {
    var s = esc(text);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^\s*[-*]\s+/gm, '• ');
    return s.replace(/\n/g, '<br>');
  }
  function renderCoachMsgs(typing) {
    var box = $('#coach-msgs'); if (!box) return;
    var hist = state.coachHistory || [];
    var html = '';
    if (!hist.length) {
      html += state.coachDomain === 'money'
        ? '<div class="cm cm-model">Hi ' + esc(firstName(state.user.displayName)) + '! I’m Penny, your money coach — I can see your spending, budget and categories. ' +
          'Ask me about your budget pace, where you’re overspending, or how to hit a savings goal. 💰</div>'
        : '<div class="cm cm-model">Hey ' + esc(firstName(state.user.displayName)) +
          '! I’m your AI coach and I can see your 75 Hard progress, diet, fasting and mood. ' +
          'Ask me anything — how you’re tracking, diet tweaks, workout ideas, or a motivation boost. 💪</div>';
    }
    hist.forEach(function (m) {
      html += '<div class="cm cm-' + (m.role === 'model' ? 'model' : 'user') + '">' + coachFormat(m.text) + '</div>';
    });
    if (typing) html += '<div class="cm cm-model cm-typing"><span></span><span></span><span></span></div>';
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
  function sendCoach() {
    if (state.coachBusy) return;
    var inp = $('#coach-text');
    var msg = (inp.value || '').trim();
    if (!msg) return;
    inp.value = ''; inp.style.height = 'auto';
    if (state.coachHistory == null) state.coachHistory = [];
    var priorHistory = state.coachHistory.slice();   // exclude the new message
    state.coachHistory.push({ role: 'user', text: msg });
    state.coachBusy = true; $('#coach-send').disabled = true;
    renderCoachMsgs(true);
    var action = state.coachDomain === 'money' ? 'moneyCoachChat' : 'coachChat';
    api(action, { message: msg, history: priorHistory }).then(function (d) {
      state.coachHistory.push({ role: 'model', text: d.reply || '(no reply)' });
      saveCoachHistory();
    }).catch(function (e) {
      state.coachHistory.push({ role: 'model', text: '⚠️ ' + (e.message || 'Coach unavailable right now.') });
    }).then(function () {
      state.coachBusy = false; $('#coach-send').disabled = false;
      renderCoachMsgs();
    });
  }
  function clearCoach() {
    if (!(state.coachHistory && state.coachHistory.length)) return;
    if (!confirm('Clear this conversation?')) return;
    state.coachHistory = []; saveCoachHistory(); renderCoachMsgs();
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
