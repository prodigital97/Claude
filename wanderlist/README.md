# Wanderlist — Travel Saves 🧭

A mobile-first web app (PWA) for people who collect travel ideas. Save
**destinations, restaurants, food joints, cafés, hotels, beaches, bars and
activities** — then **filter by category** and search them all in one place,
instead of digging through your Instagram saved posts.

The headline flow: on Instagram, open a post → **Share** → choose **Wanderlist**.
The app reads the shared content, auto-guesses the title, category, location and
tags, and saves it. No more scrolling through Instagram's "Saved" tab.

This is a **prototype** — everything runs in the browser and your saves are
stored in your device's local storage. No accounts, no backend.

---

## Try it locally

It's a static site — just serve the `wanderlist/` folder:

```bash
cd wanderlist
python3 -m http.server 8000
# open http://localhost:8000
```

You'll see a few demo saves and the category filter chips. Tap **+** to add one
by pasting a link, or test the share flow below.

## Share from Instagram

### iPhone — via an iOS Shortcut (no App Store needed)

iOS only lets **Shortcuts** (not websites) appear in the Share sheet, so on
iPhone you add a tiny shortcut once. The app's in-app **↗ Help** button walks
through this on the phone; the steps are:

1. Open the **Shortcuts** app → **+** to create a new shortcut.
2. Tap **ⓘ / settings** → enable **Show in Share Sheet**; keep **URLs** on under
   *Share Sheet Types*.
3. Add the action **Open URLs**.
4. In the URL field paste:
   ```
   https://<your-host>/wanderlist/index.html?autosave=1&url=
   ```
   then put the cursor right after `url=` and insert the **Shortcut Input** variable.
5. Name it **Wanderlist** → **Done**.
6. In Instagram: post → **Share** → **Share to…** → **Wanderlist**. Done.

`?autosave=1` saves silently and shows a toast. Drop `autosave=1&` if you'd
rather review/edit (category, notes) each time before saving.

> Because Instagram only hands the **URL** (not the caption) to a Shortcut,
> auto-categorisation from the caption isn't possible this way — add the optional
> backend (below) to fetch captions via Instagram oEmbed for richer auto-fill.

### Android — Web Share Target (PWA)

On Android the installed PWA registers a **Web Share Target** and shows up in the
share sheet natively:
1. Open the hosted app in Chrome → menu ⋮ → **Install app / Add to Home screen**.
2. In Instagram: post → **Share** → pick **Wanderlist**.
3. The review sheet opens pre-filled — confirm and save.

### Any device — simulate the share

You can hit the share URL directly to see exactly what the app does with shared
content:

```
index.html?title=Sunset%20Beach%20Cafe&text=📍%20Canggu,%20Bali%20best%20beach%20cafe%20%23sunset%20%23coffee&url=https://www.instagram.com/p/abc123/
```

The app parses `title` / `text` / `url`, detects the category (**Café/Beach**
here), pulls the location after the 📍 pin, grabs the `#hashtags` as tags, and
opens the pre-filled save sheet.

## How "automatically reads the content" works

Instagram doesn't allow reading a post's caption from a third-party app on the
client side (no public API for it, and scraping is against their terms). So the
reader works with **whatever the OS share sheet passes to the app** — the post
URL plus any title/caption text — and makes smart guesses you confirm in one tap:

| Field | How it's detected |
|-------|-------------------|
| **Category** | keyword matching against the caption (e.g. *beach, resort, café, street food*) |
| **Title** | first meaningful line of the caption |
| **Location** | text after a 📍 pin, or an `in/at <Place>` phrase |
| **Tags** | `#hashtags` from the caption |
| **Source** | derived from the URL domain (Instagram / TikTok / YouTube / Maps) |

> **Going further (beyond this prototype):** to pull the actual caption, photo
> and exact place, you'd add a tiny backend that calls Instagram's **oEmbed**/
> Graph API (or a generic link-unfurl service) with the shared URL. The UI here
> is built so that richer auto-fill drops straight in.

## Deploy to GitHub Pages

This folder is fully static. If you enable Pages for the repo (Settings → Pages
→ Source: GitHub Actions), the app will be available at
`https://<user>.github.io/<repo>/wanderlist/`. Web Share Target requires HTTPS
and the app to be installed, both of which Pages satisfies.

## Files

```
wanderlist/
├── index.html              App shell (list, filters, save sheet)
├── css/styles.css          Mobile-first styles
├── js/app.js               Logic: content reader, storage, filtering
├── manifest.webmanifest    PWA manifest incl. share_target
├── sw.js                   Service worker (offline cache)
└── assets/                 App icons
```

## Categories

Destinations · Restaurants · Food joints · Cafés · Hotels · Beaches · Bars ·
Activities · Other — edit the `CATEGORIES` array in `js/app.js` to add your own
(each has an emoji and the keywords used for auto-detection).
