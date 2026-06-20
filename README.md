# 75 Hard Tracker 💪

A clean, **mobile-first** web app to track the official [75 Hard](https://andyfrisella.com/pages/75hard-info) challenge from your phone. It supports **multiple users** (each person signs up with a username) and stores **all data in a Google Sheet** that updates automatically. Installs to your home screen like a native app (PWA).

> Your challenge starts the day you sign up. Pick your start date on the sign-up screen.

## What it tracks (official 75 Hard rules)

Every day you must complete **all** of:

- 🏋️ **Indoor workout** — 45 minutes
- 🌳 **Outdoor workout** — 45 minutes (rain or shine)
- 💧 **Drink your daily water** — tracked in **litres**, one tap = **500 ml** (goal 4 L, which covers the 1-gallon rule)
- 📖 **Read 10 pages** of a non-fiction / self-improvement book
- 📸 **Take a progress photo**
- 🥗 **Follow a diet** — no cheat meals
- 🚫 **No alcohol**

Miss any task and 75 Hard says you restart from Day 1 — there's a one-tap **restart** button in Settings.

## Features

- **Today screen** with a live completion ring, big tap targets, and a glass-by-glass water tracker
- **Diet & calorie tracker** (FatSecret-style) — search foods, log meals (breakfast/lunch/dinner/snacks),
  track calories + protein/carbs/fat against a daily goal, with a built-in TDEE goal calculator.
  Food search uses the free [Open Food Facts](https://world.openfoodfacts.org) database, a built-in
  quick-list of common staples, **a bundled 1,000+ Indian dish database** (per serving), and shared
  custom foods; you can also add custom foods manually.
- **Intermittent fasting timer** — start a fast (with an adjustable start time), a live count-up ring
  that targets the next milestone and keeps running after you close the app. When you end it, the
  milestone reached (12/14/16/18/20/24/36 h) is derived automatically from how long you fasted. Past
  fasts can be edited or deleted.
- **Friends feed** — see everyone's *today* at a glance: tasks done/pending, water, and calories.
- **75-day journey** calendar (done / missed / today / upcoming)
- **Stats** — current & best streak, days completed, gallons of water, per-task consistency bars
- **Leaderboard** — everyone using your sheet, ranked by completed days (great for doing it with friends)
- **Themes** — pick from Midnight, Neon Lime, Violet, Ocean, Crimson, Pastel, Academia or Arsenal in
  Settings (saved on your device). Academia and Arsenal use a wallpaper background with frosted cards —
  to use your own wallpaper, replace `assets/bg-academia.svg` / `assets/bg-arsenal.svg` with your image
  (keep the same filename, or point the CSS `body::before` rule at your file).
- **Delete account** — Settings lets a user permanently remove their account and all their data (password-confirmed)
- **Multi-user** sign-up / login (passwords are salted + SHA-256 hashed in the sheet)
- **Auto-save** — every tap syncs; works offline and re-syncs
- **Installable** to your phone home screen, works full-screen

---

## Setup (about 10 minutes, all free)

There are two halves: the **Google Sheet backend** and the **web app hosting**.

### Part A — Google Sheet + Apps Script backend

1. Go to <https://sheets.google.com> and create a **new blank spreadsheet**. Name it e.g. `75 Hard Data`.
2. In the menu choose **Extensions → Apps Script**.
3. Delete any starter code, then **paste the entire contents of [`apps-script/Code.gs`](apps-script/Code.gs)** into the editor.
   - Open **Project Settings** (⚙ in the left sidebar) and set the **Time zone** to **`(GMT+05:30) India Standard Time - Mumbai/Kolkata`** so "today" and day rollover happen at midnight Mumbai time.
4. (Optional) Click the ▶ **Run** button with `setup` selected to pre-create the `Users` and `Logs` tabs, and approve the permission prompt once.
5. Click **Deploy → New deployment**.
   - Click the gear ⚙ and choose **Web app**.
   - **Description:** `75 Hard API`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**
   - Click **Deploy**, approve access, and **copy the Web app URL** (ends in `/exec`).

> The `Users` and `Logs` tabs are created automatically the first time someone signs up.

### Part B — Connect the app to your sheet

1. Open [`js/config.js`](js/config.js).
2. Paste your Web app URL into `API_URL`:
   ```js
   API_URL: "https://script.google.com/macros/s/AKfy....../exec",
   ```
3. Commit the change.

> If you leave `API_URL` empty, the app still runs in **offline demo mode** (data lives only in that phone's browser) so you can try the interface before wiring up the sheet.

### Part C — Host on GitHub Pages

This repo ships with a workflow at `.github/workflows/deploy-pages.yml` that publishes automatically.

1. In your GitHub repo go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to the branch (it deploys on every push). Within a minute the **Actions** tab shows a deployment with your public URL, e.g.
   `https://<your-username>.github.io/<repo>/`.

### Part D — Put it on your phone

1. Open the Pages URL in **Safari (iOS)** or **Chrome (Android)**.
2. **iPhone:** Share → **Add to Home Screen**.
   **Android:** menu ⋮ → **Add to Home screen / Install app**.
3. Open it from the icon — it runs full-screen like a native app.
4. **Sign up** with a username + password and your start date. Done — go get Day 1. 🔥

Friends just open the same URL and create their own usernames; everyone shows up on the leaderboard.

---

## Optional: FatSecret food search

The app searches [Open Food Facts](https://world.openfoodfacts.org) by default. You can additionally plug in
the **FatSecret** API (better branded/Indian coverage). FatSecret can't be called from the browser, so the
Apps Script backend proxies it.

1. In your FatSecret developer dashboard, get your **OAuth 2.0 Client ID** and **Client Secret**.
   - Under your app's **IP restrictions**, allow all / disable the whitelist — Apps Script's outbound IPs are
     dynamic and can't be whitelisted, so a locked-down IP list will block it.
2. In the Apps Script editor: **Project Settings (⚙) → Script properties → Add script property** twice:
   - `FATSECRET_CLIENT_ID` = your client id
   - `FATSECRET_CLIENT_SECRET` = your client secret
3. Paste the latest `apps-script/Code.gs`, then run the `testFatSecret` function once (Run ▶ with it selected)
   and check **View → Logs** — you should see `Token OK` and a sample "amul butter" result.
4. **Deploy → Manage deployments → ✏️ → New version → Deploy.**

Now searches hit FatSecret first and fall back to Open Food Facts automatically. If the properties aren't set,
the app just uses Open Food Facts as before.

## Updating the backend after a code change

When `apps-script/Code.gs` changes (e.g. new features like the diet tracker), update your deployed script:

1. Open your sheet → **Extensions → Apps Script**, select all in `Code.gs`, delete, and paste the new `Code.gs`.
2. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**

The URL stays the same, so nothing in the app needs to change. New tabs (`Food`, `Profiles`) are created automatically.

## How the data is stored

Everything lives in your Google Sheet, in two tabs:

**`Users`**

| username | displayName | passwordHash | salt | token | startDate | createdAt |
|----------|-------------|--------------|------|-------|-----------|-----------|

**`Logs`** (one row per user per day, updated automatically as you tap)

| username | date | dayNumber | workout1 | workout2 | outdoor | waterMl | reading | photo | diet | noAlcohol | completed | notes | updatedAt |
|----------|------|-----------|----------|----------|---------|---------|---------|-------|------|-----------|-----------|-------|-----------|

**`Food`** (one row per logged food, for the diet tracker)

| id | username | date | meal | name | grams | calories | protein | carbs | fat | createdAt |
|----|----------|------|------|------|-------|----------|---------|-------|-----|-----------|

**`Profiles`** (each user's saved diet goals/body stats, as JSON)

| username | dataJson | updatedAt |
|----------|----------|-----------|

**`Fasts`** (one row per fast for the intermittent-fasting timer)

| id | username | startAt | endAt | goalHours | createdAt |
|----|----------|---------|-------|-----------|-----------|

**`CustomFoods`** (shared custom foods — once anyone adds one, everyone can search it)

| id | name | kcal | protein | carbs | fat | sugar | createdBy | createdAt |
|----|------|------|---------|-------|-----|-------|-----------|-----------|

You can open the sheet any time to view, chart, or export your data — the app writes to it live.

## Project structure

```
index.html              App shell (auth + dashboard)
css/styles.css          Mobile-first styles
js/config.js            ← put your Apps Script URL here
js/app.js               App logic + API + offline fallback
manifest.webmanifest    PWA manifest (home-screen install)
sw.js                   Service worker (offline cache)
assets/icon*.svg        App icons
apps-script/Code.gs     Google Apps Script backend (paste into Apps Script)
apps-script/appsscript.json
.github/workflows/deploy-pages.yml   Auto-deploy to GitHub Pages
```

## Notes & security

- Passwords are **salted and SHA-256 hashed** before being stored — plaintext passwords are never saved. This is a lightweight scheme suitable for a personal/friends tracker, not a high-security system.
- The Apps Script must be deployed with **"Anyone" access** so your phone (which is not logged into your Google account) can reach the API. The script itself only ever touches your one spreadsheet.
- To wipe everything, just clear the `Users` and `Logs` tabs in the sheet.
