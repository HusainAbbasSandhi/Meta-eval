# Meta Approval Self-Check — Deploy to Vercel

## What's in here
- `index.html` — the page the client sees (plain HTML/CSS/JS, no build step needed)
- `api/check.js` — the serverless function that does the real work: renders the client's
  website with real headless Chromium (not just a raw fetch — see "Why headless Chromium"
  below) and runs the 6 SOP checks against the rendered page
- `package.json` — declares `puppeteer-core` and `@sparticuz/chromium-min`. Vercel
  installs these automatically on deploy. No build step, no postinstall script.
- `vercel.json` — gives the check function more memory (1536 MB) and time (30s) than
  Vercel's defaults, since launching a real browser needs both. **See the plan note below
  — this setting only takes effect on paid plans.**

## Why headless Chromium (not a plain fetch)
A plain server-side fetch only sees the HTML a site sends on its very first response. A
lot of modern sites — React/Vue builds, Webflow/Framer, or even plain static sites that
inject a shared footer via JS — fill in real content (hours, address, footer legal text)
*after* that first response, via JavaScript running in the browser. A plain fetch never
sees that, so early versions of this tool were showing false "not found" results on
sites that looked completely normal to a human visitor. Rendering the page first (the
same way a real visitor's browser — or Meta's own reviewer — would see it) fixes that.

## Checks more than the homepage
The tool renders the entered URL, then reads the homepage's own nav/footer links,
scores them for relevance (About/Contact/Visit-style pages score highest), and loads up
to 3 of the best matches — in parallel, not one after another, so this doesn't multiply
the check time by the number of pages. A single-page site sees no difference at all.
Each check result now reports which page a match actually came from (e.g. "found on
your Contact page"), and if two names are on different pages with no phrase connecting
them, that's called out specifically rather than just failing silently. The response
JSON includes a `pagesChecked` array listing exactly which pages were looked at, and the
UI shows a small "Checked N pages: Home, About, Contact" line above the results.

This is a deliberate cap, not a crawler — it does not follow links recursively, does not
visit pages the homepage doesn't itself link to, and does not check more than 3 extra
pages no matter how many the site has. That keeps the worst-case time bounded and
predictable regardless of how large the site is.

## Why this specific Chromium setup
Getting headless Chromium working reliably on Vercel took three attempts — worth
recording so nobody re-breaks it later:

1. **The full `@sparticuz/chromium` package, run directly.** Failed in production with
   `error while loading shared libraries: libnss3.so` — a known incompatibility between
   that package (built for AWS Lambda's environment) and Vercel's current Node.js
   function runtime.
2. **`@sparticuz/chromium-min` pointed at a tar file built by our own `postinstall`
   script and self-hosted from this project's root.** This is the pattern in Vercel's
   *official* Puppeteer template — but that template is a Next.js app, where a
   `public/` folder is guaranteed to be included in the deployed static output. This
   project has no framework and no build step, and Vercel does not make that same
   guarantee for a zero-config deployment — the generated tar never reliably ended up
   where the function could fetch it, causing `Invalid tar header` errors.
3. **`@sparticuz/chromium-min` pointed at Sparticuz's own GitHub Releases asset
   directly** (what's in this repo now) — a permanent, version-pinned tar file, no
   self-hosting, no build step, nothing that depends on this specific project's
   deployment shape. Verified working end-to-end before shipping.

`@sparticuz/chromium-min` is pinned to an *exact* version (`141.0.0`, not `^141.0.0`) in
`package.json`, matching the exact URL in `api/check.js`. If you ever bump one, bump the
other to match — check [github.com/Sparticuz/chromium/releases](https://github.com/Sparticuz/chromium/releases)
for the right pack URL for whatever version you move to.

## How to deploy
1. Go to vercel.com → **Add New → Project**
2. Import this folder (a GitHub repo import is the most reliable route; drag-and-drop
   should also work since there's no build step, but hasn't been tested)
3. Leave all build settings as default — Vercel auto-detects `package.json` and installs
   the two dependencies, and auto-detects the `api/` folder as a serverless function.
   No environment variables needed.
4. Click Deploy.
5. Test it: open the deployed URL, enter a real website + legal name + display name, hit
   "Check my website."

## ⚠️ Vercel plan / timeout note
Headless Chromium is heavier than a plain fetch — cold starts (including downloading
the ~65MB Chromium tar on a cold function instance), the homepage load, and then up to
3 more pages loading in parallel, can take a few seconds each, sometimes more on a slow
site. Worst case (a slow homepage plus slow extra pages) can approach 30 seconds.
`vercel.json` asks for a 45-second limit, but **Vercel's Hobby (free) plan hard-caps
serverless functions at 10 seconds by default, and only up to 60s if explicitly
configured** — check your actual function logs after deploying if checks seem to be
timing out; that's the most reliable signal, more reliable than any fixed number quoted
here since Vercel's own limits shift over time.

## Local testing
The downloaded Chromium binary is Linux-only — **this will not run locally** via
`vercel dev` on a Mac, Windows, or a regular desktop Linux install. Test against a real
Vercel deployment instead (a preview URL from a branch/PR works fine, doesn't need to be
production).

## Known limitations (by design, for this version)
- The "site is live and public" check can tell if the page loads and scans for obvious
  password fields or "under construction" text, but it can't detect every kind of login
  wall — worth a manual glance if that check comes back with a warning.
- The "generic or location-only display name" rejection reason from the SOP isn't
  automated (e.g. "Bakery" or "Mumbai Store") — that's a judgment call, not something
  worth faking a confident automatic answer for.
- Some websites block automated browsers (bot protection). If a legitimate site comes
  back as "unreachable," that's the most likely reason — flag it for a manual check.
- Subdomains (e.g. `shop.yourbrand.com`) are flagged as invalid before any page load —
  root domain only, per Meta's requirement. `www.` is treated as the root domain, not a
  subdomain. Two-part country domains like `.co.in` / `.co.uk` are recognized so
  `brand.co.in` isn't mistaken for a subdomain of "co.in".

## If you want a custom domain later
Add it in Vercel → your project → Settings → Domains. No code changes needed.
