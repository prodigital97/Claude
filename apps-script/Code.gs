/**
 * 75 Hard Dashboard — Google Apps Script backend
 * ------------------------------------------------
 * Stores all data in a Google Sheet and exposes a small JSON API that the
 * mobile web app talks to.
 *
 * SHEETS (auto-created on first run):
 *   Users : username | displayName | passwordHash | salt | token | startDate | createdAt
 *   Logs  : username | date | dayNumber | workout1 | workout2 | outdoor |
 *           waterMl | reading | photo | diet | noAlcohol | completed | notes | updatedAt
 *
 * Deploy:  Deploy > New deployment > Web app
 *          Execute as: Me   |   Who has access: Anyone
 *          Copy the /exec URL into js/config.js (API_URL).
 */

/* Bumped whenever this file changes in a way the app depends on. The app shows
   it in Settings beside its own version, so you can tell at a glance whether the
   deployed backend is current — a mismatch means this file has changes that are
   not live yet, and only a redeploy (Deploy > Manage deployments > edit > New
   version) can publish them. */
var BACKEND_VERSION = '2.65.1';


var WATER_GOAL_ML = 4000;         // 4 L (comfortably meets the 1-gallon rule)
var CHALLENGE_LENGTH = 75;        // days
var GEMINI_MODEL = 'gemini-2.5-flash-lite';   // cheapest vision model for label scanning
var USERS_SHEET = 'Users';
var LOGS_SHEET = 'Logs';

var FOOD_SHEET = 'Food';
var PROFILE_SHEET = 'Profiles';
var FAST_SHEET = 'Fasts';
var CUSTOM_SHEET = 'CustomFoods';

var USER_HEADERS = ['username', 'displayName', 'passwordHash', 'salt', 'token', 'startDate', 'createdAt', 'email', 'emailVerified'];
var LOG_HEADERS = ['username', 'date', 'dayNumber', 'workout1', 'workout2', 'outdoor',
                   'waterMl', 'reading', 'photo', 'diet', 'noAlcohol', 'completed', 'notes', 'updatedAt', 'extra', 'mood', 'gut', 'biz', 'metrics'];
// 'sugar' / 'fiber' appended at the end so older Food rows keep their column positions.
var FOOD_HEADERS = ['id', 'username', 'date', 'meal', 'name', 'grams',
                    'calories', 'protein', 'carbs', 'fat', 'createdAt', 'sugar', 'fiber'];
var PROFILE_HEADERS = ['username', 'dataJson', 'updatedAt'];
var FAST_HEADERS = ['id', 'username', 'startAt', 'endAt', 'goalHours', 'createdAt'];
var CUSTOM_HEADERS = ['id', 'name', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'createdBy', 'createdAt',
                      'satFat', 'transFat', 'fiber', 'addedSugar', 'sodium', 'cholesterol', 'calcium', 'iron', 'servingSize', 'dataJson'];

// Admin dashboard: usernames listed here get access to /admin actions.
var ADMIN_USERS = ['pronoy'];
var SCAN_SHEET = 'ScanLog';
// 'kind' appended at the end so older rows keep their column positions
// (food | money | screentime) — lets the admin dashboard split costs by type.
var SCAN_HEADERS = ['id', 'at', 'username', 'name', 'model', 'images', 'promptTokens', 'outputTokens', 'totalTokens', 'costUsd', 'costInr', 'kind'];
// Friend graph: one row per directed request; status pending | accepted.
var FRIEND_SHEET = 'Friends';
var FRIEND_HEADERS = ['id', 'requester', 'addressee', 'status', 'createdAt', 'updatedAt'];
// Gemini pricing (USD per 1M tokens). Used to estimate per-scan cost.
var GEMINI_PRICES = {
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'gemini-flash-lite-latest': { in: 0.10, out: 0.40 },
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'gemini-flash-latest': { in: 0.30, out: 2.50 }
};

/* ---- Charge: a per-user monthly budget for the API-cost features ----------
 * The ONLY place an API-cost cap can actually be enforced is here on the
 * server, since this script holds the Gemini/FatSecret keys. Every user gets
 * CHARGE_BASE free each month and earns more by completing days, capped at
 * CHARGE_MAX. Spend is tracked per user per month in the ChargeLog sheet.
 * Admins are exempt. Tune the numbers to your real API budget. */
var CHARGE_SHEET = 'ChargeLog';
var CHARGE_HEADERS = ['username', 'month', 'spent', 'updatedAt'];
var CHARGE_BASE = 100;          // free Charge granted at the start of each month
var CHARGE_EARN_PER_DAY = 6;    // Charge earned for each completed day this month
var CHARGE_MAX = 300;           // ceiling on a single month's balance
// Cost of each AI/quota action, keyed by its router action name.
var CHARGE_ACTIONS = {
  scanLabel: 5, foodSearch: 1, coachChat: 2, parseScreenTime: 8,
  moneyParseScreenshot: 5, moneyParseMessage: 2, moneyCoachChat: 2
};
function isChargeExempt(username) { return ADMIN_USERS.indexOf(username) >= 0; }
function chargeMonth() { return todayStr().slice(0, 7); }
function chargeCompletedDaysThisMonth(username) {
  var sheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(LOG_HEADERS);
  var month = chargeMonth(), n = 0;
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== username) continue;
    if (formatDate(values[i][idx.date]).slice(0, 7) !== month) continue;
    if (toBool(values[i][idx.completed])) n++;
  }
  return n;
}
function chargeSpentRow(username) {
  var sheet = getSheet(CHARGE_SHEET, CHARGE_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CHARGE_HEADERS);
  var month = chargeMonth();
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username && String(values[i][idx.month]) === month) {
      return { row: i + 1, spent: Number(values[i][idx.spent]) || 0 };
    }
  }
  return { row: 0, spent: 0 };
}
function chargeStateFor(username) {
  var exempt = isChargeExempt(username);
  var earned = Math.min(CHARGE_MAX - CHARGE_BASE, chargeCompletedDaysThisMonth(username) * CHARGE_EARN_PER_DAY);
  if (earned < 0) earned = 0;
  var spent = chargeSpentRow(username).spent;
  var cap = Math.min(CHARGE_MAX, CHARGE_BASE + earned);
  return {
    month: chargeMonth(), base: CHARGE_BASE, earned: earned, spent: spent, cap: cap,
    balance: exempt ? 9999 : Math.max(0, cap - spent), max: CHARGE_MAX,
    earnPerDay: CHARGE_EARN_PER_DAY, costs: CHARGE_ACTIONS, unlimited: exempt
  };
}
function chargeGate(username, cost) {
  if (isChargeExempt(username)) return;
  var st = chargeStateFor(username);
  if (st.balance < cost) {
    throw new Error('CHARGE_EMPTY|You’re out of Charge. Complete today’s tasks to recharge (+' +
      CHARGE_EARN_PER_DAY + ' each), or it refills on the 1st.');
  }
}
function chargeSpend(username, cost) {
  if (isChargeExempt(username)) return;
  var sheet = getSheet(CHARGE_SHEET, CHARGE_HEADERS);
  var r = chargeSpentRow(username);
  var idx = colIndex(CHARGE_HEADERS);
  if (r.row) {
    sheet.getRange(r.row, idx.spent + 1).setValue(r.spent + cost);
    sheet.getRange(r.row, idx.updatedAt + 1).setValue(new Date().toISOString());
  } else {
    sheet.appendRow([username, chargeMonth(), cost, new Date().toISOString()]);
  }
}
function handleGetCharge(body) { var u = authUser(body); return chargeStateFor(u.username); }

/* ----------------------------------------------------------------------- *
 *  HTTP entry points
 * ----------------------------------------------------------------------- */

function doGet(e) {
  // Health check / lets you confirm the deployment works in a browser.
  return jsonOutput({ ok: true, service: '75hard', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action || '';
    var data;

    // Charge gate — the server-side API-cost cap. For any metered action we
    // check the caller has enough Charge BEFORE running it (so an empty user
    // never triggers a paid API call), then deduct only after it succeeds.
    var chargeCost = CHARGE_ACTIONS[action];
    var chargeUser = null;
    if (chargeCost) { chargeUser = authUser(body).username; chargeGate(chargeUser, chargeCost); }

    switch (action) {
      case 'register':   data = handleRegister(body);  break;
      case 'login':      data = handleLogin(body);     break;
      case 'listGet':          data = handleListGet(body);          break;
      case 'listAdd':          data = handleListAdd(body);          break;
      case 'listUpdate':       data = handleListUpdate(body);       break;
      case 'listDelete':       data = handleListDelete(body);       break;

      case 'moneyGetState':      data = handleMoneyGetState(body);      break;
      case 'moneyAddAccount':    data = handleMoneyAddAccount(body);    break;
      case 'moneyUpdateAccount': data = handleMoneyUpdateAccount(body); break;
      case 'moneyDeleteAccount': data = handleMoneyDeleteAccount(body); break;
      case 'moneyAddCategory':   data = handleMoneyAddCategory(body);   break;
      case 'moneyUpdateCategory':data = handleMoneyUpdateCategory(body);break;
      case 'moneyDeleteCategory':data = handleMoneyDeleteCategory(body);break;
      case 'moneyGetTxns':       data = handleMoneyGetTxns(body);       break;
      case 'moneyAddTxn':        data = handleMoneyAddTxn(body);        break;
      case 'moneyAddTxns':       data = handleMoneyAddTxns(body);       break;
      case 'moneyUpdateTxn':     data = handleMoneyUpdateTxn(body);     break;
      case 'moneyDeleteTxn':     data = handleMoneyDeleteTxn(body);     break;
      case 'moneyDashboard':     data = handleMoneyDashboard(body);     break;
      case 'moneySaveBudget':    data = handleMoneySaveBudget(body);    break;
      case 'moneyParseScreenshot': data = handleMoneyParseScreenshot(body); break;
      case 'moneyParseMessage':  data = handleMoneyParseMessage(body);  break;
      case 'moneyCoachChat':     data = handleMoneyCoachChat(body);     break;
      case 'updateEmail':      data = handleUpdateEmail(body);      break;
      case 'changePassword':   data = handleChangePassword(body);   break;
      case 'changeUsername':   data = handleChangeUsername(body);   break;
      case 'adminResetPassword': data = handleAdminResetPassword(body); break;
      case 'getState':   data = handleGetState(body);  break;
      case 'saveDay':    data = handleSaveDay(body);   break;
      case 'reset':      data = handleReset(body);     break;
      case 'leaderboard':data = handleLeaderboard(body); break;
      case 'searchUsers':  data = handleSearchUsers(body);  break;
      case 'getFriends':   data = handleGetFriends(body);   break;
      case 'addFriend':    data = handleAddFriend(body);    break;
      case 'respondFriend':data = handleRespondFriend(body);break;
      case 'removeFriend': data = handleRemoveFriend(body); break;
      case 'updateProfile': data = handleUpdateProfile(body); break;
      case 'deleteAccount': data = handleDeleteAccount(body); break;
      case 'saveGoals':  data = handleSaveGoals(body);  break;
      case 'getFood':    data = handleGetFood(body);    break;
      case 'getFoodRange': data = handleGetFoodRange(body); break;
      case 'addFood':    data = handleAddFood(body);    break;
      case 'deleteFood': data = handleDeleteFood(body); break;
      case 'updateFood': data = handleUpdateFood(body); break;
      case 'foodSummary':data = handleFoodSummary(body); break;
      case 'getCustomFoods': data = handleGetCustomFoods(body); break;
      case 'addCustomFood':  data = handleAddCustomFood(body);  break;
      case 'foodSearch':     data = handleFoodSearch(body);     break;
      case 'scanLabel':      data = handleScanLabel(body);      break;
      case 'parseScreenTime':data = handleParseScreenTime(body); break;
      case 'coachChat':      data = handleCoachChat(body);      break;
      case 'adminScans':      data = handleAdminScans(body);      break;
      case 'adminUsers':      data = handleAdminUsers(body);      break;
      case 'adminFoods':      data = handleAdminFoods(body);      break;
      case 'adminUpdateFood': data = handleAdminUpdateFood(body); break;
      case 'adminDeleteFood': data = handleAdminDeleteFood(body); break;
      case 'startFast':    data = handleStartFast(body);    break;
      case 'endFast':      data = handleEndFast(body);      break;
      case 'logPastFast':  data = handleLogPastFast(body);  break;
      case 'getFasts':     data = handleGetFasts(body);     break;
      case 'updateFast': data = handleUpdateFast(body); break;
      case 'deleteFast': data = handleDeleteFast(body); break;
      case 'getCharge':  data = handleGetCharge(body); break;
      default:
        return jsonOutput({ ok: false, error: 'Unknown action: ' + action });
    }
    // Deduct Charge only now that the metered action has succeeded, and return
    // the fresh balance in the envelope so the client can update its battery.
    var chargeState = null;
    if (chargeCost && chargeUser) {
      try { chargeSpend(chargeUser, chargeCost); chargeState = chargeStateFor(chargeUser); } catch (e) {}
    }
    return jsonOutput({ ok: true, data: data, charge: chargeState });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ----------------------------------------------------------------------- *
 *  Actions
 * ----------------------------------------------------------------------- */

function handleRegister(body) {
  var username = normalizeUsername(body.username);
  var password = String(body.password || '');
  var displayName = String(body.displayName || username).trim() || username;
  var startDate = normIso(body.startDate) || todayStr();
  var email = normalizeEmail(body.email);

  if (username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (password.length < 4) throw new Error('Password must be at least 4 characters.');
  if (email && !isEmail(email)) throw new Error('Enter a valid email address (or leave it blank).');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  if (findUserRow(sheet, username)) throw new Error('That username is already taken.');
  if (email && findUserByEmail(email)) throw new Error('That email is already on another account.');

  var salt = Utilities.getUuid();
  var token = Utilities.getUuid();
  var idx = colIndex(USER_HEADERS);
  sheet.appendRow([
    username, displayName, hashPassword(password, salt), salt, token, startDate, new Date().toISOString(), email, !!email
  ]);
  // Force the start-date cell to plain text so Sheets can never re-interpret it.
  setStartDateCell(sheet, sheet.getLastRow(), idx.startDate + 1, startDate);

  return { token: token, user: publicUser(username, displayName, startDate, email, !!email) };
}

/* ---------------- Account management (no email is ever sent) ---------------- */

function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

function findUserByEmail(email) {
  email = normalizeEmail(email);
  if (!email) return null;
  var values = getSheet(USERS_SHEET, USER_HEADERS).getDataRange().getValues();
  var idx = colIndex(USER_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (normalizeEmail(values[i][idx.email]) === email) return { row: i + 1, values: values[i] };
  }
  return null;
}

// Save / update the user's email (optional, not verified — we never send to it).
function handleUpdateEmail(body) {
  var user = authUser(body);
  var email = normalizeEmail(body.email);
  if (email && !isEmail(email)) throw new Error('Enter a valid email address (or leave it blank).');
  var other = email ? findUserByEmail(email) : null;
  if (other && normalizeUsername(other.values[colIndex(USER_HEADERS).username]) !== user.username) {
    throw new Error('That email is already used by another account.');
  }
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var idx = colIndex(USER_HEADERS);
  sheet.getRange(user.row, idx.email + 1).setValue(email);
  sheet.getRange(user.row, idx.emailVerified + 1).setValue(!!email);
  var row = sheet.getRange(user.row, 1, 1, USER_HEADERS.length).getValues()[0];
  return { user: publicUserFromRow(row) };
}

// Admin sets a new password for any user (covers forgotten passwords, no email needed).
function handleAdminResetPassword(body) {
  requireAdmin(body);
  var target = normalizeUsername(body.username);
  var newPassword = String(body.newPassword || '');
  if (newPassword.length < 4) throw new Error('New password must be at least 4 characters.');
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, target);
  if (!found) throw new Error('User not found.');
  var idx = colIndex(USER_HEADERS);
  var salt = Utilities.getUuid();
  sheet.getRange(found.row, idx.salt + 1).setValue(salt);
  sheet.getRange(found.row, idx.passwordHash + 1).setValue(hashPassword(newPassword, salt));
  sheet.getRange(found.row, idx.token + 1).setValue(Utilities.getUuid()); // force re-login
  return { ok: true, username: target };
}

function handleChangePassword(body) {
  var user = authUser(body);
  var current = String(body.currentPassword || '');
  var next = String(body.newPassword || '');
  if (next.length < 4) throw new Error('New password must be at least 4 characters.');
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var idx = colIndex(USER_HEADERS);
  var row = sheet.getRange(user.row, 1, 1, USER_HEADERS.length).getValues()[0];
  if (hashPassword(current, row[idx.salt]) !== row[idx.passwordHash]) throw new Error('Current password is incorrect.');
  var salt = Utilities.getUuid();
  sheet.getRange(user.row, idx.salt + 1).setValue(salt);
  sheet.getRange(user.row, idx.passwordHash + 1).setValue(hashPassword(next, salt));
  return { ok: true };
}

function handleChangeUsername(body) {
  var user = authUser(body);
  var newName = normalizeUsername(body.newUsername);
  var password = String(body.password || '');
  if (newName.length < 3) throw new Error('Username must be at least 3 characters.');
  if (newName === user.username) throw new Error('That is already your username.');
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var idx = colIndex(USER_HEADERS);
  var row = sheet.getRange(user.row, 1, 1, USER_HEADERS.length).getValues()[0];
  if (hashPassword(password, row[idx.salt]) !== row[idx.passwordHash]) throw new Error('Password is incorrect.');
  if (findUserRow(sheet, newName)) throw new Error('That username is already taken.');

  var old = user.username;
  sheet.getRange(user.row, idx.username + 1).setValue(newName);
  // Cascade the rename across every sheet that stores the username.
  renameInColumn(LOGS_SHEET, LOG_HEADERS, 'username', old, newName);
  renameInColumn(FOOD_SHEET, FOOD_HEADERS, 'username', old, newName);
  renameInColumn(FAST_SHEET, FAST_HEADERS, 'username', old, newName);
  renameInColumn(SCAN_SHEET, SCAN_HEADERS, 'username', old, newName);
  renameInColumn(CUSTOM_SHEET, CUSTOM_HEADERS, 'createdBy', old, newName);
  renameInColumn(FRIEND_SHEET, FRIEND_HEADERS, 'requester', old, newName);
  renameInColumn(FRIEND_SHEET, FRIEND_HEADERS, 'addressee', old, newName);
  renameFirstColumn(PROFILE_SHEET, PROFILE_HEADERS, old, newName); // Profiles keyed by col 0

  var token = Utilities.getUuid();
  sheet.getRange(user.row, idx.token + 1).setValue(token);
  var fresh = sheet.getRange(user.row, 1, 1, USER_HEADERS.length).getValues()[0];
  return { token: token, user: publicUserFromRow(fresh) };
}

function renameInColumn(sheetName, headers, colName, oldVal, newVal) {
  var sheet = getSheet(sheetName, headers);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(headers);
  var col = idx[colName];
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][col]) === oldVal) sheet.getRange(i + 1, col + 1).setValue(newVal);
  }
}
function renameFirstColumn(sheetName, headers, oldVal, newVal) {
  var sheet = getSheet(sheetName, headers);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === oldVal) sheet.getRange(i + 1, 1).setValue(newVal);
  }
}

function handleLogin(body) {
  var username = normalizeUsername(body.username);
  var password = String(body.password || '');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, username);
  if (!found) throw new Error('Invalid username or password.');

  var row = found.values;
  var idx = colIndex(USER_HEADERS);
  if (hashPassword(password, row[idx.salt]) !== row[idx.passwordHash]) {
    throw new Error('Invalid username or password.');
  }

  // Rotate a fresh token on every login.
  var token = Utilities.getUuid();
  sheet.getRange(found.row, idx.token + 1).setValue(token);

  return {
    token: token,
    user: publicUser(username, row[idx.displayName], row[idx.startDate], row[idx.email], toBool(row[idx.emailVerified]))
  };
}

function handleGetState(body) {
  var user = authUser(body);
  return {
    backendVersion: BACKEND_VERSION,
    user: publicUser(user.username, user.displayName, user.startDate, user.email, user.emailVerified),
    logs: getUserLogs(user.username),
    profile: getProfile(user.username),
    activeFast: getActiveFast(user.username)
  };
}

/* ---------------- Intermittent fasting ---------------- */

function getActiveFast(username) {
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][idx.username]) === username && !values[i][idx.endAt]) {
      return fastFromRow(values[i], idx);
    }
  }
  return null;
}

function handleStartFast(body) {
  var user = authUser(body);
  var existing = getActiveFast(user.username);
  if (existing) return { fast: existing };

  var record = {
    id: Utilities.getUuid(),
    username: user.username,
    startAt: body.startAt ? String(body.startAt) : new Date().toISOString(),
    endAt: '',
    goalHours: 0,  // unused — milestone is derived from actual duration
    createdAt: new Date().toISOString()
  };
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  sheet.appendRow(FAST_HEADERS.map(function (h) { return record[h]; }));
  return { fast: record };
}

// Logging a completed PAST fast (the "+ Log a past fast" form) always creates
// its own row directly — it must never reuse handleStartFast, which returns
// your CURRENT active fast if one exists. Piggybacking on startFast+updateFast
// used to silently overwrite (and end) a real in-progress fast with the past
// dates you were only trying to log separately.
function handleLogPastFast(body) {
  var user = authUser(body);
  var startAt = String(body.startAt || ''), endAt = String(body.endAt || '');
  if (!startAt || !endAt) throw new Error('Both start and end times are required.');
  var record = {
    id: Utilities.getUuid(),
    username: user.username,
    startAt: startAt,
    endAt: endAt,
    goalHours: 0,
    createdAt: new Date().toISOString()
  };
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  sheet.appendRow(FAST_HEADERS.map(function (h) { return record[h]; }));
  return { fast: record };
}

function handleEndFast(body) {
  var user = authUser(body);
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][idx.username]) === user.username && !values[i][idx.endAt]) {
      // Accept an explicit end time so a fast you forgot to close can be ended
      // at the hour it actually finished, instead of being logged as however
      // long the app happened to sit open. Clamped to the real interval: it
      // cannot precede the start, and it cannot be in the future.
      var endAt = new Date().toISOString();
      if (body.endAt) {
        var want = new Date(body.endAt);
        if (!isNaN(want.getTime())) {
          var startMs = new Date(values[i][idx.startAt]).getTime();
          var nowMs = Date.now();
          var wantMs = want.getTime();
          if (wantMs > startMs && wantMs <= nowMs) endAt = want.toISOString();
        }
      }
      sheet.getRange(i + 1, idx.endAt + 1).setValue(endAt);
      values[i][idx.endAt] = endAt;
      return { fast: fastFromRow(values[i], idx) };
    }
  }
  return { fast: null };
}

function handleGetFasts(body) {
  var user = authUser(body);
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  var active = null, done = [];
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== user.username) continue;
    var f = fastFromRow(values[i], idx);
    if (!f.endAt) active = f; else done.push(f);
  }
  done.sort(function (a, b) { return a.startAt < b.startAt ? 1 : -1; });
  return { active: active, fasts: done.slice(0, 30) };
}

function handleUpdateFast(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      if (body.startAt) {
        sheet.getRange(i + 1, idx.startAt + 1).setValue(String(body.startAt));
        values[i][idx.startAt] = String(body.startAt);
      }
      if (body.endAt != null) {
        sheet.getRange(i + 1, idx.endAt + 1).setValue(String(body.endAt));
        values[i][idx.endAt] = String(body.endAt);
      }
      return { fast: fastFromRow(values[i], idx) };
    }
  }
  throw new Error('Fast not found.');
}

function handleDeleteFast(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.deleteRow(i + 1);
      return { deleted: id };
    }
  }
  return { deleted: null };
}

function fastFromRow(r, idx) {
  return {
    id: String(r[idx.id]),
    startAt: String(r[idx.startAt]),
    endAt: r[idx.endAt] ? String(r[idx.endAt]) : ''
  };
}

/* ---------------- Diet: goals + food log ---------------- */

function getProfile(username) {
  var sheet = getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === username) {
      try { return JSON.parse(values[i][1] || '{}'); } catch (e) { return {}; }
    }
  }
  return {};
}

// The client shows cached data instantly on launch, before the fresh profile
// has come back from the server, so it can be mid-render against a STALE or
// even empty profile snapshot. If a save fired from that snapshot fully
// replaced the stored record, every field the client didn't happen to know
// about yet (meds, habits, gym exercises, custom challenge, ...) would be
// silently erased. Merging onto whatever is already stored means a field is
// only ever changed when the client explicitly sends a new value for it —
// normal edits and deletions still work (the field IS present, just with a
// new value), but a stale/incomplete snapshot can no longer wipe the rest.
function handleSaveGoals(body) {
  var user = authUser(body);
  var incoming = body.profile || {};
  var sheet = getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === user.username) {
      var existing = {}; try { existing = JSON.parse(values[i][1] || '{}'); } catch (e) {}
      var merged = Object.assign({}, existing, incoming);
      sheet.getRange(i + 1, 1, 1, 3).setValues([[user.username, JSON.stringify(merged), new Date().toISOString()]]);
      return { profile: merged };
    }
  }
  sheet.appendRow([user.username, JSON.stringify(incoming), new Date().toISOString()]);
  return { profile: incoming };
}

function handleGetFood(body) {
  var user = authUser(body);
  var date = String(body.date || todayStr());
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== user.username) continue;
    if (formatDate(r[idx.date]) !== date) continue;
    out.push(foodFromRow(r, idx));
  }
  return { foods: out };
}

// One efficient sheet scan for a whole week/month — per-day totals + range
// averages, so the Diet screen's Week/Month toggle doesn't need N getFood calls.
function handleGetFoodRange(body) {
  var user = authUser(body);
  var from = String(body.from || todayStr());
  var to = String(body.to || todayStr());
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  var perDay = {};
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== user.username) continue;
    var d = formatDate(r[idx.date]);
    if (d < from || d > to) continue;
    var e = perDay[d] || (perDay[d] = { date: d, cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 });
    e.cal += Number(r[idx.calories]) || 0;
    e.p += Number(r[idx.protein]) || 0;
    e.c += Number(r[idx.carbs]) || 0;
    e.f += Number(r[idx.fat]) || 0;
    e.s += Number(r[idx.sugar]) || 0;
    e.fb += Number(r[idx.fiber]) || 0;
  }
  var days = Object.keys(perDay).sort();
  var tot = { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 };
  days.forEach(function (d) {
    var e = perDay[d];
    tot.cal += e.cal; tot.p += e.p; tot.c += e.c; tot.f += e.f; tot.s += e.s; tot.fb += e.fb;
  });
  var n = days.length;
  function avg(v) { return n ? v / n : 0; }
  return {
    from: from, to: to, daysLogged: n,
    perDay: days.map(function (d) { return perDay[d]; }),
    total: { cal: Math.round(tot.cal), p: Math.round(tot.p), c: Math.round(tot.c), f: Math.round(tot.f), s: Math.round(tot.s), fb: Math.round(tot.fb) },
    avg: { cal: Math.round(avg(tot.cal)), p: Math.round(avg(tot.p)), c: Math.round(avg(tot.c)), f: Math.round(avg(tot.f)), s: Math.round(avg(tot.s)), fb: Math.round(avg(tot.fb)) }
  };
}

function handleAddFood(body) {
  var user = authUser(body);
  var f = body.food || {};
  var record = {
    id: Utilities.getUuid(),
    username: user.username,
    date: String(f.date || todayStr()),
    meal: String(f.meal || 'Other'),
    name: String(f.name || 'Food').slice(0, 120),
    grams: round1(f.grams),
    calories: Math.round(Number(f.calories) || 0),
    protein: round1(f.protein),
    carbs: round1(f.carbs),
    fat: round1(f.fat),
    sugar: round1(f.sugar),
    fiber: round1(f.fiber),
    createdAt: new Date().toISOString()
  };
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  sheet.appendRow(FOOD_HEADERS.map(function (h) { return record[h]; }));
  return { food: record };
}

function handleDeleteFood(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id && normalizeUsername(values[i][1]) === user.username) {
      sheet.deleteRow(i + 1);
      return { deleted: id };
    }
  }
  return { deleted: null };
}

function handleUpdateFood(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  if (!id) throw new Error('Food id required.');
  var f = body.food || {};
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.getRange(i + 1, idx.grams + 1).setValue(round1(f.grams));
      sheet.getRange(i + 1, idx.calories + 1).setValue(Math.round(Number(f.calories) || 0));
      sheet.getRange(i + 1, idx.protein + 1).setValue(round1(f.protein));
      sheet.getRange(i + 1, idx.carbs + 1).setValue(round1(f.carbs));
      sheet.getRange(i + 1, idx.fat + 1).setValue(round1(f.fat));
      sheet.getRange(i + 1, idx.sugar + 1).setValue(round1(f.sugar));
      sheet.getRange(i + 1, idx.fiber + 1).setValue(round1(f.fiber));
      return { food: foodFromRow(sheet.getRange(i + 1, 1, 1, FOOD_HEADERS.length).getValues()[0], idx) };
    }
  }
  throw new Error('Food not found.');
}

/* ---------------- Shared custom foods (visible to all users) ---------------- */

function handleGetCustomFoods(body) {
  authUser(body);
  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  var out = [], seen = {};
  for (var i = 1; i < values.length; i++) {
    if (!values[i][idx.name]) continue;
    var key = String(values[i][idx.name]).trim().toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(customFromRow(values[i], idx));
  }
  return { foods: out };
}

function handleAddCustomFood(body) {
  var user = authUser(body);
  var f = body.food || {};
  var name = String(f.name || '').trim();
  if (!name) throw new Error('Food name required.');

  var rec = {
    id: Utilities.getUuid(), name: name,
    kcal: Math.round(Number(f.kcal) || 0),
    protein: round1(f.p), carbs: round1(f.c), fat: round1(f.f), sugar: round1(f.s),
    createdBy: user.username, createdAt: new Date().toISOString(),
    satFat: round1(f.satFat), transFat: round1(f.transFat), fiber: round1(f.fiber),
    addedSugar: round1(f.addedSugar), sodium: round1(f.sodium), cholesterol: round1(f.cholesterol),
    calcium: round1(f.calcium), iron: round1(f.iron), servingSize: String(f.servingSize || ''),
    dataJson: f.data ? JSON.stringify(f.data) : ''
  };

  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.name]).trim().toLowerCase() === name.toLowerCase()) {
      // Already shared — enrich it with full-panel data if this came from a scan.
      if (rec.dataJson) {
        ['satFat', 'transFat', 'fiber', 'addedSugar', 'sodium', 'cholesterol', 'calcium', 'iron', 'servingSize', 'dataJson'].forEach(function (col) {
          sheet.getRange(i + 1, idx[col] + 1).setValue(rec[col]);
        });
      }
      return { food: customFromRow(values[i], idx) };
    }
  }
  sheet.appendRow(CUSTOM_HEADERS.map(function (h) { return rec[h]; }));
  return { food: rec };
}

function customFromRow(r, idx) {
  return {
    id: String(r[idx.id]), name: String(r[idx.name]),
    kcal: Number(r[idx.kcal]) || 0, protein: Number(r[idx.protein]) || 0,
    carbs: Number(r[idx.carbs]) || 0, fat: Number(r[idx.fat]) || 0, sugar: Number(r[idx.sugar]) || 0,
    fiber: Number(r[idx.fiber]) || 0
  };
}

/* ---------------- FatSecret proxy (optional) ---------------- *
 * Set FATSECRET_CLIENT_ID and FATSECRET_CLIENT_SECRET in
 * Project Settings -> Script properties. If not set, this is skipped and the
 * app falls back to Open Food Facts.
 * ------------------------------------------------------------ */

function fatsecretToken() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FATSECRET_CLIENT_ID');
  var secret = props.getProperty('FATSECRET_CLIENT_SECRET');
  if (!id || !secret) return null;

  var cache = CacheService.getScriptCache();
  var cached = cache.get('fs_token');
  if (cached) return cached;

  var resp = UrlFetchApp.fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'post',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=client_credentials&scope=basic',
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText() || '{}');
  if (!data.access_token) throw new Error('FatSecret auth failed: ' + resp.getContentText());
  cache.put('fs_token', data.access_token, Math.max(60, (Number(data.expires_in) || 86400) - 120));
  return data.access_token;
}

function handleFoodSearch(body) {
  authUser(body);
  return fatsecretSearch(String(body.q || '').trim());
}

function fatsecretSearch(q) {
  if (!q) return { foods: [], source: 'none' };

  var token;
  try { token = fatsecretToken(); } catch (e) { return { foods: [], source: 'error', error: String(e.message || e) }; }
  if (!token) return { foods: [], source: 'unconfigured' };

  var url = 'https://platform.fatsecret.com/rest/server.api?method=foods.search&format=json&max_results=30&search_expression=' + encodeURIComponent(q);
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText() || '{}');
  if (data.error) return { foods: [], source: 'error', error: data.error.message };

  var list = data.foods && data.foods.food ? data.foods.food : [];
  if (!Array.isArray(list)) list = [list];

  var out = [];
  list.forEach(function (f) {
    var parsed = parseFsDesc(String(f.food_description || ''));
    if (!parsed) return;
    out.push({
      name: String(f.food_name) + (f.brand_name ? ' · ' + f.brand_name : ''),
      kcal: parsed.kcal, p: parsed.p, c: parsed.c, f: parsed.f, s: 0,
      serving: 100
    });
  });
  return { foods: out, source: 'fatsecret' };
}

/* Parse "Per 100g - Calories: 717kcal | Fat: 81.00g | Carbs: 0.10g | Protein: 0.85g"
 * (or "Per 1 serving (30g) - ...") into per-100g values. */
function parseFsDesc(desc) {
  var cal = desc.match(/Calories:\s*([\d.]+)\s*kcal/i);
  if (!cal) return null;
  var kcal = Number(cal[1]);
  var fat = fsNum(desc, /Fat:\s*([\d.]+)\s*g/i);
  var carbs = fsNum(desc, /Carbs:\s*([\d.]+)\s*g/i);
  var protein = fsNum(desc, /Protein:\s*([\d.]+)\s*g/i);

  var grams = null;
  var g = desc.match(/Per\s+([\d.]+)\s*g\b/i) || desc.match(/\(([\d.]+)\s*g\)/i);
  if (g) grams = Number(g[1]);

  if (grams && grams > 0) {
    var k = 100 / grams;
    return { kcal: Math.round(kcal * k), p: round1(protein * k), c: round1(carbs * k), f: round1(fat * k) };
  }
  // Unknown gram weight (e.g. "Per 1 cup") — present the listed values as-is.
  return { kcal: Math.round(kcal), p: round1(protein), c: round1(carbs), f: round1(fat) };
}
function fsNum(s, re) { var m = s.match(re); return m ? Number(m[1]) : 0; }

/* ---------------- Gemini AI label scanner ---------------- *
 * Set GEMINI_API_KEY in Project Settings -> Script properties.
 * Get a free key at https://aistudio.google.com  (no IP whitelist needed).
 * ------------------------------------------------------------ */
function handleScanLabel(body) {
  authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI scanner not set up (missing GEMINI_API_KEY).');
  var mime = String(body.mime || 'image/jpeg');
  // Accept any of: a single image, an array of images (front + back), and/or a product name.
  var imgs = [];
  if (body.images && body.images.length) { for (var k = 0; k < body.images.length; k++) { var s = String(body.images[k] || ''); if (s) imgs.push(s); } }
  else if (body.image) imgs.push(String(body.image));
  var query = String(body.query || '').trim();
  if (!imgs.length && !query) throw new Error('No image or product name received.');

  var multi = imgs.length > 1;
  var prompt = 'You are a nutrition-data assistant for Indian + global packaged foods.\n';
  if (query) prompt += 'Product to look up by name: "' + query + '".\n';
  if (imgs.length) {
    prompt += (multi
      ? 'These ' + imgs.length + ' images are different sides of ONE product (e.g. front of pack + back nutrition panel). Combine them. '
      : 'There is one photo of a packaged food. ') +
      'It may be rotated, sideways or upside-down — read it in any orientation. ' +
      'Read the product "name" from the front-of-pack brand text if visible.\n';
  }
  prompt += '\nChoose the best source and set "estimated" accordingly:\n' +
    '- If a NUTRITION INFORMATION PANEL is clearly visible in a photo, READ the exact printed values and set "estimated" to false.\n' +
    '- Otherwise (only a front-of-pack photo, or just a name was given), ESTIMATE the typical nutrition per 100 g / 100 ml from your knowledge and set "estimated" to true. This works for BOTH branded packaged products (e.g. "Amul Butter") AND generic or home-cooked foods, dishes and recipes (e.g. "air fried chicken", "boiled egg", "grilled paneer", "chicken biryani"). For an ESTIMATE, always give values per 100 g and set "basisGrams" to 100. Only return calories 0 if the text is genuinely not a food/drink at all.\n' +
    'Always fill the "name" with a clean, readable food name.\n\n' +
    'CRITICAL — when READING a printed panel, follow these rules exactly:\n' +
    '1. Pick ONE data column and report every value EXACTLY AS PRINTED in that column — do NOT do any math or conversion yourself. ' +
    'Prefer a "per 100 g" / "per 100 ml" column if one exists. If the only amounts are per serving (e.g. the header says "Per 40 g serve", "per 30 g", "per serving (25 g)"), use that column.\n' +
    '2. Set "basisGrams" to the grams that your chosen column represents: 100 for a per-100g/ml column; the serving grams (e.g. 40, 30, 25, 60) if you used a per-serving column. The serving grams may be in the column header ("Per 40 g serve") OR stated separately as a "Serving size: 60 g" row while the amount column just says "Amount per serving" — in that case basisGrams = 60. If unsure, use 100.\n' +
    '3. NEVER read the "%DV", "%RDA" or "%" column as a value.\n' +
    '4. The panel may split nutrients across TWO side-by-side sub-columns under the same basis (e.g. Energy/Protein/Carb on the left, Total Fat/Sodium/Calcium on the right) — read rows from BOTH.\n' +
    '5. Map each row to the RIGHT field — do NOT mix them up:\n' +
    '   - "fat" = the TOTAL Fat row ONLY (never Saturated or Trans).\n' +
    '   - "saturatedFat" = Saturated Fat / SAFA row. "transFat" = Trans Fat row.\n' +
    '   - "carbs" = Total Carbohydrate row (never the Sugars row).\n' +
    '   - "sugar" = Total Sugars row (never Added Sugars). "addedSugar" = Added Sugars row.\n' +
    '   - "fiber" = Dietary Fibre. "sodium" = Sodium (mg). "cholesterol" = Cholesterol (mg). ' +
    '"calcium" = Calcium (mg). "iron" = Iron (mg).\n' +
    '6. Values like "<16.0", "≈", "Approx 25.0", "*" -> use just the number.\n' +
    '7. Use 0 for any value not printed. Numbers only, no units.\n' +
    'Example: a column headed "Per 40 g serve" with Energy 164, Protein 10 -> report calories:164, protein:10, basisGrams:40 (the app converts to per-100g itself).\n\n' +
    'Return ONLY JSON, no markdown, matching this schema exactly: ' +
    '{"name":string,"estimated":boolean,"servingSize":string,"basisGrams":number,"calories":number,"protein":number,"carbs":number,"fat":number,' +
    '"sugar":number,"addedSugar":number,"saturatedFat":number,"transFat":number,"fiber":number,' +
    '"sodium":number,"cholesterol":number,"calcium":number,"iron":number}.';

  var parts = [{ text: prompt }];
  for (var j = 0; j < imgs.length; j++) parts.push({ inline_data: { mime_type: mime, data: imgs[j] } });

  var payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 600,          // the 17-field schema pretty-printed (one field/line) needs headroom beyond a bare compact estimate, or Gemini truncates mid-object and JSON.parse fails
      thinkingConfig: { thinkingBudget: 0 }   // disable billed "thinking" tokens (Gemini 2.5)
    }
  };

  // Try the configured model, then fall back if Google has retired it OR if a
  // model is temporarily overloaded (503). Each model gets a couple of quick
  // retries with backoff before we move on to the next one.
  var models = dedupe([GEMINI_MODEL, 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash']);
  var txt = null, lastErr = '', usedModel = '', usage = null;
  outer:
  for (var i = 0; i < models.length; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + encodeURIComponent(key);
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
      var data = JSON.parse(resp.getContentText() || '{}');
      if (data.error) {
        lastErr = data.error.message || 'request failed';
        // Retired/unknown model: skip straight to the next model.
        if (/not found|not available|not supported|unsupported|retired|deprecated/i.test(lastErr)) continue outer;
        // Overloaded / rate-limited / transient: brief backoff, retry, then next model.
        if (resp.getResponseCode() >= 500 || resp.getResponseCode() === 429 || /overload|high demand|unavailable|try again|exhausted|rate/i.test(lastErr)) {
          if (attempt < 2) { Utilities.sleep(800 * (attempt + 1)); continue; }
          continue outer;
        }
        throw new Error('Gemini: ' + lastErr);
      }
      try { txt = data.candidates[0].content.parts[0].text; usedModel = models[i]; usage = data.usageMetadata || null; break outer; }
      catch (e) { lastErr = 'No response from the AI.'; break; }
    }
  }
  if (txt == null) throw new Error('Gemini is busy right now — please try again in a moment. (' + lastErr + ')');

  var p;
  try { p = JSON.parse(txt); }
  catch (e) {
    var m = txt.match(/\{[\s\S]*\}/);
    if (m) { try { p = JSON.parse(m[0]); } catch (e2) { p = null; } }
    // Still broken -> the response was very likely truncated mid-object (hit
    // maxOutputTokens before the closing brace). Repair it by dropping the
    // last, incomplete field and re-closing, retrying from the end backwards
    // until something parses, instead of surfacing a raw JSON.parse error.
    if (!p) {
      var open = txt.indexOf('{');
      if (open >= 0) {
        var body = txt.slice(open);
        var cut = body.lastIndexOf(',');
        while (cut > 0 && !p) {
          try { p = JSON.parse(body.slice(0, cut) + '}'); }
          catch (e3) { body = body.slice(0, cut); cut = body.lastIndexOf(','); }
        }
      }
    }
    if (!p) throw new Error('AI response was cut off — please try again.');
  }
  function n(x) { return Number(x) || 0; }
  // Values are reported as-printed for a column of `basisGrams` grams (e.g. 40 g serve).
  // Convert everything to per-100 g deterministically here (don't trust the model's math).
  var basis = Number(p.basisGrams) || 100;
  if (!(basis > 0) || basis > 1000) basis = 100;
  // An ESTIMATE is instructed to already be per-100 g; never rescale it. The
  // model sometimes fills basisGrams with a per-bar/per-serving size on a
  // front-of-pack estimate, which used to inflate everything (e.g. 522 kcal ->
  // 3480). Force a per-100 basis for estimates.
  if (p.estimated) basis = 100;
  var factor = 100 / basis;
  function conv(x, f, intval) { var v = n(x) * f; return intval ? Math.round(v) : Math.round(v * 10) / 10; }
  function build(f) {
    return {
      calories: conv(p.calories, f, true), protein: conv(p.protein, f), carbs: conv(p.carbs, f), fat: conv(p.fat, f), sugar: conv(p.sugar, f),
      addedSugar: conv(p.addedSugar, f), saturatedFat: conv(p.saturatedFat, f), transFat: conv(p.transFat, f),
      fiber: conv(p.fiber, f), sodium: conv(p.sodium, f, true), cholesterol: conv(p.cholesterol, f, true), calcium: conv(p.calcium, f, true), iron: conv(p.iron, f)
    };
  }
  var vals = build(factor);
  // Sanity guard: per-100 g values can't break physics. If protein+carbs+fat
  // exceed ~100 g or energy tops ~900 kcal, basisGrams was wrong and inflated
  // the result — fall back to treating the model's numbers as already per-100 g.
  var macroSum = vals.protein + vals.carbs + vals.fat;
  if (vals.calories > 902 || macroSum > 101) { basis = 100; vals = build(1); }
  var result = {
    name: String(p.name || ''), estimated: !!p.estimated, servingSize: String(p.servingSize || ''),
    basisGrams: basis,
    calories: vals.calories, protein: vals.protein, carbs: vals.carbs, fat: vals.fat, sugar: vals.sugar,
    addedSugar: vals.addedSugar, saturatedFat: vals.saturatedFat, transFat: vals.transFat,
    fiber: vals.fiber, sodium: vals.sodium, cholesterol: vals.cholesterol, calcium: vals.calcium, iron: vals.iron
  };
  try { logScan(body, usedModel, imgs.length, usage, result.name, 'food'); } catch (e) { /* logging must never break a scan */ }
  return result;
}

/* Record one scan in the ScanLog sheet with its token usage and estimated cost. */
function logScan(body, model, imageCount, usage, name, kind) {
  var promptTok = usage ? (Number(usage.promptTokenCount) || 0) : 0;
  var outTok = usage ? (Number(usage.candidatesTokenCount) || 0) : 0;
  var totalTok = usage ? (Number(usage.totalTokenCount) || (promptTok + outTok)) : 0;
  var price = GEMINI_PRICES[model] || { in: 0.10, out: 0.40 };
  var costUsd = (promptTok / 1e6) * price.in + (outTok / 1e6) * price.out;
  var rate = Number(PropertiesService.getScriptProperties().getProperty('USD_INR')) || 86;
  var costInr = costUsd * rate;
  var sheet = getSheet(SCAN_SHEET, SCAN_HEADERS);
  sheet.appendRow([
    Utilities.getUuid(), new Date().toISOString(), normalizeUsername(body.username), String(name || ''),
    model, imageCount, promptTok, outTok, totalTok,
    Math.round(costUsd * 1e6) / 1e6, Math.round(costInr * 1000) / 1000, String(kind || 'food')
  ]);
}

/* ---------------- Screen Time analysis (sleep + phone usage) ----------------
 * Reads iOS/Android "Screen Time" / "Digital Wellbeing" day screenshots and
 * infers, per day: total phone usage, category + top-app breakdown, and the
 * overnight SLEEP window from the long low-usage stretch in the hourly chart. */
function handleParseScreenTime(body) {
  authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI scanner not set up (missing GEMINI_API_KEY).');
  var mime = String(body.mime || 'image/jpeg');
  var imgs = [];
  if (body.images && body.images.length) { for (var k = 0; k < body.images.length; k++) { if (body.images[k]) imgs.push(String(body.images[k])); } }
  else if (body.image) imgs.push(String(body.image));
  if (!imgs.length) throw new Error('No screenshot received.');
  var todayIso = String(body.todayIso || todayStr());

  var prompt =
    'You analyse "Screen Time" (iOS) or "Digital Wellbeing" (Android) DAY-view screenshots. ' +
    'Each screenshot is ONE day. Today\'s date is ' + todayIso + ' — use it to resolve relative labels ' +
    '("Today", "Yesterday") and to infer the correct year for dates like "17 July".\n\n' +
    'For EACH screenshot, read:\n' +
    '- "date": the day shown, as YYYY-MM-DD.\n' +
    '- "totalMinutes": total screen time that day, converted to minutes (e.g. "9h 3m" = 543).\n' +
    '- "categories": array of {"name","minutes"} from the category totals (Social, Entertainment, Productivity & Finance, Creativity, etc.).\n' +
    '- "topApps": array of {"name","minutes"} from the "Most Used" list.\n' +
    '- SLEEP from the HOURLY usage bar chart (x-axis 12 AM, 6 AM, 12 PM, 6 PM). ' +
    'Sleep is the single LONGEST continuous overnight stretch (roughly between 9 PM and 11 AM) where the hourly bars are empty or near-zero. ' +
    'Return "sleepStart" and "sleepEnd" as 24h "HH:MM" (sleepStart is the evening the person fell asleep, sleepEnd the morning they woke), ' +
    '"sleepMinutes" as the duration in minutes, and "sleepConfidence" 0..1 (lower if the overnight bars are noisy or the chart is unclear). ' +
    'If the chart is missing or unreadable, set sleep fields to 0/empty and sleepConfidence 0.\n\n' +
    'Return ONLY JSON (no markdown): {"days":[{"date":"YYYY-MM-DD","totalMinutes":number,' +
    '"categories":[{"name":string,"minutes":number}],"topApps":[{"name":string,"minutes":number}],' +
    '"sleepStart":"HH:MM","sleepEnd":"HH:MM","sleepMinutes":number,"sleepConfidence":number,"note":string}]}.';

  var parts = [{ text: prompt }];
  for (var j = 0; j < imgs.length; j++) parts.push({ inline_data: { mime_type: mime, data: imgs[j] } });
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1600, thinkingConfig: { thinkingBudget: 0 } }
  };
  // Screenshots need the stronger vision model; fall back if unavailable.
  var res = geminiGenerate(key, payload, ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  var parsed;
  try { parsed = JSON.parse(res.text); }
  catch (e) { var m = res.text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { days: [] }; }

  var days = (parsed.days || []).map(function (d) {
    function toMin(v) { return Math.max(0, Math.round(Number(v) || 0)); }
    var cats = (d.categories || []).filter(function (c) { return c && c.name; })
      .map(function (c) { return { name: String(c.name).slice(0, 40), minutes: toMin(c.minutes) }; });
    var apps = (d.topApps || []).filter(function (a) { return a && a.name; })
      .map(function (a) { return { name: String(a.name).slice(0, 40), minutes: toMin(a.minutes) }; });
    var date = formatDate(String(d.date || ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';
    return {
      date: date, totalMinutes: toMin(d.totalMinutes), categories: cats, topApps: apps,
      sleepStart: String(d.sleepStart || ''), sleepEnd: String(d.sleepEnd || ''),
      sleepMinutes: toMin(d.sleepMinutes), sleepConfidence: Math.max(0, Math.min(1, Number(d.sleepConfidence) || 0)),
      note: String(d.note || '').slice(0, 200)
    };
  }).filter(function (d) { return d.date || d.totalMinutes; });

  try { logScan(body, res.model, imgs.length, res.usage, '📱 Screen Time (' + days.length + ' day' + (days.length === 1 ? '' : 's') + ')', 'screentime'); } catch (e) {}
  return { days: days };
}

/* ---------------- Admin dashboard ---------------- */

function requireAdmin(body) {
  var user = authUser(body);
  if (ADMIN_USERS.indexOf(user.username) < 0) throw new Error('Admin access only.');
  return user;
}

function handleAdminScans(body) {
  requireAdmin(body);
  var rows = getSheet(SCAN_SHEET, SCAN_HEADERS).getDataRange().getValues();
  var idx = colIndex(SCAN_HEADERS);
  var monthPrefix = new Date().toISOString().slice(0, 7);   // YYYY-MM
  var totalInr = 0, totalUsd = 0, monthInr = 0, count = 0, tokens = 0;
  var byUser = {}, byModel = {}, byKind = {}, recent = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[idx.at]) continue;
    count++;
    var inr = Number(r[idx.costInr]) || 0, usd = Number(r[idx.costUsd]) || 0;
    totalInr += inr; totalUsd += usd; tokens += Number(r[idx.totalTokens]) || 0;
    if (String(r[idx.at]).slice(0, 7) === monthPrefix) monthInr += inr;
    var u = String(r[idx.username] || 'unknown');
    if (!byUser[u]) byUser[u] = { username: u, scans: 0, costInr: 0 };
    byUser[u].scans++; byUser[u].costInr += inr;
    var m = String(r[idx.model] || '?');
    if (!byModel[m]) byModel[m] = { model: m, scans: 0, costInr: 0 };
    byModel[m].scans++; byModel[m].costInr += inr;
    var kind = String(r[idx.kind] || 'food') || 'food';
    if (!byKind[kind]) byKind[kind] = { kind: kind, scans: 0, costInr: 0, monthInr: 0 };
    byKind[kind].scans++; byKind[kind].costInr += inr;
    if (String(r[idx.at]).slice(0, 7) === monthPrefix) byKind[kind].monthInr += inr;
    recent.push({
      at: String(r[idx.at]), username: u, name: String(r[idx.name] || ''),
      model: m, images: Number(r[idx.images]) || 1, kind: kind,
      tokens: Number(r[idx.totalTokens]) || 0, costInr: Math.round(inr * 1000) / 1000
    });
  }
  recent.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  function arr(o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return b.costInr - a.costInr; }); }
  return {
    totalScans: count,
    totalCostInr: Math.round(totalInr * 100) / 100,
    totalCostUsd: Math.round(totalUsd * 1e5) / 1e5,
    monthCostInr: Math.round(monthInr * 100) / 100,
    avgCostInr: count ? Math.round((totalInr / count) * 1000) / 1000 : 0,
    avgTokens: count ? Math.round(tokens / count) : 0,
    byUser: arr(byUser), byModel: arr(byModel), byKind: arr(byKind),
    recent: recent.slice(0, 50)
  };
}

function handleAdminUsers(body) {
  requireAdmin(body);
  var today = todayStr();
  var users = getSheet(USERS_SHEET, USER_HEADERS).getDataRange().getValues();
  var uIdx = colIndex(USER_HEADERS);

  var logRows = getSheet(LOGS_SHEET, LOG_HEADERS).getDataRange().getValues();
  var lIdx = colIndex(LOG_HEADERS);
  var logsByUser = {};
  for (var a = 1; a < logRows.length; a++) {
    var un = normalizeUsername(logRows[a][lIdx.username]);
    if (!un) continue;
    (logsByUser[un] = logsByUser[un] || []).push(logFromRow(logRows[a], lIdx));
  }
  var foodRows = getSheet(FOOD_SHEET, FOOD_HEADERS).getDataRange().getValues();
  var fIdx = colIndex(FOOD_HEADERS);
  var foodCount = {};
  for (var b = 1; b < foodRows.length; b++) {
    var fu = normalizeUsername(foodRows[b][fIdx.username]);
    if (fu) foodCount[fu] = (foodCount[fu] || 0) + 1;
  }

  var out = [];
  for (var i = 1; i < users.length; i++) {
    var u = users[i];
    var name = normalizeUsername(u[uIdx.username]);
    if (!name) continue;
    var logs = (logsByUser[name] || []).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var start = formatDate(u[uIdx.startDate]);
    var doneDates = {};
    logs.forEach(function (l) { if (l.completed && l.date >= start && l.date <= today) doneDates[l.date] = true; });
    var lastActive = logs.length ? logs[logs.length - 1].date : '';
    var todayLog = logs.filter(function (l) { return l.date === today; })[0];
    out.push({
      username: name,
      displayName: u[uIdx.displayName] || name,
      startDate: start,
      createdAt: String(u[uIdx.createdAt] || ''),
      email: String(u[uIdx.email] || ''),
      currentDay: dayNumberFor(u[uIdx.startDate], today),
      completedDays: Object.keys(doneDates).length,
      streak: currentStreak(logs),
      lastActive: lastActive,
      todayDone: todayLog ? tasksDoneCount(todayLog) : 0,
      foodLogs: foodCount[name] || 0,
      isAdmin: ADMIN_USERS.indexOf(name) >= 0
    });
  }
  out.sort(function (a, b) { return (b.lastActive || '').localeCompare(a.lastActive || ''); });
  return { users: out, total: out.length };
}

function handleAdminFoods(body) {
  requireAdmin(body);
  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[idx.name]) continue;
    out.push({
      id: String(r[idx.id]), name: String(r[idx.name]),
      kcal: Number(r[idx.kcal]) || 0, protein: Number(r[idx.protein]) || 0,
      carbs: Number(r[idx.carbs]) || 0, fat: Number(r[idx.fat]) || 0, sugar: Number(r[idx.sugar]) || 0,
      satFat: Number(r[idx.satFat]) || 0, transFat: Number(r[idx.transFat]) || 0,
      fiber: Number(r[idx.fiber]) || 0, addedSugar: Number(r[idx.addedSugar]) || 0,
      sodium: Number(r[idx.sodium]) || 0, cholesterol: Number(r[idx.cholesterol]) || 0,
      calcium: Number(r[idx.calcium]) || 0, iron: Number(r[idx.iron]) || 0,
      servingSize: String(r[idx.servingSize] || ''),
      createdBy: String(r[idx.createdBy] || ''), createdAt: String(r[idx.createdAt] || '')
    });
  }
  out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
  return { foods: out, total: out.length };
}

function handleAdminUpdateFood(body) {
  requireAdmin(body);
  var id = String(body.id || '');
  if (!id) throw new Error('Food id required.');
  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) !== id) continue;
    var numCols = ['kcal', 'protein', 'carbs', 'fat', 'sugar', 'satFat', 'transFat', 'fiber',
                   'addedSugar', 'sodium', 'cholesterol', 'calcium', 'iron'];
    numCols.forEach(function (c) {
      if (body[c] !== undefined && body[c] !== '') sheet.getRange(i + 1, idx[c] + 1).setValue(Number(body[c]) || 0);
    });
    if (body.name !== undefined && String(body.name).trim()) sheet.getRange(i + 1, idx.name + 1).setValue(String(body.name).trim());
    if (body.servingSize !== undefined) sheet.getRange(i + 1, idx.servingSize + 1).setValue(String(body.servingSize));
    return { ok: true, id: id };
  }
  throw new Error('Food not found.');
}

function handleAdminDeleteFood(body) {
  requireAdmin(body);
  var id = String(body.id || '');
  if (!id) throw new Error('Food id required.');
  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id) { sheet.deleteRow(i + 1); return { ok: true, id: id }; }
  }
  throw new Error('Food not found.');
}
function dedupe(arr) { var s = {}, o = []; arr.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }

/* ---------------- AI Coach (Gemini chat over this user's data) ---------------- */

// Generic Gemini text call with the same model fallback + retry as the scanner.
function geminiGenerate(key, payload, models) {
  models = dedupe(models || ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  var lastErr = '';
  for (var i = 0; i < models.length; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + encodeURIComponent(key);
    for (var attempt = 0; attempt < 3; attempt++) {
      var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
      var data = JSON.parse(resp.getContentText() || '{}');
      if (data.error) {
        lastErr = data.error.message || 'request failed';
        if (/not found|not available|not supported|unsupported|retired|deprecated/i.test(lastErr)) break;
        if (resp.getResponseCode() >= 500 || resp.getResponseCode() === 429 || /overload|high demand|unavailable|try again|exhausted|rate/i.test(lastErr)) {
          if (attempt < 2) { Utilities.sleep(800 * (attempt + 1)); continue; }
          break;
        }
        throw new Error('Gemini: ' + lastErr);
      }
      try { return { text: data.candidates[0].content.parts[0].text, model: models[i], usage: data.usageMetadata || null }; }
      catch (e) { lastErr = 'No response from the AI.'; break; }
    }
  }
  throw new Error('Coach is busy right now — please try again in a moment.');
}

function handleCoachChat(body) {
  var user = authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI coach not set up (missing GEMINI_API_KEY).');
  var message = String(body.message || '').trim();
  if (!message) throw new Error('Type a message.');
  var history = body.history || [];

  var context = buildCoachContext(user.username, user.displayName);
  var system = 'You are "Coach", a friendly, motivating but honest 75 Hard fitness & nutrition coach inside a tracking app. ' +
    'You are talking to ' + (user.displayName || user.username) + '. ' +
    'Use the DATA below (their real tracked numbers) plus general fitness & nutrition knowledge. ' +
    'Reference their actual numbers when relevant. Keep replies concise, practical and encouraging — a few short paragraphs or bullets, not an essay. ' +
    'You may discuss diet, workouts, water, sleep, fasting, streaks, motivation and habit-building. ' +
    'Do NOT give medical diagnoses or treatment; for medical concerns advise seeing a professional. ' +
    'Never invent tracked data you were not given; if something is not in the data, say so.\n\n' +
    '=== THIS USER\'S DATA (as of today) ===\n' + context;

  var contents = [];
  contents.push({ role: 'user', parts: [{ text: system }] });
  contents.push({ role: 'model', parts: [{ text: 'Understood — I have ' + (user.displayName || 'your') + '\'s latest stats. Ready to help.' }] });
  (history || []).slice(-8).forEach(function (m) {
    contents.push({ role: (m.role === 'model' ? 'model' : 'user'), parts: [{ text: String(m.text || '').slice(0, 2000) }] });
  });
  contents.push({ role: 'user', parts: [{ text: message.slice(0, 2000) }] });

  var payload = {
    contents: contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } }
  };
  var res = geminiGenerate(key, payload, ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  try { logScan(body, res.model, 0, res.usage, '💬 Coach chat', 'coach'); } catch (e) {}
  return { reply: String(res.text || '').trim() };
}

// Compact, current snapshot of one user's tracked data for the coach prompt.
function buildCoachContext(username, displayName) {
  var today = todayStr();
  function daysAgoStr(n) { var d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  var weekAgo = daysAgoStr(7);
  var monthAgo = daysAgoStr(30);   // covers "last 4 weeks"-style questions, not just the last 7 days

  var usheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(usheet, username);
  var uIdx = colIndex(USER_HEADERS);
  var start = found ? formatDate(found.values[uIdx.startDate]) : today;
  var day = dayNumberFor(start, today);

  var prof = {};
  var profRows = getSheet(PROFILE_SHEET, PROFILE_HEADERS).getDataRange().getValues();
  for (var i = 1; i < profRows.length; i++) {
    if (normalizeUsername(profRows[i][0]) === username) { try { prof = JSON.parse(profRows[i][1] || '{}'); } catch (e) {} break; }
  }

  var logRows = getSheet(LOGS_SHEET, LOG_HEADERS).getDataRange().getValues();
  var lIdx = colIndex(LOG_HEADERS);
  var logs = [];
  for (var a = 1; a < logRows.length; a++) {
    if (normalizeUsername(logRows[a][lIdx.username]) === username) logs.push(logFromRow(logRows[a], lIdx));
  }
  logs.sort(function (x, y) { return x.date < y.date ? -1 : 1; });
  var done = {}; logs.forEach(function (l) { if (l.completed && l.date >= start && l.date <= today) done[l.date] = true; });
  var elapsed = Math.max(1, logs.length);
  function pct(k) { return Math.round(logs.filter(function (l) { return l[k]; }).length / elapsed * 100); }
  var waterPct = Math.round(logs.filter(function (l) { return Number(l.waterMl) >= WATER_GOAL_ML; }).length / elapsed * 100);
  var GUT_WORDS = { 1: 'no bowel movement', 2: 'hard/constipated', 3: 'healthy/formed', 4: 'soft', 5: 'loose/watery' };
  var recent = logs.slice(-7).map(function (l) {
    return l.date + ': ' + tasksDoneCount(l) + '/7' + (l.completed ? ' done' : '') +
      ', water ' + (Math.round((Number(l.waterMl) || 0) / 100) / 10) + 'L' + (l.mood ? (', mood ' + l.mood + '/5') : '') +
      (l.gut ? (', gut ' + (GUT_WORDS[l.gut] || '')) : '');
  });

  // Fetch a 30-day window once, then derive both a 7-day AND a ~30-day
  // average from it — so the coach can correctly answer both "this week"
  // and "last month" style questions instead of only ever seeing 7 days.
  var foodRows = getSheet(FOOD_SHEET, FOOD_HEADERS).getDataRange().getValues();
  var fIdx = colIndex(FOOD_HEADERS);
  var byDate = {};
  for (var b = 1; b < foodRows.length; b++) {
    if (normalizeUsername(foodRows[b][fIdx.username]) !== username) continue;
    var dt = formatDate(foodRows[b][fIdx.date]); if (dt < monthAgo) continue;
    var e = byDate[dt] || (byDate[dt] = { cal: 0, p: 0, c: 0, f: 0, s: 0 });
    e.cal += Number(foodRows[b][fIdx.calories]) || 0; e.p += Number(foodRows[b][fIdx.protein]) || 0;
    e.c += Number(foodRows[b][fIdx.carbs]) || 0; e.f += Number(foodRows[b][fIdx.fat]) || 0; e.s += Number(foodRows[b][fIdx.sugar]) || 0;
  }
  function avgDiet(fromDate) {
    var days = Object.keys(byDate).filter(function (k) { return k >= fromDate; }).sort();
    var out = { n: days.length, cal: 0, p: 0, c: 0, f: 0, s: 0 };
    if (!days.length) return out;
    days.forEach(function (k) { out.cal += byDate[k].cal; out.p += byDate[k].p; out.c += byDate[k].c; out.f += byDate[k].f; out.s += byDate[k].s; });
    out.cal = Math.round(out.cal / days.length); out.p = Math.round(out.p / days.length);
    out.c = Math.round(out.c / days.length); out.f = Math.round(out.f / days.length); out.s = Math.round(out.s / days.length);
    return out;
  }
  var diet7 = avgDiet(weekAgo), diet30 = avgDiet(monthAgo);

  var fastRows = getSheet(FAST_SHEET, FAST_HEADERS).getDataRange().getValues();
  var faIdx = colIndex(FAST_HEADERS);
  var durs = [];
  for (var c = 1; c < fastRows.length; c++) {
    if (normalizeUsername(fastRows[c][faIdx.username]) !== username) continue;
    var s0 = fastRows[c][faIdx.startAt], en = fastRows[c][faIdx.endAt];
    if (s0 && en) { var h = (new Date(en) - new Date(s0)) / 3.6e6; if (h > 0 && h < 48) durs.push(h); }
  }
  var avgFast = durs.length ? Math.round(durs.reduce(function (a2, b2) { return a2 + b2; }, 0) / durs.length * 10) / 10 : 0;

  var lines = [];
  lines.push('Name: ' + (displayName || username));
  lines.push('Challenge: Day ' + day + ' of 75, started ' + start + ', ' + Object.keys(done).length + ' days fully completed, current streak ' + currentStreak(logs) + '.');
  lines.push('Goals/body: calorie goal ' + (prof.calorieGoal || '?') + ' kcal/day, protein ' + (prof.proteinGoal || '?') + 'g, carbs ' + (prof.carbGoal || '?') + 'g, fat ' + (prof.fatGoal || '?') + 'g, sugar limit ' + (prof.sugarGoal || '?') + 'g; weight ' + (prof.weightKg || '?') + 'kg, height ' + (prof.heightCm || '?') + 'cm, age ' + (prof.age || '?') + ', sex ' + (prof.sex || '?') + ', activity ' + (prof.activity || '?') + ', aim ' + (prof.goalType || '?') + '.');
  lines.push('Task consistency (over ' + elapsed + ' logged days): indoor workout ' + pct('workout1') + '%, outdoor ' + pct('outdoor') + '%, reading ' + pct('reading') + '%, photo ' + pct('photo') + '%, diet ' + pct('diet') + '%, no-alcohol ' + pct('noAlcohol') + '%, water goal ' + waterPct + '%.');
  if (diet7.n) lines.push('Diet, last 7 days (avg over ' + diet7.n + ' logged days): ' + diet7.cal + ' kcal, ' + diet7.p + 'g protein, ' + diet7.c + 'g carbs, ' + diet7.f + 'g fat, ' + diet7.s + 'g sugar per day.');
  if (diet30.n) lines.push('Diet, last 30 days / ~4 weeks (avg over ' + diet30.n + ' logged days): ' + diet30.cal + ' kcal, ' + diet30.p + 'g protein, ' + diet30.c + 'g carbs, ' + diet30.f + 'g fat, ' + diet30.s + 'g sugar per day.');
  if (!diet7.n && !diet30.n) lines.push('Diet: no food logged in the last 30 days.');
  if (avgFast) lines.push('Fasting: average ' + avgFast + 'h over ' + durs.length + ' completed fasts.');
  if (recent.length) lines.push('Recent days:\n  ' + recent.join('\n  '));
  return lines.join('\n');
}


/* Run this from the editor after setting the script properties to verify the key. */
function testFatSecret() {
  var token = fatsecretToken();
  Logger.log(token ? 'Token OK' : 'No credentials set in Script properties');
  if (token) Logger.log(JSON.stringify(fatsecretSearch('amul butter')));
}

/* Run this a bunch of times (over a day) to discover the outbound IPs Apps
 * Script uses, then add each unique one to FatSecret's IP whitelist slots. */
function myOutboundIp() {
  var resp = UrlFetchApp.fetch('https://api.ipify.org', { muteHttpExceptions: true });
  Logger.log('Outbound IP: ' + resp.getContentText());
  return resp.getContentText();
}

function handleFoodSummary(body) {
  var user = authUser(body);
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  var tot = { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 }, days = {};
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== user.username) continue;
    tot.cal += Number(values[i][idx.calories]) || 0;
    tot.p += Number(values[i][idx.protein]) || 0;
    tot.c += Number(values[i][idx.carbs]) || 0;
    tot.f += Number(values[i][idx.fat]) || 0;
    tot.s += Number(values[i][idx.sugar]) || 0;
    tot.fb += Number(values[i][idx.fiber]) || 0;
    days[formatDate(values[i][idx.date])] = true;
  }
  var n = Object.keys(days).length;
  function avg(v) { return n ? Math.round(v / n) : 0; }
  return {
    totalCalories: Math.round(tot.cal), daysLogged: n, avgCalories: avg(tot.cal),
    avgProtein: avg(tot.p), avgCarbs: avg(tot.c), avgFat: avg(tot.f), avgSugar: avg(tot.s), avgFiber: avg(tot.fb)
  };
}

function foodFromRow(r, idx) {
  return {
    id: String(r[idx.id]),
    date: formatDate(r[idx.date]),
    meal: String(r[idx.meal]),
    name: String(r[idx.name]),
    grams: Number(r[idx.grams]) || 0,
    calories: Number(r[idx.calories]) || 0,
    protein: Number(r[idx.protein]) || 0,
    carbs: Number(r[idx.carbs]) || 0,
    fat: Number(r[idx.fat]) || 0,
    sugar: Number(r[idx.sugar]) || 0,
    fiber: Number(r[idx.fiber]) || 0
  };
}

function round1(v) { var n = Number(v) || 0; return Math.round(n * 10) / 10; }

function handleSaveDay(body) {
  var user = authUser(body);
  var day = body.day || {};
  var date = String(day.date || todayStr());

  var sheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var idx = colIndex(LOG_HEADERS);

  var record = {
    username: user.username,
    date: date,
    dayNumber: Number(day.dayNumber) || dayNumberFor(user.startDate, date),
    workout1: !!day.workout1,
    workout2: !!day.workout2,
    outdoor: !!day.outdoor,
    waterMl: Number(day.waterMl) || 0,
    reading: !!day.reading,
    photo: !!day.photo,
    diet: !!day.diet,
    noAlcohol: !!day.noAlcohol,
    notes: String(day.notes || ''),
    extra: JSON.stringify(day.extra || {}),
    mood: Number(day.mood) || 0,
    gut: Number(day.gut) || 0,
    biz: JSON.stringify(day.biz || {}),
    metrics: JSON.stringify(day.metrics || {})
  };
  // Honour the client's own verdict when it sends one. isDayComplete is the
  // hard-coded original 75 Hard predicate (all 7 tasks + 4 L), which cannot
  // score any other challenge: it ignores noCig (an `extra` flag it never
  // reads), assumes a 4 L water goal, and knows nothing about habit, manual or
  // metric rules or a pass-threshold. Being the ONLY writer of this column, it
  // was silently re-scoring every saved day — including days from a finished
  // run under a different rule set — against a challenge that may never have
  // applied. Older clients that omit the field still fall back to it.
  record.completed = (day.completed != null) ? !!day.completed : isDayComplete(record);
  record.updatedAt = new Date().toISOString();

  var rowValues = LOG_HEADERS.map(function (h) { return record[h]; });

  var existing = findLogRow(sheet, user.username, date);
  if (existing) {
    sheet.getRange(existing.row, 1, 1, LOG_HEADERS.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  return { day: record };
}

function handleReset(body) {
  var user = authUser(body);
  var newStart = normIso(body.startDate) || todayStr();

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, user.username);
  var idx = colIndex(USER_HEADERS);
  setStartDateCell(sheet, found.row, idx.startDate + 1, newStart);

  return { user: publicUser(user.username, user.displayName, newStart, user.email, user.emailVerified), logs: getUserLogs(user.username) };
}

/* Writes a start date as PLAIN TEXT so Google Sheets never converts it to a
 * date serial (which is what was corrupting years to ~2000). */
function setStartDateCell(sheet, row, col, isoDate) {
  sheet.getRange(row, col).setNumberFormat('@').setValue(String(isoDate));
}

/* Returns a clean yyyy-MM-dd string for a plausible date, else null. */
function normIso(s) {
  if (s == null || s === '') return null;
  var str = formatDate(s);                 // handles Date objects + slices strings
  var p = str.split('-');
  if (p.length === 3 && p[0].length === 4) {
    var y = Number(p[0]);
    if (y >= 2024 && y <= 2100) return p[0] + '-' + pad2(p[1]) + '-' + pad2(p[2]);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return null;
}
function pad2(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

/* ----------------------------------------------------------------------- *
 *  MAINTENANCE — run once from the Apps Script editor to repair accounts.
 *  Edit the date below, pick this function in the toolbar, click Run.
 *  It rewrites EVERY user's start date (as text) so corrupted year-2000
 *  dates are fixed in one shot.
 * ----------------------------------------------------------------------- */
function setAllStartDates() {
  var ISO_DATE = '2026-06-16';   // <-- change to your real Day 1, then Run
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var idx = colIndex(USER_HEADERS);
  var last = sheet.getLastRow();
  for (var r = 2; r <= last; r++) {
    setStartDateCell(sheet, r, idx.startDate + 1, ISO_DATE);
  }
}

/* ONE-SHOT REPAIR for the year-2000 bug.
 * For every user whose start date is corrupt (year < 2024), this sets the
 * start date to NEW_START (as text) AND shifts that user's broken (year<2024)
 * day-logs onto the matching new dates, so completed days are preserved.
 * Edit NEW_START to your real Day 1, then Run this once. */
function healStartAndLogs() {
  var NEW_START = '2026-06-16';   // <-- your real Day 1

  var usersSheet = getSheet(USERS_SHEET, USER_HEADERS);
  var uidx = colIndex(USER_HEADERS);
  var users = usersSheet.getDataRange().getValues();

  var logsSheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var lidx = colIndex(LOG_HEADERS);
  var logVals = logsSheet.getDataRange().getValues();

  for (var u = 1; u < users.length; u++) {
    var name = normalizeUsername(users[u][uidx.username]);
    if (!name) continue;
    var oldStart = formatDate(users[u][uidx.startDate]);
    if (Number(oldStart.split('-')[0]) >= 2024) continue;   // already fine
    var offset = daysBetweenIso(oldStart, NEW_START);

    for (var r = 1; r < logVals.length; r++) {
      if (normalizeUsername(logVals[r][lidx.username]) !== name) continue;
      var d = formatDate(logVals[r][lidx.date]);
      if (Number(d.split('-')[0]) >= 2024) continue;        // only shift broken logs
      var nd = addDaysIso(d, offset);
      logsSheet.getRange(r + 1, lidx.date + 1).setNumberFormat('@').setValue(nd);
      logVals[r][lidx.date] = nd;
    }
    setStartDateCell(usersSheet, u + 1, uidx.startDate + 1, NEW_START);
  }
}

function daysBetweenIso(aIso, bIso) {
  return Math.round((parseDate(bIso) - parseDate(aIso)) / 86400000);
}
function addDaysIso(iso, n) {
  var d = parseDate(iso); d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}



function handleUpdateProfile(body) {
  var user = authUser(body);
  var displayName = String(body.displayName || user.displayName).trim() || user.displayName;

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, user.username);
  var idx = colIndex(USER_HEADERS);
  sheet.getRange(found.row, idx.displayName + 1).setValue(displayName);

  return { user: publicUser(user.username, displayName, user.startDate, user.email, user.emailVerified) };
}

function handleDeleteAccount(body) {
  var user = authUser(body);
  var usersSheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(usersSheet, user.username);
  if (!found) throw new Error('Account not found.');

  // Require the correct password before destroying anything.
  var uidx = colIndex(USER_HEADERS);
  if (hashPassword(String(body.password || ''), found.values[uidx.salt]) !== found.values[uidx.passwordHash]) {
    throw new Error('Password is incorrect.');
  }

  deleteRowsFor(getSheet(LOGS_SHEET, LOG_HEADERS), colIndex(LOG_HEADERS).username, user.username);
  deleteRowsFor(getSheet(FOOD_SHEET, FOOD_HEADERS), colIndex(FOOD_HEADERS).username, user.username);
  deleteRowsFor(getSheet(FAST_SHEET, FAST_HEADERS), colIndex(FAST_HEADERS).username, user.username);
  deleteRowsFor(getSheet(PROFILE_SHEET, PROFILE_HEADERS), 0, user.username);

  // Re-find the user row (indexes are stable here) and remove it last.
  usersSheet.deleteRow(found.row);
  return { deleted: true };
}

function deleteRowsFor(sheet, usernameCol, username) {
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][usernameCol]) === username) sheet.deleteRow(i + 1);
  }
}

function handleLeaderboard(body) {
  var me = authUser(body); // friends feed = me + my accepted friends
  var today = todayStr();

  // Only show this user and people they're friends with.
  var visible = friendsOf(me.username);
  visible[me.username] = true;

  var users = getSheet(USERS_SHEET, USER_HEADERS).getDataRange().getValues();
  var uIdx = colIndex(USER_HEADERS);

  // Read each sheet once and bucket by username (avoids per-user full scans).
  var logRows = getSheet(LOGS_SHEET, LOG_HEADERS).getDataRange().getValues();
  var lIdx = colIndex(LOG_HEADERS);
  var logsByUser = {};
  for (var a = 1; a < logRows.length; a++) {
    var un = normalizeUsername(logRows[a][lIdx.username]);
    if (!un) continue;
    (logsByUser[un] = logsByUser[un] || []).push(logFromRow(logRows[a], lIdx));
  }

  var foodRows = getSheet(FOOD_SHEET, FOOD_HEADERS).getDataRange().getValues();
  var fIdx = colIndex(FOOD_HEADERS);
  var calToday = {};
  for (var b = 1; b < foodRows.length; b++) {
    if (formatDate(foodRows[b][fIdx.date]) !== today) continue;
    var fu = normalizeUsername(foodRows[b][fIdx.username]);
    calToday[fu] = (calToday[fu] || 0) + (Number(foodRows[b][fIdx.calories]) || 0);
  }

  var profRows = getSheet(PROFILE_SHEET, PROFILE_HEADERS).getDataRange().getValues();
  var goalByUser = {}, modeByUser = {};
  for (var c = 1; c < profRows.length; c++) {
    var pu = normalizeUsername(profRows[c][0]);
    try {
      var pj = JSON.parse(profRows[c][1] || '{}');
      goalByUser[pu] = pj.calorieGoal || 0;
      modeByUser[pu] = { mode: pj.mode === 'soft' ? 'soft' : 'hard', target: Number(pj.softTarget) || 70 };
    } catch (e) { goalByUser[pu] = 0; modeByUser[pu] = { mode: 'hard', target: 70 }; }
  }

  var board = [];
  for (var i = 1; i < users.length; i++) {
    var u = users[i];
    var name = normalizeUsername(u[uIdx.username]);
    if (!name || !visible[name]) continue;
    var um = modeByUser[name] || { mode: 'hard', target: 70 };
    var logs = (logsByUser[name] || []).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var todayLog = logs.filter(function (l) { return l.date === today; })[0];
    // Count distinct goal-met days within the challenge window (per the user's mode).
    var startDay = formatDate(u[uIdx.startDate]);
    var doneDates = {};
    logs.forEach(function (l) {
      if (logGoalMet(l, um.mode, um.target) && l.date >= startDay && l.date <= today) doneDates[l.date] = true;
    });
    board.push({
      displayName: u[uIdx.displayName] || name,
      currentDay: dayNumberFor(u[uIdx.startDate], today),
      completedDays: Object.keys(doneDates).length,
      streak: currentStreak(logs, um.mode, um.target),
      todayDone: todayLog ? tasksDoneCount(todayLog) : 0,
      todayTotal: 7,
      todayComplete: todayLog ? logGoalMet(todayLog, um.mode, um.target) : false,
      todayWaterMl: todayLog ? (Number(todayLog.waterMl) || 0) : 0,
      todayCalories: Math.round(calToday[name] || 0),
      calorieGoal: goalByUser[name] || 0,
      mode: um.mode, softTarget: um.target
    });
  }
  board.sort(function (a, b) { return b.completedDays - a.completedDays || b.todayDone - a.todayDone; });
  return { leaderboard: board };
}

/* ---------------- Friends ---------------- */

// Map of usernames who are ACCEPTED friends of `username` (either direction).
function friendsOf(username) {
  var sheet = getSheet(FRIEND_SHEET, FRIEND_HEADERS);
  var rows = sheet.getDataRange().getValues();
  var idx = colIndex(FRIEND_HEADERS);
  var out = {};
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.status]) !== 'accepted') continue;
    var r = normalizeUsername(rows[i][idx.requester]), a = normalizeUsername(rows[i][idx.addressee]);
    if (r === username && a) out[a] = true;
    else if (a === username && r) out[r] = true;
  }
  return out;
}

// Find the relationship row between two users (either direction). Returns {row, values} or null.
function findFriendRow(rows, idx, u1, u2) {
  for (var i = 1; i < rows.length; i++) {
    var r = normalizeUsername(rows[i][idx.requester]), a = normalizeUsername(rows[i][idx.addressee]);
    if ((r === u1 && a === u2) || (r === u2 && a === u1)) return { row: i + 1, values: rows[i], i: i };
  }
  return null;
}

function displayNameOf(username) {
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, username);
  var idx = colIndex(USER_HEADERS);
  return found ? (found.values[idx.displayName] || username) : username;
}

function handleSearchUsers(body) {
  var me = authUser(body);
  var q = normalizeUsername(body.query).replace(/[^a-z0-9 ]/g, '');
  var qRaw = String(body.query || '').trim().toLowerCase();
  if (qRaw.length < 2) return { users: [] };

  var users = getSheet(USERS_SHEET, USER_HEADERS).getDataRange().getValues();
  var uIdx = colIndex(USER_HEADERS);
  var frows = getSheet(FRIEND_SHEET, FRIEND_HEADERS).getDataRange().getValues();
  var fIdx = colIndex(FRIEND_HEADERS);

  var out = [];
  for (var i = 1; i < users.length && out.length < 20; i++) {
    var un = normalizeUsername(users[i][uIdx.username]);
    if (!un || un === me.username) continue;
    var dn = String(users[i][uIdx.displayName] || un);
    if (un.indexOf(qRaw) < 0 && dn.toLowerCase().indexOf(qRaw) < 0) continue;
    var rel = 'none';
    var fr = findFriendRow(frows, fIdx, me.username, un);
    if (fr) {
      if (String(fr.values[fIdx.status]) === 'accepted') rel = 'friend';
      else rel = normalizeUsername(fr.values[fIdx.requester]) === me.username ? 'outgoing' : 'incoming';
    }
    out.push({ username: un, displayName: dn, relation: rel });
  }
  return { users: out };
}

function handleGetFriends(body) {
  var me = authUser(body);
  var rows = getSheet(FRIEND_SHEET, FRIEND_HEADERS).getDataRange().getValues();
  var idx = colIndex(FRIEND_HEADERS);
  var friends = [], incoming = [], outgoing = [];
  for (var i = 1; i < rows.length; i++) {
    var r = normalizeUsername(rows[i][idx.requester]), a = normalizeUsername(rows[i][idx.addressee]);
    var status = String(rows[i][idx.status]);
    if (r !== me.username && a !== me.username) continue;
    var other = r === me.username ? a : r;
    if (!other) continue;
    var entry = { username: other, displayName: displayNameOf(other) };
    if (status === 'accepted') friends.push(entry);
    else if (status === 'pending') { if (a === me.username) incoming.push(entry); else outgoing.push(entry); }
  }
  return { friends: friends, incoming: incoming, outgoing: outgoing };
}

function handleAddFriend(body) {
  var me = authUser(body);
  var to = normalizeUsername(body.to);
  if (!to) throw new Error('Pick a user to add.');
  if (to === me.username) throw new Error("You can't add yourself.");
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  if (!findUserRow(sheet, to)) throw new Error('That user does not exist.');

  var fsheet = getSheet(FRIEND_SHEET, FRIEND_HEADERS);
  var rows = fsheet.getDataRange().getValues();
  var idx = colIndex(FRIEND_HEADERS);
  var existing = findFriendRow(rows, idx, me.username, to);
  var now = new Date().toISOString();
  if (existing) {
    var st = String(existing.values[idx.status]);
    if (st === 'accepted') return { status: 'friend' };
    // If THEY already requested ME, accept it; otherwise it's already pending from me.
    if (normalizeUsername(existing.values[idx.addressee]) === me.username) {
      fsheet.getRange(existing.row, idx.status + 1).setValue('accepted');
      fsheet.getRange(existing.row, idx.updatedAt + 1).setValue(now);
      return { status: 'friend' };
    }
    return { status: 'outgoing' };
  }
  fsheet.appendRow([Utilities.getUuid(), me.username, to, 'pending', now, now]);
  return { status: 'outgoing' };
}

function handleRespondFriend(body) {
  var me = authUser(body);
  var from = normalizeUsername(body.from);
  var accept = !!body.accept;
  var fsheet = getSheet(FRIEND_SHEET, FRIEND_HEADERS);
  var rows = fsheet.getDataRange().getValues();
  var idx = colIndex(FRIEND_HEADERS);
  for (var i = 1; i < rows.length; i++) {
    var r = normalizeUsername(rows[i][idx.requester]), a = normalizeUsername(rows[i][idx.addressee]);
    if (r === from && a === me.username && String(rows[i][idx.status]) === 'pending') {
      if (accept) {
        fsheet.getRange(i + 1, idx.status + 1).setValue('accepted');
        fsheet.getRange(i + 1, idx.updatedAt + 1).setValue(new Date().toISOString());
        return { status: 'friend' };
      }
      fsheet.deleteRow(i + 1);
      return { status: 'declined' };
    }
  }
  throw new Error('No pending request from that user.');
}

function handleRemoveFriend(body) {
  var me = authUser(body);
  var other = normalizeUsername(body.username);
  var fsheet = getSheet(FRIEND_SHEET, FRIEND_HEADERS);
  var rows = fsheet.getDataRange().getValues();
  var idx = colIndex(FRIEND_HEADERS);
  var hit = findFriendRow(rows, idx, me.username, other);
  if (hit) { fsheet.deleteRow(hit.row); return { status: 'removed' }; }
  return { status: 'none' };
}

function tasksDoneCount(l) {
  var c = 0;
  ['workout1', 'outdoor', 'reading', 'photo', 'diet', 'noAlcohol'].forEach(function (k) {
    if (l[k]) c++;
  });
  if (Number(l.waterMl) >= WATER_GOAL_ML) c++;
  return c;
}

/* ---------------- Generic per-user lists (Money, Subs, Savings, Tasks, Goals) ----------------
 * One CRUD for all list-style apps. Each 'kind' maps to its own sheet + fields.
 * ------------------------------------------------------------------------------------------ */
var LIST_KINDS = {
  expense: { sheet: 'Expenses', fields: ['date', 'amount', 'category', 'note'] },
  sub:     { sheet: 'Subs',     fields: ['name', 'amount', 'cycle', 'renewDay', 'active'] },
  saving:  { sheet: 'Savings',  fields: ['name', 'target', 'saved'] },
  task:    { sheet: 'Tasks',    fields: ['title', 'due', 'priority', 'done'] },
  goal:    { sheet: 'Goals',    fields: ['title', 'status', 'note'] }
};
function listHeaders(kind) { return ['id', 'username'].concat(LIST_KINDS[kind].fields).concat(['createdAt', 'updatedAt']); }
function listKind(kind) { var k = LIST_KINDS[kind]; if (!k) throw new Error('Unknown list kind.'); return k; }
function listSheetFor(kind) { return getSheet(listKind(kind).sheet, listHeaders(kind)); }
function listRowToObj(r, idx, k) {
  var o = { id: String(r[idx.id]) };
  k.fields.forEach(function (f) { o[f] = r[idx[f]]; });
  o.createdAt = String(r[idx.createdAt] || '');
  return o;
}

function handleListGet(body) {
  var user = authUser(body);
  var kind = String(body.kind || ''); var k = listKind(kind);
  var sheet = listSheetFor(kind);
  var rows = sheet.getDataRange().getValues();
  var idx = colIndex(listHeaders(kind));
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (normalizeUsername(rows[i][idx.username]) !== user.username) continue;
    out.push(listRowToObj(rows[i], idx, k));
  }
  return { items: out };
}
function handleListAdd(body) {
  var user = authUser(body);
  var kind = String(body.kind || ''); var k = listKind(kind);
  var sheet = listSheetFor(kind); var headers = listHeaders(kind);
  var it = body.item || {}, now = new Date().toISOString();
  var rec = { id: Utilities.getUuid(), username: user.username, createdAt: now, updatedAt: now };
  k.fields.forEach(function (f) { rec[f] = (it[f] !== undefined && it[f] !== null) ? it[f] : ''; });
  sheet.appendRow(headers.map(function (h) { return rec[h]; }));
  return { item: rec };
}
function handleListUpdate(body) {
  var user = authUser(body);
  var kind = String(body.kind || ''); var k = listKind(kind);
  var id = String(body.id || ''); if (!id) throw new Error('id required.');
  var sheet = listSheetFor(kind); var idx = colIndex(listHeaders(kind));
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.id]) === id && normalizeUsername(rows[i][idx.username]) === user.username) {
      var it = body.item || {};
      k.fields.forEach(function (f) { if (it[f] !== undefined) sheet.getRange(i + 1, idx[f] + 1).setValue(it[f]); });
      sheet.getRange(i + 1, idx.updatedAt + 1).setValue(new Date().toISOString());
      return { ok: true, id: id };
    }
  }
  throw new Error('Item not found.');
}
function handleListDelete(body) {
  var user = authUser(body);
  var kind = String(body.kind || ''); listKind(kind);
  var id = String(body.id || '');
  var sheet = listSheetFor(kind); var idx = colIndex(listHeaders(kind));
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.id]) === id && normalizeUsername(rows[i][idx.username]) === user.username) {
      sheet.deleteRow(i + 1); return { ok: true, id: id };
    }
  }
  return { ok: true, id: id };
}

/* ============================================================================
 *  MONEY MANAGER — full expense tracker (accounts, categories, transactions,
 *  budget guard-ladder, AI screenshot/SMS parsing, "Penny" coach chat).
 *  Reuses this app's existing auth, getProfile/saveGoals, geminiGenerate and
 *  logScan — only the money-specific data model is new.
 * ========================================================================== */

var MONEY_ACCOUNTS_SHEET = 'MoneyAccounts';
var MONEY_CAT_SHEET = 'MoneyCategories';
var MONEY_TXN_SHEET = 'MoneyTxns';
var MONEY_ACCOUNT_HEADERS = ['id', 'username', 'name', 'type', 'issuer', 'last4', 'creditLimit',
                             'billingCycleDay', 'openingBalance', 'color', 'archived', 'createdAt'];
var MONEY_CAT_HEADERS = ['id', 'username', 'name', 'group', 'kind', 'icon', 'color', 'archived', 'createdAt'];
var MONEY_TXN_HEADERS = ['id', 'username', 'date', 'amount', 'type', 'accountId', 'categoryId',
                         'merchant', 'note', 'source', 'tags', 'createdAt', 'updatedAt', 'clientId'];

// group, name, kind (need|want|saving|income|transfer), icon, color
var MONEY_DEFAULT_CATEGORIES = [
  ['Food & Dining',    'Groceries',             'need',  '🛒', '#16a34a'],
  ['Food & Dining',    'Restaurants',           'want',  '🍽️', '#f59e0b'],
  ['Food & Dining',    'Online Delivery',       'want',  '🛵', '#ef4444'],
  ['Food & Dining',    'Cafe & Coffee',         'want',  '☕', '#a16207'],
  ['Transport',        'Fuel',                  'need',  '⛽', '#0ea5e9'],
  ['Transport',        'Cabs / Ride-share',     'want',  '🚕', '#38bdf8'],
  ['Transport',        'Public Transport',      'need',  '🚌', '#0284c7'],
  ['Transport',        'Vehicle / Parking',     'need',  '🅿️', '#075985'],
  ['Entertainment',    'Movies',                'want',  '🎬', '#8b5cf6'],
  ['Entertainment',    'OTT / Subscriptions',   'want',  '📺', '#a855f7'],
  ['Entertainment',    'Events & Outings',      'want',  '🎟️', '#c084fc'],
  ['Shopping',         'Clothing',              'want',  '👕', '#ec4899'],
  ['Shopping',         'Electronics',           'want',  '🎧', '#db2777'],
  ['Shopping',         'General Shopping',      'want',  '🛍️', '#be185d'],
  ['Health',           'Pharmacy',              'need',  '💊', '#14b8a6'],
  ['Health',           'Doctor / Medical',      'need',  '🩺', '#0d9488'],
  ['Health',           'Gym / Fitness',         'want',  '🏋️', '#0f766e'],
  ['Bills & Utilities','Rent / EMI',            'need',  '🏠', '#64748b'],
  ['Bills & Utilities','Electricity / Water',   'need',  '💡', '#475569'],
  ['Bills & Utilities','Internet / Mobile',     'need',  '📶', '#334155'],
  ['Personal',         'Personal Care',         'want',  '💇', '#eab308'],
  ['Personal',         'Education',             'need',  '📚', '#3b82f6'],
  ['Travel',           'Travel & Hotels',       'want',  '✈️', '#06b6d4'],
  ['Pets',             'Pet Food & Supplies',   'want',  '🐾', '#f97316'],
  ['Pets',             'Vet & Pet Care',        'need',  '🐶', '#fb923c'],
  ['Money',            'Savings & Investments', 'saving','📈', '#10b981'],
  ['Money',            'Insurance',             'need',  '🛡️', '#059669'],
  ['Income',           'Income',                'income','💰', '#22c55e'],
  ['Transfers',        'Transfer / Card Payment','transfer','🔁','#94a3b8'],
  ['Other',            'Miscellaneous',         'want',  '📦', '#6b7280']
];

function moneySeedDefaults(username) {
  var sheet = getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS);
  var rows = MONEY_DEFAULT_CATEGORIES.map(function (c) {
    return [Utilities.getUuid(), username, c[1], c[0], c[2], c[3], c[4], false, new Date().toISOString()];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MONEY_CAT_HEADERS.length).setValues(rows);
}
function moneyEnsureDefaults(username) {
  var sheet = getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(MONEY_CAT_HEADERS);
  var have = {};
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username) have[String(values[i][idx.name]).toLowerCase()] = true;
  }
  var add = [];
  MONEY_DEFAULT_CATEGORIES.forEach(function (c) {
    if (!have[c[1].toLowerCase()]) add.push([Utilities.getUuid(), username, c[1], c[0], c[2], c[3], c[4], false, new Date().toISOString()]);
  });
  if (add.length) sheet.getRange(sheet.getLastRow() + 1, 1, add.length, MONEY_CAT_HEADERS.length).setValues(add);
}

function moneyGetAccounts(username) {
  var sheet = getSheet(MONEY_ACCOUNTS_SHEET, MONEY_ACCOUNT_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(MONEY_ACCOUNT_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== username) continue;
    if (toBool(values[i][idx.archived])) continue;
    out.push(moneyAccountFromRow(values[i], idx));
  }
  return out;
}
function moneyAccountFromRow(r, idx) {
  return {
    id: String(r[idx.id]), name: String(r[idx.name]), type: String(r[idx.type] || 'bank'),
    issuer: String(r[idx.issuer] || ''), last4: String(r[idx.last4] || ''),
    creditLimit: Number(r[idx.creditLimit]) || 0, billingCycleDay: Number(r[idx.billingCycleDay]) || 0,
    openingBalance: Number(r[idx.openingBalance]) || 0, color: String(r[idx.color] || '#3b82f6')
  };
}
function moneyGetCategories(username) {
  var sheet = getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(MONEY_CAT_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== username) continue;
    if (toBool(values[i][idx.archived])) continue;
    out.push(moneyCatFromRow(values[i], idx));
  }
  return out;
}
function moneyCatFromRow(r, idx) {
  return {
    id: String(r[idx.id]), name: String(r[idx.name]), group: String(r[idx.group] || 'Other'),
    kind: String(r[idx.kind] || 'want'), icon: String(r[idx.icon] || '📦'), color: String(r[idx.color] || '#6b7280')
  };
}

function moneyGetBudget(username) {
  var m = getProfile(username).money || {};
  return { limit: Number(m.limit) || 0, perCategory: m.perCategory || {}, monthlyIncome: Number(m.monthlyIncome) || 0, savingsGoal: Number(m.savingsGoal) || 0 };
}
function moneySaveMoneyProfile(username, patch) {
  var prof = getProfile(username);
  prof.money = Object.assign({}, prof.money || {}, patch);
  var sheet = getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  var values = sheet.getDataRange().getValues();
  var json = JSON.stringify(prof);
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === username) { sheet.getRange(i + 1, 1, 1, 3).setValues([[username, json, new Date().toISOString()]]); return prof.money; }
  }
  sheet.appendRow([username, json, new Date().toISOString()]);
  return prof.money;
}

function handleMoneyGetState(body) {
  var user = authUser(body);
  var cats = moneyGetCategories(user.username);
  if (cats.length === 0) { moneySeedDefaults(user.username); cats = moneyGetCategories(user.username); }
  else moneyEnsureDefaults(user.username);
  var accounts = moneyGetAccounts(user.username);
  // One combined call: everything the Overview tab needs, computed from a single
  // Txns-sheet read (avoids the old getState -> dashboard double round-trip).
  var dash = moneyComputeDashboardAndStatus(user.username, moneyMonthStart(), todayStr(), cats, accounts);
  return {
    accounts: accounts, categories: cats, budget: moneyGetBudget(user.username),
    status: dash.status, dashboard: dash
  };
}

function handleMoneyAddAccount(body) {
  var user = authUser(body);
  var a = body.account || {};
  if (!String(a.name || '').trim()) throw new Error('Account name required.');
  var rec = {
    id: Utilities.getUuid(), username: user.username, name: String(a.name).trim().slice(0, 60),
    type: String(a.type || 'bank'), issuer: String(a.issuer || ''), last4: String(a.last4 || '').replace(/\D/g, '').slice(-4),
    creditLimit: Number(a.creditLimit) || 0, billingCycleDay: Number(a.billingCycleDay) || 0,
    openingBalance: Number(a.openingBalance) || 0, color: String(a.color || '#3b82f6'),
    archived: false, createdAt: new Date().toISOString()
  };
  getSheet(MONEY_ACCOUNTS_SHEET, MONEY_ACCOUNT_HEADERS).appendRow(MONEY_ACCOUNT_HEADERS.map(function (h) { return rec[h]; }));
  return { account: moneyAccountFromRow(MONEY_ACCOUNT_HEADERS.map(function (h) { return rec[h]; }), colIndex(MONEY_ACCOUNT_HEADERS)) };
}
function handleMoneyUpdateAccount(body) {
  var user = authUser(body);
  var a = body.account || {}; var id = String(a.id || '');
  var sheet = getSheet(MONEY_ACCOUNTS_SHEET, MONEY_ACCOUNT_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_ACCOUNT_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      ['name', 'type', 'issuer', 'last4', 'creditLimit', 'billingCycleDay', 'openingBalance', 'color'].forEach(function (f) {
        if (a[f] !== undefined) sheet.getRange(i + 1, idx[f] + 1).setValue(a[f]);
      });
      return { account: moneyAccountFromRow(sheet.getRange(i + 1, 1, 1, MONEY_ACCOUNT_HEADERS.length).getValues()[0], idx) };
    }
  }
  throw new Error('Account not found.');
}
function handleMoneyDeleteAccount(body) {
  var user = authUser(body); var id = String(body.id || '');
  var sheet = getSheet(MONEY_ACCOUNTS_SHEET, MONEY_ACCOUNT_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_ACCOUNT_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.getRange(i + 1, idx.archived + 1).setValue(true); return { deleted: id };
    }
  }
  return { deleted: null };
}

function handleMoneyAddCategory(body) {
  var user = authUser(body);
  var c = body.category || {};
  if (!String(c.name || '').trim()) throw new Error('Category name required.');
  var rec = {
    id: Utilities.getUuid(), username: user.username, name: String(c.name).trim().slice(0, 40),
    group: String(c.group || 'Other'), kind: String(c.kind || 'want'),
    icon: String(c.icon || '📦'), color: String(c.color || '#6b7280'), archived: false, createdAt: new Date().toISOString()
  };
  getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS).appendRow(MONEY_CAT_HEADERS.map(function (h) { return rec[h]; }));
  return { category: moneyCatFromRow(MONEY_CAT_HEADERS.map(function (h) { return rec[h]; }), colIndex(MONEY_CAT_HEADERS)) };
}
function handleMoneyUpdateCategory(body) {
  var user = authUser(body);
  var c = body.category || {}; var id = String(c.id || '');
  var sheet = getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_CAT_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      ['name', 'group', 'kind', 'icon', 'color'].forEach(function (f) {
        if (c[f] !== undefined) sheet.getRange(i + 1, idx[f] + 1).setValue(c[f]);
      });
      return { category: moneyCatFromRow(sheet.getRange(i + 1, 1, 1, MONEY_CAT_HEADERS.length).getValues()[0], idx) };
    }
  }
  throw new Error('Category not found.');
}
function handleMoneyDeleteCategory(body) {
  var user = authUser(body); var id = String(body.id || '');
  var sheet = getSheet(MONEY_CAT_SHEET, MONEY_CAT_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_CAT_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.getRange(i + 1, idx.archived + 1).setValue(true); return { deleted: id };
    }
  }
  return { deleted: null };
}

function moneyTxnFromRow(r, idx) {
  return {
    id: String(r[idx.id]), date: formatDate(r[idx.date]), amount: Number(r[idx.amount]) || 0,
    type: String(r[idx.type] || 'expense'), accountId: String(r[idx.accountId] || ''),
    categoryId: String(r[idx.categoryId] || ''), merchant: String(r[idx.merchant] || ''),
    note: String(r[idx.note] || ''), source: String(r[idx.source] || 'manual'),
    tags: String(r[idx.tags] || ''), createdAt: String(r[idx.createdAt] || '')
  };
}
function moneyBuildTxn(username, t) {
  var now = new Date().toISOString();
  return {
    id: Utilities.getUuid(), username: username, date: t.date ? formatDate(t.date) : todayStr(),
    amount: Math.abs(Number(t.amount) || 0),
    type: ['expense', 'income', 'transfer'].indexOf(t.type) >= 0 ? t.type : 'expense',
    accountId: String(t.accountId || ''), categoryId: String(t.categoryId || ''),
    merchant: String(t.merchant || '').slice(0, 120), note: String(t.note || '').slice(0, 300),
    source: String(t.source || 'manual'), tags: String(t.tags || ''),
    createdAt: now, updatedAt: now, clientId: String(t.clientId || '')
  };
}
function moneyFindByClientId(values, idx, username, clientId) {
  if (!clientId) return null;
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username && String(values[i][idx.clientId]) === clientId) return moneyTxnFromRow(values[i], idx);
  }
  return null;
}

function handleMoneyGetTxns(body) {
  var user = authUser(body);
  var from = body.from ? formatDate(body.from) : '0000-00-00';
  var to = body.to ? formatDate(body.to) : '9999-99-99';
  var limit = Number(body.limit) || 0;
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_TXN_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== user.username) continue;
    var d = formatDate(r[idx.date]); if (d < from || d > to) continue;
    out.push(moneyTxnFromRow(r, idx));
  }
  out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1); });
  if (limit > 0) out = out.slice(0, limit);
  return { transactions: out };
}
function handleMoneyAddTxn(body) {
  var user = authUser(body);
  var t = body.transaction || {};
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS); var idx = colIndex(MONEY_TXN_HEADERS);
  // Read the sheet once and reuse it for both the dedup check and the budget
  // recompute below.
  var values = sheet.getDataRange().getValues();
  if (t.clientId) {
    var dup = moneyFindByClientId(values, idx, user.username, String(t.clientId));
    if (dup) return { transaction: dup, status: moneyComputeBudgetStatus(user.username, values), duplicate: true };
  }
  var rec = moneyBuildTxn(user.username, t);
  var row = MONEY_TXN_HEADERS.map(function (h) { return rec[h]; });
  sheet.appendRow(row);
  values.push(row);   // keep the in-memory copy current for the status pass
  return { transaction: moneyTxnFromRow(row, idx), status: moneyComputeBudgetStatus(user.username, values) };
}
function handleMoneyAddTxns(body) {
  var user = authUser(body);
  var list = body.transactions || [];
  if (!list.length) return { added: 0, transactions: [] };
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS); var idx = colIndex(MONEY_TXN_HEADERS);
  var existing = sheet.getDataRange().getValues();
  var rows = [], objs = [];
  list.forEach(function (t) {
    if (t.clientId && moneyFindByClientId(existing, idx, user.username, String(t.clientId))) return;
    var rec = moneyBuildTxn(user.username, t);
    rows.push(MONEY_TXN_HEADERS.map(function (h) { return rec[h]; }));
    objs.push(moneyTxnFromRow(MONEY_TXN_HEADERS.map(function (h) { return rec[h]; }), idx));
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MONEY_TXN_HEADERS.length).setValues(rows);
  rows.forEach(function (r) { existing.push(r); });
  return { added: rows.length, transactions: objs, status: moneyComputeBudgetStatus(user.username, existing) };
}
function handleMoneyUpdateTxn(body) {
  var user = authUser(body);
  var t = body.transaction || {}; var id = String(t.id || '');
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_TXN_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      ['date', 'amount', 'type', 'accountId', 'categoryId', 'merchant', 'note', 'tags'].forEach(function (f) {
        if (t[f] === undefined) return;
        var v = t[f]; if (f === 'date') v = formatDate(v); if (f === 'amount') v = Math.abs(Number(v) || 0);
        sheet.getRange(i + 1, idx[f] + 1).setValue(v);
      });
      sheet.getRange(i + 1, idx.updatedAt + 1).setValue(new Date().toISOString());
      var fresh = sheet.getRange(i + 1, 1, 1, MONEY_TXN_HEADERS.length).getValues()[0];
      values[i] = fresh;   // reuse the rows we already read for the status pass
      return { transaction: moneyTxnFromRow(fresh, idx), status: moneyComputeBudgetStatus(user.username, values) };
    }
  }
  throw new Error('Transaction not found.');
}
function handleMoneyDeleteTxn(body) {
  var user = authUser(body); var id = String(body.id || '');
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_TXN_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.deleteRow(i + 1);
      values.splice(i, 1);   // reuse the rows we already read for the status pass
      return { deleted: id, status: moneyComputeBudgetStatus(user.username, values) };
    }
  }
  return { deleted: null };
}

function handleMoneyDashboard(body) {
  var user = authUser(body);
  var from = body.from ? formatDate(body.from) : moneyMonthStart();
  var to = body.to ? formatDate(body.to) : todayStr();
  return moneyComputeDashboardAndStatus(user.username, from, to, moneyGetCategories(user.username), moneyGetAccounts(user.username));
}

/* Single Txns-sheet read that produces BOTH the dashboard breakdown and the
 * budget guard-ladder status, so a full Money load only needs one round-trip
 * instead of two sequential ones (getState + dashboard). */
function moneyComputeDashboardAndStatus(username, from, to, catList0, acctList0) {
  var cats = {}; (catList0 || moneyGetCategories(username)).forEach(function (c) { cats[c.id] = c; });
  var accts = {}; (acctList0 || moneyGetAccounts(username)).forEach(function (a) { accts[a.id] = a; });
  var budget = moneyGetBudget(username);
  var limit = budget.limit;

  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_TXN_HEADERS);

  var monthFrom = moneyMonthStart(), today = todayStr();
  var totalSpend = 0, totalIncome = 0, count = 0;
  var byCategory = {}, byGroup = {}, byAccount = {}, byKind = { need: 0, want: 0, saving: 0 }, byMerchant = {};
  var monthSpent = 0, todaySpent = 0, monthPerCat = {};

  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== username) continue;
    var d = formatDate(r[idx.date]);
    var type = String(r[idx.type] || 'expense'); var amt = Number(r[idx.amount]) || 0;
    var cid = String(r[idx.categoryId] || '');

    // Budget guard-ladder always looks at THIS calendar month, regardless of the requested range.
    if (type === 'expense' && d >= monthFrom && d <= today) {
      monthSpent += amt; if (d === today) todaySpent += amt;
      monthPerCat[cid] = (monthPerCat[cid] || 0) + amt;
    }

    if (d < from || d > to) continue;
    if (type === 'transfer') continue;
    if (type === 'income') { totalIncome += amt; continue; }
    count++; totalSpend += amt;
    var cat = cats[cid] || { name: 'Uncategorised', group: 'Other', kind: 'want', color: '#6b7280', icon: '❓' };
    byCategory[cid] = (byCategory[cid] || 0) + amt;
    byGroup[cat.group] = (byGroup[cat.group] || 0) + amt;
    byKind[cat.kind] = (byKind[cat.kind] || 0) + amt;
    var aid = String(r[idx.accountId] || ''); byAccount[aid] = (byAccount[aid] || 0) + amt;
    var m = String(r[idx.merchant] || '').trim() || '(unknown)'; byMerchant[m] = (byMerchant[m] || 0) + amt;
  }

  function catList() {
    return Object.keys(byCategory).map(function (id) {
      var c = cats[id] || { name: 'Uncategorised', group: 'Other', kind: 'want', color: '#6b7280', icon: '❓' };
      return { id: id, name: c.name, group: c.group, kind: c.kind, icon: c.icon, color: c.color, total: money2(byCategory[id]) };
    }).sort(function (a, b) { return b.total - a.total; });
  }
  function groupList() {
    return Object.keys(byGroup).map(function (g) { return { group: g, total: money2(byGroup[g]) }; }).sort(function (a, b) { return b.total - a.total; });
  }
  function acctList() {
    return Object.keys(byAccount).map(function (id) {
      var a = accts[id] || { name: 'Unassigned', type: 'bank', color: '#94a3b8' };
      return { id: id, name: a.name, type: a.type, color: a.color, total: money2(byAccount[id]) };
    }).sort(function (a, b) { return b.total - a.total; });
  }
  function merchList() {
    return Object.keys(byMerchant).map(function (m) { return { merchant: m, total: money2(byMerchant[m]) }; })
      .sort(function (a, b) { return b.total - a.total; }).slice(0, 8);
  }

  var now = new Date();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var dayOfMonth = now.getDate();
  var daysLeft = Math.max(1, daysInMonth - dayOfMonth + 1);
  var pct = limit > 0 ? monthSpent / limit : 0;
  var level = 'none';
  if (limit > 0) { if (pct >= 1) level = 'stop'; else if (pct >= 0.85) level = 'critical'; else if (pct >= 0.70) level = 'warn'; else level = 'ok'; }
  var remaining = limit > 0 ? Math.max(0, limit - monthSpent) : 0;
  var safePerDay = limit > 0 ? remaining / daysLeft : 0;
  var pacedTarget = limit > 0 ? limit * (dayOfMonth / daysInMonth) : 0;
  var projection = dayOfMonth > 0 ? (monthSpent / dayOfMonth) * daysInMonth : 0;
  var catFlags = [];
  Object.keys(budget.perCategory || {}).forEach(function (cid) {
    var cap = Number(budget.perCategory[cid]) || 0; if (cap <= 0) return;
    var used = monthPerCat[cid] || 0;
    if (used >= cap * 0.85) catFlags.push({ categoryId: cid, used: money2(used), cap: cap, pct: money2(used / cap) });
  });
  var status = {
    limit: money2(limit), spent: money2(monthSpent), remaining: money2(remaining), pct: money2(pct), level: level,
    todaySpent: money2(todaySpent), daysLeft: daysLeft, daysInMonth: daysInMonth, dayOfMonth: dayOfMonth,
    safePerDay: money2(safePerDay), pacedTarget: money2(pacedTarget), overPace: money2(monthSpent - pacedTarget),
    projection: money2(projection), onTrack: limit > 0 ? projection <= limit : true, categoryFlags: catFlags
  };

  return {
    range: { from: from, to: to }, totalSpend: money2(totalSpend), totalIncome: money2(totalIncome), txnCount: count,
    byCategory: catList(), byGroup: groupList(), byAccount: acctList(),
    byKind: { need: money2(byKind.need), want: money2(byKind.want), saving: money2(byKind.saving) },
    topMerchants: merchList(), status: status
  };
}

function handleMoneySaveBudget(body) {
  var user = authUser(body);
  var patch = {
    limit: Number(body.overall) || 0, perCategory: body.perCategory || {},
    monthlyIncome: body.monthlyIncome !== undefined ? Number(body.monthlyIncome) || 0 : undefined,
    savingsGoal: body.savingsGoal !== undefined ? Number(body.savingsGoal) || 0 : undefined
  };
  Object.keys(patch).forEach(function (k) { if (patch[k] === undefined) delete patch[k]; });
  moneySaveMoneyProfile(user.username, patch);
  return { budget: moneyGetBudget(user.username), status: moneyComputeBudgetStatus(user.username) };
}

/* Budget guard-ladder: month-to-date spend vs limit, pace, safe-to-spend/day. */
// `values` is optional: pass the transaction rows in when the caller has
// already read them. Reading the whole sheet twice per write was doubling the
// slowest part of an add, which is what pushed saves past the client timeout.
function moneyComputeBudgetStatus(username, values) {
  var budget = moneyGetBudget(username);
  var limit = budget.limit;
  var from = moneyMonthStart(), to = todayStr();
  var idx = colIndex(MONEY_TXN_HEADERS);
  if (!values) values = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS).getDataRange().getValues();
  var spent = 0, todaySpent = 0, perCat = {};
  var today = todayStr();
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== username) continue;
    if (String(r[idx.type]) !== 'expense') continue;
    var d = formatDate(r[idx.date]); if (d < from || d > to) continue;
    var amt = Number(r[idx.amount]) || 0; spent += amt;
    if (d === today) todaySpent += amt;
    var cid = String(r[idx.categoryId] || ''); perCat[cid] = (perCat[cid] || 0) + amt;
  }
  var now = new Date();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var dayOfMonth = now.getDate();
  var daysLeft = Math.max(1, daysInMonth - dayOfMonth + 1);
  var pct = limit > 0 ? spent / limit : 0;
  var level = 'none';
  if (limit > 0) { if (pct >= 1) level = 'stop'; else if (pct >= 0.85) level = 'critical'; else if (pct >= 0.70) level = 'warn'; else level = 'ok'; }
  var remaining = limit > 0 ? Math.max(0, limit - spent) : 0;
  var safePerDay = limit > 0 ? remaining / daysLeft : 0;
  var pacedTarget = limit > 0 ? limit * (dayOfMonth / daysInMonth) : 0;
  var projection = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0;
  var catFlags = [];
  Object.keys(budget.perCategory || {}).forEach(function (cid) {
    var cap = Number(budget.perCategory[cid]) || 0; if (cap <= 0) return;
    var used = perCat[cid] || 0;
    if (used >= cap * 0.85) catFlags.push({ categoryId: cid, used: money2(used), cap: cap, pct: money2(used / cap) });
  });
  return {
    limit: money2(limit), spent: money2(spent), remaining: money2(remaining), pct: money2(pct), level: level,
    todaySpent: money2(todaySpent), daysLeft: daysLeft, daysInMonth: daysInMonth, dayOfMonth: dayOfMonth,
    safePerDay: money2(safePerDay), pacedTarget: money2(pacedTarget), overPace: money2(spent - pacedTarget),
    projection: money2(projection), onTrack: limit > 0 ? projection <= limit : true, categoryFlags: catFlags
  };
}

/* ---------------- Money AI: screenshot OCR, SMS parsing, Penny coach ---------------- */

function moneyExtractionPrompt(username) {
  var cats = moneyGetCategories(username);
  var catList = cats.map(function (c) { return c.name + ' [' + c.group + ']'; }).join(', ');
  var accts = moneyGetAccounts(username);
  var acctList = accts.length ? accts.map(function (a) { return a.name + (a.last4 ? ' (••' + a.last4 + ')' : '') + (a.issuer ? ' — ' + a.issuer : ''); }).join(', ') : '(none saved yet)';
  var today = todayStr();
  return 'You extract expense transactions for a personal money tracker (India-first, currency ₹ INR by default).\n' +
    'TODAY\'S DATE IS ' + today + '. You do NOT otherwise know the current date — always use this value as "today".\n' +
    'Categorise each transaction into the SINGLE best-fitting category NAME from this list (use the exact name):\n' + catList + '.\n' +
    'Rules:\n' +
    '- "type" is "expense" for money going out (debit/paid/spent), "income" for money received (credit/refund/salary), "transfer" for card bill payments or moving money between own accounts.\n' +
    '- Food ordered on Swiggy/Zomato/EatSure = "Online Delivery". Petrol/diesel/HP/IOC/Shell = "Fuel". Netflix/Prime/Hotstar/Spotify = "OTT / Subscriptions". BookMyShow/PVR/INOX = "Movies". Blinkit/Zepto/BigBasket groceries = "Groceries". Uber/Ola/Rapido = "Cabs / Ride-share".\n' +
    '- Pet food/treats/litter/toys (Supertails, Heads Up For Tails, Drools, Whiskas, Pedigree) = "Pet Food & Supplies". Vet visits/grooming/vaccinations = "Vet & Pet Care".\n' +
    '- "amount" is a positive number, no currency symbol or commas.\n' +
    '- "date" in YYYY-MM-DD. Only use a date ACTUALLY PRINTED in the image. If only day+month printed, use ' + today.slice(0, 4) + ' as year. If no date is printed, return "' + today + '". NEVER invent a date, never a year before ' + today.slice(0, 4) + ' unless explicitly printed.\n' +
    '- "merchant" = payee/shop/app name, cleaned up. "note" = anything useful (UPI ref).\n' +
    '- Also look for which bank account or card was used to pay: a bank/wallet name (e.g. HDFC, SBI, ICICI, Paytm, PhonePe, GPay/Google Pay, a specific credit card issuer), and/or the last 3-4 digits of an account/card number (often shown as "XX1234", "••1234", "ending 1234", or after "a/c"/"card"). ' +
    'Put the bank/issuer/wallet name in "accountHint" and any last-digits you find in "last4" (digits only, empty string if none visible). Leave both empty if genuinely not shown — never guess.\n' +
    'The user\'s SAVED ACCOUNTS/CARDS are: ' + acctList + '. If "accountHint"/"last4" clearly matches one of these, still just report what you SAW on the label/receipt — matching to a saved account happens separately, you do not need to pick from this list yourself.\n' +
    'Return ONLY JSON, no markdown: {"transactions":[{"date":"YYYY-MM-DD","amount":number,"type":"expense|income|transfer","category":string,"merchant":string,"note":string,"accountHint":string,"last4":string}]}. ' +
    'If nothing is a transaction, return {"transactions":[]}.';
}
function moneySanitizeDate(s) {
  var today = todayStr();
  if (!s) return today;
  var d = formatDate(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return today;
  if (d > today) return today;
  if (Number(d.slice(0, 4)) < Number(today.slice(0, 4)) - 1) return today;
  return d;
}
// Best-effort match of an AI-reported bank/card hint + last4 against the user's saved accounts.
// Prefers an exact last4 match; falls back to a name/issuer substring match. Returns '' if unsure.
function moneyMatchAccount(accts, hint, last4) {
  hint = String(hint || '').trim().toLowerCase();
  last4 = String(last4 || '').replace(/\D/g, '');
  if (last4 && last4.length >= 3) {
    var byDigits = accts.filter(function (a) { return a.last4 && a.last4 === last4.slice(-4); });
    if (byDigits.length === 1) return byDigits[0].id;
    if (byDigits.length > 1 && hint) {
      var narrowed = byDigits.filter(function (a) { return (a.name + ' ' + a.issuer).toLowerCase().indexOf(hint) >= 0; });
      if (narrowed.length) return narrowed[0].id;
    }
    if (byDigits.length >= 1) return byDigits[0].id;
  }
  if (hint) {
    var byName = accts.filter(function (a) { return (a.name + ' ' + a.issuer).toLowerCase().indexOf(hint) >= 0 || hint.indexOf(a.name.toLowerCase()) >= 0; });
    if (byName.length) return byName[0].id;
  }
  return '';
}
function moneyMapExtracted(username, list) {
  var cats = moneyGetCategories(username);
  var accts = moneyGetAccounts(username);
  var byName = {}; cats.forEach(function (c) { byName[c.name.toLowerCase()] = c.id; });
  var miscId = (cats.filter(function (c) { return c.name === 'Miscellaneous'; })[0] || cats[0] || {}).id || '';
  return (list || []).map(function (t) {
    var cid = byName[String(t.category || '').toLowerCase()] || miscId;
    var accountId = moneyMatchAccount(accts, t.accountHint, t.last4);
    return {
      date: moneySanitizeDate(t.date), amount: Math.abs(Number(t.amount) || 0),
      type: ['expense', 'income', 'transfer'].indexOf(t.type) >= 0 ? t.type : 'expense',
      categoryId: cid, category: t.category || '', accountId: accountId,
      merchant: String(t.merchant || '').slice(0, 120), note: String(t.note || '').slice(0, 300)
    };
  }).filter(function (t) { return t.amount > 0; });
}
function handleMoneyParseScreenshot(body) {
  var user = authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI scanner not set up (missing GEMINI_API_KEY).');
  var mime = String(body.mime || 'image/jpeg');
  var imgs = [];
  if (body.images && body.images.length) { for (var k = 0; k < body.images.length; k++) { if (body.images[k]) imgs.push(String(body.images[k])); } }
  else if (body.image) imgs.push(String(body.image));
  if (!imgs.length) throw new Error('No image received.');
  var prompt = moneyExtractionPrompt(user.username) +
    '\n\nThese are screenshots from a banking app, UPI app (GPay/PhonePe/Paytm), credit-card statement, or order history. Read EVERY transaction visible.';
  var parts = [{ text: prompt }];
  for (var j = 0; j < imgs.length; j++) parts.push({ inline_data: { mime_type: mime, data: imgs[j] } });
  var payload = { contents: [{ parts: parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } };
  var res = geminiGenerate(key, payload, ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  var parsed = moneySafeJson(res.text);
  var out = moneyMapExtracted(user.username, parsed.transactions || []);
  try { logScan(body, res.model, imgs.length, res.usage, '💰 Money scan (' + out.length + ')', 'money'); } catch (e) {}
  return { transactions: out };
}
function handleMoneyParseMessage(body) {
  var user = authUser(body);
  var text = String(body.text || '').trim();
  if (!text) throw new Error('Paste a transaction message.');
  var quick = moneyQuickParseSms(text);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    if (quick) return { transactions: moneyMapExtracted(user.username, [quick]), source: 'regex' };
    throw new Error('Could not read that automatically. Add the transaction manually.');
  }
  if (quick) return { transactions: moneyMapExtracted(user.username, [quick]), source: 'regex' };
  var prompt = moneyExtractionPrompt(user.username) +
    '\n\nParse the following bank / UPI / credit-card SMS or notification text. It may contain one or more transactions:\n"""\n' + text.slice(0, 4000) + '\n"""';
  var payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } } };
  var res = geminiGenerate(key, payload, ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  var parsed = moneySafeJson(res.text);
  var out = moneyMapExtracted(user.username, parsed.transactions || []);
  try { logScan(body, res.model, 0, res.usage, '💰 Money SMS (' + out.length + ')', 'money'); } catch (e) {}
  return { transactions: out, source: 'ai' };
}
function moneyQuickParseSms(text) {
  var t = text.replace(/\s+/g, ' ').trim();
  var amtM = t.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amtM) return null;
  var amount = Number(amtM[1].replace(/,/g, ''));
  if (!amount) return null;
  var isCredit = /credited|received|refund|deposit/i.test(t);
  var isDebit = /debited|spent|paid|withdrawn|purchase|deducted|sent/i.test(t);
  var type = isCredit && !isDebit ? 'income' : 'expense';
  var merch = '';
  var mM = t.match(/\b(?:to|at|towards|vpa|info:?)\s+([A-Za-z0-9 ._@&-]{2,40})/i);
  if (mM) merch = mM[1].replace(/\b(on|ref|upi|avl|bal|info).*$/i, '').trim();
  var date = todayStr();
  var dM = t.match(/\bon\s+(\d{4}-\d{2}-\d{2})/i) || t.match(/\bon\s+(\d{1,2}[\/\-][A-Za-z]{3}[\/\-]?\d{0,4})/i) || t.match(/\bon\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (dM) { var nd = formatDate(dM[1]); if (/^\d{4}-\d{2}-\d{2}$/.test(nd)) date = nd; }
  var last4 = '';
  var l4M = t.match(/[x*]{2,}\s*(\d{3,4})\b/i) || t.match(/\b(?:a\/c|acc(?:ount)?|card)\D{0,15}(\d{3,4})\b/i) || t.match(/ending\s*(?:in|with)?\s*(\d{3,4})\b/i);
  if (l4M) last4 = l4M[1];
  return { amount: amount, type: type, merchant: merch, category: moneyGuessCategory(t + ' ' + merch), note: t.slice(0, 200), date: date, accountHint: moneyGuessBank(t), last4: last4 };
}
function moneyGuessBank(s) {
  s = String(s).toLowerCase();
  var banks = ['hdfc', 'icici', 'sbi', 'axis', 'kotak', 'yes bank', 'indusind', 'idfc', 'pnb', 'canara',
    'bank of baroda', 'union bank', 'bank of india', 'federal bank', 'rbl', 'au bank', 'paytm', 'phonepe',
    'google pay', 'gpay', 'amazon pay', 'bhim'];
  for (var i = 0; i < banks.length; i++) if (s.indexOf(banks[i]) >= 0) return banks[i];
  return '';
}
function moneyGuessCategory(s) {
  s = String(s).toLowerCase();
  var rules = [
    [/swiggy|zomato|eatsure|eat sure|box8|faasos/, 'Online Delivery'],
    [/blinkit|zepto|bigbasket|big basket|instamart|dmart|d-mart|grofers|jiomart/, 'Groceries'],
    [/uber|ola |olacabs|rapido|namma yatri/, 'Cabs / Ride-share'],
    [/petrol|diesel|fuel|hpcl|iocl|bpcl|indian oil|bharat petroleum|hp |shell|essar/, 'Fuel'],
    [/service cent|car service|garage|workshop|puncture|tyre|automobile/, 'Vehicle / Parking'],
    [/netflix|prime video|hotstar|disney|spotify|youtube|sony liv|zee5|jiocinema|jio cinema|subscription/, 'OTT / Subscriptions'],
    [/bookmyshow|pvr|inox|cinema|cinepolis|movie/, 'Movies'],
    [/amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq/, 'General Shopping'],
    [/pharmacy|pharmeasy|apollo|1mg|netmeds|medplus|chemist|medical store/, 'Pharmacy'],
    [/hospital|clinic|diagnostic|lab |pathology|doctor/, 'Doctor / Medical'],
    [/dominos|pizza|mcdonald|kfc|burger|starbucks|cafe|coffee|restaurant|hotel |dhaba|biryani/, 'Restaurants'],
    [/electricity|power|mseb|bescom|adani electric|tata power|water bill/, 'Electricity / Water'],
    [/airtel|jio|vodafone|vi |bsnl|broadband|wifi|recharge/, 'Internet / Mobile'],
    [/rent|landlord|emi|loan/, 'Rent / EMI'],
    [/gym|cult|fitness|gold gym/, 'Gym / Fitness'],
    [/supertails|headsupfortails|heads up for tails|petsutra|drools|pedigree|whiskas|cat food|dog food|pet food|petshop|pet shop|pet supplies/, 'Pet Food & Supplies'],
    [/\bvet\b|veterinary|pet clinic|pet grooming/, 'Vet & Pet Care'],
    [/irctc|makemytrip|goibibo|ixigo|indigo|vistara|air india|oyo|airbnb|flight|hotel booking/, 'Travel & Hotels'],
    [/salary|credited by|neft cr|imps cr|interest/, 'Income']
  ];
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
  return '';
}
function moneySafeJson(txt) {
  try { return JSON.parse(txt); } catch (e) { var m = String(txt || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; }
}

function handleMoneyCoachChat(body) {
  var user = authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI coach not set up (missing GEMINI_API_KEY).');
  var message = String(body.message || '').trim();
  if (!message) throw new Error('Type a message.');
  var history = body.history || [];
  var context = moneyBuildCoachContext(user.username, user.displayName);
  var system = 'You are "Penny", a sharp, friendly Certified Financial Planner built into a personal expense-tracking app for an Indian user (currency ₹ INR). ' +
    'You are talking to ' + (user.displayName || user.username) + '. ' +
    'Use the DATA below (their real tracked spending) plus solid personal-finance principles (50/30/20 budgeting, needs vs wants, pay-yourself-first, cutting recurring leaks, emergency fund). ' +
    'Reference their actual numbers and categories when relevant. Be concrete: name the category, the amount, and a specific action. ' +
    'Keep replies concise and practical — short paragraphs or bullets, not an essay. Be encouraging but honest about overspending. ' +
    'When they are close to or over their monthly limit, help them slow down with specific cuts. Do NOT give regulated investment/tax advice; for those, suggest a licensed advisor. ' +
    'Never invent numbers you were not given; if it is not in the data, say so.\n\n' +
    '=== THIS USER\'S MONEY DATA ===\n' + context;
  var contents = [];
  contents.push({ role: 'user', parts: [{ text: system }] });
  contents.push({ role: 'model', parts: [{ text: 'Got it — I have ' + (user.displayName || 'your') + ' latest spending in front of me. Ready.' }] });
  (history || []).slice(-8).forEach(function (m) {
    contents.push({ role: (m.role === 'model' ? 'model' : 'user'), parts: [{ text: String(m.text || '').slice(0, 2000) }] });
  });
  contents.push({ role: 'user', parts: [{ text: message.slice(0, 2000) }] });
  var payload = { contents: contents, generationConfig: { temperature: 0.6, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } } };
  var res = geminiGenerate(key, payload, ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest']);
  try { logScan(body, res.model, 0, res.usage, '💬 Penny (money coach)', 'coach'); } catch (e) {}
  return { reply: String(res.text || '').trim() };
}
function moneyBuildCoachContext(username, displayName) {
  var status = moneyComputeBudgetStatus(username);
  var from = moneyMonthStart(), to = todayStr();
  var d90 = new Date(); d90.setDate(d90.getDate() - 90);
  var since90 = d90.getFullYear() + '-' + ('0' + (d90.getMonth() + 1)).slice(-2) + '-' + ('0' + d90.getDate()).slice(-2);
  var cats = {}; moneyGetCategories(username).forEach(function (c) { cats[c.id] = c; });
  var accts = {}; moneyGetAccounts(username).forEach(function (a) { accts[a.id] = a; });
  var sheet = getSheet(MONEY_TXN_SHEET, MONEY_TXN_HEADERS);
  var values = sheet.getDataRange().getValues(); var idx = colIndex(MONEY_TXN_HEADERS);
  // This-month totals (for the budget/guard-rail numbers) AND a rolling 90-day
  // by-month breakdown (so "how was last month" / "over the last few months"
  // can actually be answered instead of only ever seeing the current month).
  var byCat = {}, byKind = { need: 0, want: 0, saving: 0 }, byAcct = {}, income = 0, spend = 0;
  var byMonth = {};   // 'YYYY-MM' -> { spend, income }
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== username) continue;
    var d = formatDate(r[idx.date]); if (d < since90 || d > to) continue;
    var type = String(r[idx.type]); var amt = Number(r[idx.amount]) || 0;
    var ym = d.slice(0, 7);
    var mrec = byMonth[ym] || (byMonth[ym] = { spend: 0, income: 0 });
    if (type === 'income') { mrec.income += amt; if (d >= from) income += amt; continue; }
    if (type === 'transfer') continue;
    mrec.spend += amt;
    if (d < from) continue;   // the rest (categories/accounts) stay scoped to THIS month
    spend += amt;
    var c = cats[String(r[idx.categoryId])] || { name: 'Uncategorised', kind: 'want' };
    byCat[c.name] = (byCat[c.name] || 0) + amt; byKind[c.kind] = (byKind[c.kind] || 0) + amt;
    var a = accts[String(r[idx.accountId])] || { name: 'Unassigned' };
    byAcct[a.name] = (byAcct[a.name] || 0) + amt;
  }
  function top(o, n) {
    return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, n || 8).map(function (p) { return p[0] + ' ₹' + Math.round(p[1]); }).join(', ');
  }
  var monthsLine = Object.keys(byMonth).sort().map(function (ym) {
    return ym + ': spent ₹' + Math.round(byMonth[ym].spend) + ', income ₹' + Math.round(byMonth[ym].income);
  }).join(' | ');
  var budget = moneyGetBudget(username);
  var lines = [];
  lines.push('Name: ' + (displayName || username) + '. Monthly income (if set): ₹' + (budget.monthlyIncome || '?') + '. Savings goal: ₹' + (budget.savingsGoal || '?') + '/month.');
  lines.push('This month so far (' + from + ' to ' + to + '): spent ₹' + Math.round(spend) + ', income ₹' + Math.round(income) + '.');
  lines.push('Monthly limit: ₹' + status.limit + '. Spent ₹' + status.spent + ' (' + Math.round(status.pct * 100) + '%). Remaining ₹' + status.remaining + ' over ' + status.daysLeft + ' days = ₹' + status.safePerDay + '/day safe to spend. Projected month-end: ₹' + status.projection + '. Guard level: ' + status.level + '.');
  lines.push('Needs ₹' + Math.round(byKind.need) + ' / Wants ₹' + Math.round(byKind.want) + ' / Savings ₹' + Math.round(byKind.saving) + ' (target roughly 50/30/20) — this month.');
  lines.push('Top spend categories (this month): ' + (top(byCat, 8) || 'none yet') + '.');
  lines.push('By account/card (this month): ' + (top(byAcct, 6) || 'none') + '.');
  if (monthsLine) lines.push('Month-by-month, last ~90 days: ' + monthsLine + '.');
  return lines.join('\n');
}
function moneyMonthStart() { return todayStr().slice(0, 7) + '-01'; }
function money2(v) { var n = Number(v) || 0; return Math.round(n * 100) / 100; }

/* ----------------------------------------------------------------------- *
 *  Helpers — auth & users
 * ----------------------------------------------------------------------- */

function authUser(body) {
  var username = normalizeUsername(body.username);
  var token = String(body.token || '');
  if (!username || !token) throw new Error('Not authenticated. Please log in again.');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, username);
  var idx = colIndex(USER_HEADERS);
  if (!found || found.values[idx.token] !== token) {
    throw new Error('Session expired. Please log in again.');
  }
  return {
    username: username,
    displayName: found.values[idx.displayName],
    startDate: String(found.values[idx.startDate]),
    email: String(found.values[idx.email] || ''),
    emailVerified: toBool(found.values[idx.emailVerified]),
    row: found.row
  };
}

function publicUser(username, displayName, startDate, email, emailVerified) {
  return {
    username: username,
    displayName: displayName,
    startDate: formatDate(startDate),
    currentDay: dayNumberFor(startDate, todayStr()),
    challengeLength: CHALLENGE_LENGTH,
    waterGoalMl: WATER_GOAL_ML,
    email: email || '',
    emailVerified: !!emailVerified
  };
}

// Build a publicUser straight from a Users-sheet row.
function publicUserFromRow(row) {
  var idx = colIndex(USER_HEADERS);
  return publicUser(normalizeUsername(row[idx.username]), row[idx.displayName], row[idx.startDate],
    row[idx.email], toBool(row[idx.emailVerified]));
}

function findUserRow(sheet, username) {
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(USER_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username) {
      return { row: i + 1, values: values[i] };
    }
  }
  return null;
}

function hashPassword(password, salt) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + '::' + salt, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* ----------------------------------------------------------------------- *
 *  Helpers — logs
 * ----------------------------------------------------------------------- */

function getUserLogs(username) {
  var sheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(LOG_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== username) continue;
    out.push(logFromRow(r, idx));
  }
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

function logFromRow(r, idx) {
  return {
    date: formatDate(r[idx.date]),
    dayNumber: Number(r[idx.dayNumber]) || 0,
    workout1: toBool(r[idx.workout1]),
    workout2: toBool(r[idx.workout2]),
    outdoor: toBool(r[idx.outdoor]),
    waterMl: Number(r[idx.waterMl]) || 0,
    reading: toBool(r[idx.reading]),
    photo: toBool(r[idx.photo]),
    diet: toBool(r[idx.diet]),
    noAlcohol: toBool(r[idx.noAlcohol]),
    completed: toBool(r[idx.completed]),
    notes: String(r[idx.notes] || ''),
    extra: parseJsonObj(r[idx.extra]),
    mood: Number(r[idx.mood]) || 0,
    gut: Number(r[idx.gut]) || 0,
    biz: parseJsonObj(r[idx.biz]),
    metrics: parseJsonObj(r[idx.metrics])
  };
}
function parseJsonObj(v) {
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
}

// Every saveDay call — i.e. every field edit anywhere in the app, on any
// day — used to read the ENTIRE Logs sheet just to locate one row, including
// the extra/metrics/biz JSON blob columns (gym sets, habits, business data)
// for every OTHER row too. With weeks of daily logs that's a lot of wasted
// data pulled over the Apps Script/Sheets round-trip on every single save,
// and was pushing ordinary saves past the client's timeout. username and
// date are the first two columns, so one narrow 2-column read locates the
// row; the (possibly large) full row is only fetched for the match.
function findLogRow(sheet, username, date) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var idx = colIndex(LOG_HEADERS);
  var col0 = Math.min(idx.username, idx.date), col1 = Math.max(idx.username, idx.date);
  var key = sheet.getRange(2, col0 + 1, lastRow - 1, col1 - col0 + 1).getValues();
  var uOff = idx.username - col0, dOff = idx.date - col0;
  for (var i = 0; i < key.length; i++) {
    if (normalizeUsername(key[i][uOff]) === username && formatDate(key[i][dOff]) === date) {
      var row = i + 2;
      return { row: row, values: sheet.getRange(row, 1, 1, LOG_HEADERS.length).getValues()[0] };
    }
  }
  return null;
}

function isDayComplete(d) {
  return d.workout1 && d.outdoor && d.reading &&
         d.photo && d.diet && d.noAlcohol && (Number(d.waterMl) >= WATER_GOAL_ML);
}

// Tasks needed for a day to "count" under the given mode ('hard' = all 7).
function dayGoalCount(mode, target) {
  return mode === 'soft' ? Math.max(1, Math.ceil((Number(target) || 70) / 100 * 7)) : 7;
}
function logGoalMet(l, mode, target) {
  return tasksDoneCount(l) >= dayGoalCount(mode, target);
}

function currentStreak(logs, mode, target) {
  // Consecutive goal-met days ending today (or yesterday if today's in progress).
  var set = {};
  logs.forEach(function (l) { if (mode ? logGoalMet(l, mode, target) : l.completed) set[l.date] = true; });
  var d = parseDate(todayStr());
  if (!set[formatDate(d)]) d.setDate(d.getDate() - 1);
  var s = 0;
  while (set[formatDate(d)]) { s++; d.setDate(d.getDate() - 1); }
  return s;
}

/* ----------------------------------------------------------------------- *
 *  Helpers — sheets & utilities
 * ----------------------------------------------------------------------- */

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    // Backfill headers if columns were added after this sheet was first created
    // (e.g. CustomFoods gained the extra nutrition columns). Only the header row
    // is rewritten — data rows are untouched.
    var existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
    var needs = false;
    for (var i = 0; i < headers.length; i++) { if (String(existing[i] || '') !== String(headers[i])) { needs = true; break; } }
    if (needs) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function colIndex(headers) {
  var map = {};
  headers.forEach(function (h, i) { map[h] = i; });
  return map;
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function todayStr() {
  return formatDate(new Date());
}

function formatDate(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  // Already a yyyy-MM-dd string (or similar) — keep the date portion only.
  return String(d).slice(0, 10);
}

function dayNumberFor(startDate, date) {
  var start = parseDate(startDate);
  var d = parseDate(date);
  if (!start || !d) return 1;
  var diff = Math.floor((d - start) / 86400000) + 1;
  if (diff < 1) return 0;            // challenge hasn't started yet
  return diff;
}

function parseDate(s) {
  var str = formatDate(s);
  var parts = str.split('-');
  if (parts.length !== 3) return null;
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once manually to pre-create the sheets/headers (optional). */
function setup() {
  getSheet(USERS_SHEET, USER_HEADERS);
  getSheet(LOGS_SHEET, LOG_HEADERS);
  getSheet(FOOD_SHEET, FOOD_HEADERS);
  getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  getSheet(FAST_SHEET, FAST_HEADERS);
  getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
}
