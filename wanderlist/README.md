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

## Test the "share from Instagram" flow

The app registers a **Web Share Target**, so once it's installed to a phone it
shows up in the Android share sheet like a native app.

**On an Android phone (the real thing):**
1. Host the folder over HTTPS (e.g. GitHub Pages — see below) and open it in Chrome.
2. Menu ⋮ → **Install app / Add to Home screen**.
3. In Instagram, open a post → **Share** (paper-plane / `⋯ → Share to`) →
   pick **Wanderlist** from the system share sheet.
4. The review sheet opens, pre-filled — confirm and save.

**On any device (no install needed)** you can simulate exactly what the share
sheet hands the app by hitting the share URL directly:

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
