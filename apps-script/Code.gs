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
var BACKEND_VERSION = '2.68.0';


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

/* ================= Google Health access =================
   The Google Health API REFUSES any token that also carries non-health scopes
   (its error: disallowed_scopes "maestro_external_request,maestro_scriptapp,
   wise" — Apps Script's own scopes plus Sheets). ScriptApp.getOAuthToken()
   always includes those, so this script cannot use its built-in token. It
   needs a separate access token minted from a refresh token that was granted
   ONLY the googlehealth.* scopes.

   Credentials live in Script Properties — never in this file:
     HEALTH_CLIENT_ID, HEALTH_CLIENT_SECRET, HEALTH_REFRESH_TOKEN */
function healthAccessToken() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('HEALTH_CLIENT_ID');
  var secret = props.getProperty('HEALTH_CLIENT_SECRET');
  var refresh = props.getProperty('HEALTH_REFRESH_TOKEN');
  if (!id || !secret || !refresh) {
    throw new Error('Health credentials not set. Add HEALTH_CLIENT_ID, HEALTH_CLIENT_SECRET and HEALTH_REFRESH_TOKEN in Project Settings > Script properties.');
  }
  var cache = CacheService.getScriptCache();
  var hit = cache.get('HEALTH_AT');
  if (hit) return hit;
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' },
    muteHttpExceptions: true
  });
  var data = {};
  try { data = JSON.parse(r.getContentText() || '{}'); } catch (e) {}
  if (!data.access_token) {
    throw new Error('Health token refresh failed (' + r.getResponseCode() + '): ' + (data.error || '') + ' ' + (data.error_description || ''));
  }
  cache.put('HEALTH_AT', data.access_token, Math.max(60, (Number(data.expires_in) || 3600) - 300));
  return data.access_token;
}

/* Run ONCE from the editor (Run > healthProbe). Writes nothing — logs only.
   The API is new enough that its request shapes could not be confirmed from
   documentation reachable from the build environment, so this tries candidate
   shapes and prints what the API actually says. A 400 that names the field it
   expected is as useful as a 200. View with Ctrl+Enter (Execution log). */
function healthProbe() {
  var token;
  try { token = healthAccessToken(); }
  catch (e) { Logger.log('STOP: ' + String(e.message || e)); return; }

  // The token must now carry ONLY health scopes, or the API rejects it again.
  var ti = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  Logger.log('--- TOKEN SCOPES (%s) ---', ti.getResponseCode());
  try { Logger.log(JSON.parse(ti.getContentText()).scope); } catch (e) { Logger.log(ti.getContentText().slice(0, 300)); }

  var tz = Session.getScriptTimeZone();
  var end = new Date();
  var start = new Date(end.getTime() - 6 * 86400000);
  var ymd = function (d) { var p = Utilities.formatDate(d, tz, 'yyyy-MM-dd').split('-').map(Number); return { year: p[0], month: p[1], day: p[2] }; };
  var s = ymd(start), e = ymd(end);

  function call(label, method, url, payload, max) {
    var opt = { method: method, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
    if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
    var r = UrlFetchApp.fetch(url, opt);
    Logger.log('--- %s -> %s ---', label, r.getResponseCode());
    Logger.log(r.getContentText().slice(0, max || 1500));
    return r.getResponseCode();
  }

  var base = 'https://health.googleapis.com/v4/users/me/dataTypes/';

  // dailyRollUp. Earlier runs proved `range` is NOT {startTime,endTime} or
  // {startDate,endDate}. The reference lists the body as range (a
  // CivilTimeInterval), windowSizeDays, pageSize, pageToken and
  // dataSourceFamily, so try start/end holding CivilDateTime values, with
  // windowSizeDays set. The first shape that returns 200 is reused for the
  // other data types below.
  var midnight = { hours: 0, minutes: 0, seconds: 0 }, lastSecond = { hours: 23, minutes: 59, seconds: 59 };
  var shapes = [
    ['range{start,end}.date+time', { range: { start: { date: s, time: midnight }, end: { date: e, time: lastSecond } }, windowSizeDays: 1 }],
    ['range{start,end}.date',      { range: { start: { date: s }, end: { date: e } }, windowSizeDays: 1 }],
    ['range{start,end} flat',      { range: { start: s, end: e }, windowSizeDays: 1 }]
  ];
  var okBody = null;
  for (var i = 0; i < shapes.length; i++) {
    var code = call('steps dailyRollUp ' + shapes[i][0], 'post', base + 'steps/dataPoints:dailyRollUp', shapes[i][1]);
    if (code === 200) { okBody = shapes[i][1]; break; }
  }
  if (okBody) {
    ['total-calories', 'active-minutes', 'daily-resting-heart-rate', 'heart-rate', 'sleep'].forEach(function (t) {
      call(t + ' dailyRollUp', 'post', base + t + '/dataPoints:dailyRollUp', okBody, 1200);
    });
  }

  // Which data types exist, and does the Air populate them? Hyphen and
  // underscore spellings both appear in the wild, so try both for heart rate.
  ['steps', 'sleep', 'heart-rate', 'heart_rate', 'daily-resting-heart-rate', 'weight',
   'total-calories', 'active-minutes', 'exercise', 'body-fat', 'distance']
    .forEach(function (t) { call(t + ' list', 'get', base + t + '/dataPoints?pageSize=2', null, 900); });
}
