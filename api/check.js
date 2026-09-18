// Vercel Serverless Function
//
// This renders the target page with real headless Chromium before reading
// its content — not a plain fetch(). A plain fetch only sees the HTML a
// server sends on the very first response; on a lot of modern sites (React/
// Vue/Webflow/Framer-style builds, or plain static sites that inject a
// shared header/footer via JS) a meaningful chunk of the visible page —
// hours, address, footer legal text — is filled in by JavaScript *after*
// that first response. A plain fetch never sees that, so it was producing
// false "not found" results on sites that looked completely normal in a
// browser. Rendering the page first fixes that at the source.
//
// CHROMIUM SETUP — this matters, don't change it without reading this:
// We use @sparticuz/chromium-min at runtime, downloading the actual browser
// binary from Sparticuz/chromium's own GitHub Releases (a permanent,
// version-pinned asset — not something we host ourselves). Two earlier
// approaches were tried and both failed in production:
//   1. The full @sparticuz/chromium package run directly — failed with
//      "error while loading shared libraries: libnss3.so", a known
//      incompatibility between that package (built for AWS Lambda) and
//      Vercel's current Node.js function runtime.
//   2. chromium-min pointed at a tar file we built ourselves via a
//      `postinstall` script and served from this project's own root —
//      failed with "Invalid tar header" because this project has no
//      framework/build step, and Vercel does not guarantee that a
//      postinstall-generated file actually lands in what a zero-config
//      deployment serves statically (that guarantee only really exists for
//      framework projects with an explicit public/ output directory, e.g.
//      Next.js — which is why Vercel's own official template, built with
//      Next.js, gets away with self-hosting).
// Pointing directly at GitHub's release asset sidesteps both problems.
// @sparticuz/chromium-min is pinned to an exact version (not a ^range) in
// package.json so it always matches the exact chromium build this URL
// points to. Verified working end-to-end before shipping.
//
// NOTE: this will NOT run locally via `vercel dev` on a Mac/Windows/regular
// Linux machine — the downloaded binary is Linux-only. Test against a real
// Vercel deployment (a preview URL from a PR/branch works fine).

const puppeteer = require("puppeteer-core");

// Must stay in sync with the @sparticuz/chromium-min version pinned in
// package.json — if that version changes, update this URL to match
// (https://github.com/Sparticuz/chromium/releases).
const CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v141.0.0/chromium-v141.0.0-pack.x64.tar";

// Cached across warm invocations of the same function instance so repeat
// requests don't re-download the ~65MB tar every time.
let cachedExecutablePath = null;
let downloadPromise = null;

async function getChromiumExecutablePath() {
  if (cachedExecutablePath) return cachedExecutablePath;
  if (!downloadPromise) {
    const chromium = require("@sparticuz/chromium-min");
    downloadPromise = chromium
      .executablePath(CHROMIUM_PACK_URL)
      .then((p) => {
        cachedExecutablePath = p;
        return p;
      })
      .catch((err) => {
        downloadPromise = null; // allow retry on the next request
        throw err;
      });
  }
  return downloadPromise;
}

const RESTRICTED_WORDS = ["official", "verified", "whatsapp", "facebook", "messenger"];

const SCRIPT_RANGES = {
  English: { name: "Latin", regex: /[A-Za-z]/g },

  Hindi: { name: "Devanagari", regex: /[\u0900-\u097F]/g },
  Gujarati: { name: "Gujarati", regex: /[\u0A80-\u0AFF]/g },
  Marathi: { name: "Devanagari", regex: /[\u0900-\u097F]/g },
  Tamil: { name: "Tamil", regex: /[\u0B80-\u0BFF]/g },
  Telugu: { name: "Telugu", regex: /[\u0C00-\u0C7F]/g },
  Kannada: { name: "Kannada", regex: /[\u0C80-\u0CFF]/g },
  Bengali: { name: "Bengali", regex: /[\u0980-\u09FF]/g },
  Punjabi: { name: "Gurmukhi", regex: /[\u0A00-\u0A7F]/g },
  Urdu: { name: "Arabic script", regex: /[\u0600-\u06FF]/g },
};

// Common two-part public suffixes — so "brand.co.in" isn't mistaken for a
// subdomain of "co.in". Not exhaustive, but covers the ccTLDs most likely
// to show up here.
const TWO_PART_SUFFIXES = new Set([
  "co.in", "com.in", "org.in", "net.in", "gov.in", "ac.in", "edu.in", "firm.in", "gen.in", "ind.in",
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk",
  "co.nz", "co.za", "co.jp", "co.kr", "co.id", "co.th",
  "com.au", "net.au", "org.au",
  "com.br", "com.sg", "com.my", "com.hk", "com.tw", "com.mx", "com.pk", "com.bd",
]);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(str) {
  return str.replace(/\s+/g, " ").trim();
}

// Decide whether a hostname is a root domain or has a subdomain in front of it.
// "www." is treated as equivalent to the root domain, not as a subdomain.
function analyzeHostname(hostname) {
  let h = hostname.toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  const labels = h.split(".").filter(Boolean);

  if (labels.length <= 2) {
    return { isSubdomain: false, root: labels.join(".") };
  }
  if (labels.length === 3) {
    const lastTwo = labels.slice(-2).join(".");
    if (TWO_PART_SUFFIXES.has(lastTwo)) {
      return { isSubdomain: false, root: labels.join(".") };
    }
    return { isSubdomain: true, subdomainLabel: labels[0], root: labels.slice(-2).join(".") };
  }
  const suffixGuess = TWO_PART_SUFFIXES.has(labels.slice(-2).join("."))
    ? labels.slice(-3).join(".")
    : labels.slice(-2).join(".");
  return { isSubdomain: true, subdomainLabel: labels[0], root: suffixGuess };
}

function looksLikeLoginWall(hasPasswordField, text) {
  const loginPhrases = /\b(please log ?in|sign in to continue|enter password to view|this site is protected|coming soon|under construction|site is being built)\b/i;
  return hasPasswordField || loginPhrases.test(text);
}

// Pulls a short window of surrounding text around the first match, so the UI
// can show *where* on the page something was found instead of just pass/fail.
function getSnippet(text, term, radius = 60) {
  if (!term) return null;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

const MAX_EXTRA_PAGES = 3;

// Finds the first page (homepage checked first, then extras in priority
// order) whose text contains the term. Returns the page object, or null.
function findTermPage(pages, term) {
  if (!term) return null;
  const needle = term.toLowerCase();
  return pages.find((p) => p.text.toLowerCase().includes(needle)) || null;
}

// Finds a single page where BOTH terms appear — used for the "are these two
// names actually linked" check, which only makes sense checked within one
// page (concatenating all pages together could otherwise "find" a
// connection between a name on page A and a name on page B that have
// nothing to do with each other).
function findPageWithBoth(pages, termA, termB) {
  const a = termA.toLowerCase();
  const b = termB.toLowerCase();
  return pages.find((p) => {
    const t = p.text.toLowerCase();
    return t.includes(a) && t.includes(b);
  }) || null;
}

function combinedText(pages) {
  return pages.map((p) => p.text).join("\n");
}

function pageNote(page) {
  return page && page.label !== "Home" ? ` (on the ${page.label} page)` : "";
}
const RELEVANT_KEYWORDS = ["about", "contact", "visit", "location", "reach", "connect", "find", "store", "outlet", "hours", "legal", "info", "us"];
const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3|avi|mov)$/i;

function prettifyPathLabel(pathname) {
  const seg = pathname.split("/").filter(Boolean).pop() || "Page";
  return seg
    .replace(/\.\w+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 30);
}

// Same-origin links only, deduped, obviously-irrelevant files skipped, then
// scored by how likely they are to hold what we're actually checking for
// (legal name, contact info) — not a generic crawl of everything linked.
function pickPriorityLinks(rawLinks, homepageUrl, max) {
  let homeNorm;
  let originHost;
  try {
    const h = new URL(homepageUrl);
    h.hash = "";
    homeNorm = h.toString().replace(/\/$/, "");
    originHost = h.hostname;
  } catch (e) {
    return [];
  }

  const seen = new Set([homeNorm]);
  const candidates = [];

  for (const l of rawLinks) {
    let u;
    try {
      u = new URL(l.href);
    } catch (e) {
      continue;
    }
    if (u.hostname !== originHost) continue;
    if (!/^https?:$/.test(u.protocol)) continue;
    if (SKIP_EXTENSIONS.test(u.pathname)) continue;
    u.hash = "";
    const norm = u.toString().replace(/\/$/, "") || u.toString();
    if (seen.has(norm)) continue;
    seen.add(norm);

    const linkText = (l.text || "").trim();
    const hay = (linkText + " " + u.pathname).toLowerCase();
    const score = RELEVANT_KEYWORDS.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0);
    const label = linkText && linkText.length <= 30 ? linkText : prettifyPathLabel(u.pathname);

    candidates.push({ href: norm, label, score, pathLen: u.pathname.length });
  }

  candidates.sort((a, b) => b.score - a.score || a.pathLen - b.pathLen);
  return candidates.slice(0, max);
}

async function loadSecondaryPage(browser, link) {
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (compatible; ReeloMetaCheck/2.0; +headless)");
    page.setDefaultNavigationTimeout(15000);

    let response;
    try {
      response = await page.goto(link.href, { waitUntil: "networkidle2", timeout: 15000 });
    } catch (navErr) {
      // Some pages (chat widgets, analytics, ad pixels) never go fully
      // network-idle. If the networkidle2 wait timed out, don't give up —
      // retry with a lighter wait condition that still captures the
      // rendered content, just without waiting for background network
      // activity to fully settle.
      if (/timeout/i.test(navErr.message)) {
        try {
          response = await page.goto(link.href, { waitUntil: "domcontentloaded", timeout: 8000 });
        } catch (retryErr) {
          return { label: link.label, url: link.href, ok: false, reason: "Timed out loading this page." };
        }
      } else {
        return { label: link.label, url: link.href, ok: false, reason: "Could not load this page." };
      }
    }

    if (!response || response.status() >= 400) {
      const status = response ? response.status() : null;
      return { label: link.label, url: link.href, ok: false, reason: status ? `Page responded with status ${status}.` : "Could not load this page." };
    }

    const rawText = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    return { label: link.label, url: link.href, text: normalizeText(rawText), ok: true };
  } catch (e) {
    return { label: link.label, url: link.href, ok: false, reason: "Could not load this page." };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Renders the homepage, then finds and loads a handful of the most relevant
// other pages on the same site (About/Contact/Visit-style, up to
// MAX_EXTRA_PAGES) in parallel — so checks like "legal name visible" or
// "working contact details" aren't limited to whatever happens to be on the
// homepage specifically.
async function renderSite(target) {
  const chromium = require("@sparticuz/chromium-min");
  const executablePath = await getChromiumExecutablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    executablePath,
    headless: true,
  });

  try {
    const homePage = await browser.newPage();
    homePage.setDefaultNavigationTimeout(20000);
    await homePage.setUserAgent("Mozilla/5.0 (compatible; ReeloMetaCheck/2.0; +headless)");

    let response;
    try {
      // networkidle2: wait until the page has gone quiet (≤2 in-flight
      // requests for 500ms) — gives client-rendered content time to land,
      // not just the first HTML response.
      response = await homePage.goto(target, { waitUntil: "networkidle2", timeout: 20000 });
    } catch (navErr) {
      const msg = /timeout/i.test(navErr.message) ? "Site took too long to fully load." : "Could not reach this URL.";
      throw Object.assign(new Error(msg), { isNavError: true });
    }

    if (!response || response.status() >= 400) {
      const status = response ? response.status() : null;
      throw Object.assign(new Error(status ? `Site responded with status ${status}` : "The site could not be reached."), { isNavError: true });
    }

    const finalUrl = response.url();
    const isSecure = /^https:/i.test(finalUrl);
    const hasPasswordField = (await homePage.$('input[type="password"]')) !== null;
    const rawText = await homePage.evaluate(() => (document.body ? document.body.innerText : ""));
    const homeText = normalizeText(rawText);

    const rawLinks = await homePage.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.href, text: (a.innerText || a.textContent || "").trim() }))
    );

    const priorityLinks = pickPriorityLinks(rawLinks, target, MAX_EXTRA_PAGES);

    const extraResults = await Promise.allSettled(priorityLinks.map((link) => loadSecondaryPage(browser, link)));
    const settled = extraResults.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
    const extraPages = settled.filter((p) => p.ok);
    const failedPages = settled.filter((p) => !p.ok);

    const pages = [{ label: "Home", url: target, text: homeText }, ...extraPages];

    return { pages, failedPages, hasPasswordField, isSecure, finalUrl };
  } finally {
    await browser.close();
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { url, legalName, displayName, language } = req.body || {};

  if (!url || !legalName || !displayName) {
    return res.status(400).json({ error: "url, legalName, and displayName are all required." });
  }

  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;

  // Reject subdomains before even attempting to load the page — Meta
  // requires the root domain, not a subdomain, as the business website.
  let hostname = null;
  try {
    hostname = new URL(target).hostname;
  } catch (e) {
    return res.status(200).json({
      target,
      checks: [
        { title: "Website URL isn't valid", status: "fail", message: `"${url}" doesn't look like a valid website address.`, tip: "Double-check the URL and try again — e.g. yourbrand.com" },
      ],
      unreachable: true,
    });
  }

  const domainInfo = analyzeHostname(hostname);
  if (domainInfo.isSubdomain) {
    return res.status(200).json({
      target,
      checks: [
        {
          title: "Website uses a subdomain",
          status: "fail",
          message: `"${hostname}" is a subdomain (the "${domainInfo.subdomainLabel}" part in front of "${domainInfo.root}"). Meta does not accept a subdomain as the business website — it needs to be the root domain itself.`,
          tip: `Use the root domain instead — e.g. "${domainInfo.root}" rather than "${hostname}".`,
        },
      ],
      unreachable: true,
      invalidSubdomain: true,
    });
  }

  let pages = [];
  let failedPages = [];
  let hasPasswordField = false;
  let isSecure = true;

  try {
    const rendered = await renderSite(target);
    pages = rendered.pages;
    failedPages = rendered.failedPages || [];
    hasPasswordField = rendered.hasPasswordField;
    isSecure = rendered.isSecure;
  } catch (err) {
    return res.status(200).json({
      target,
      checks: [
        { title: "Site could not be reached", status: "fail", message: err.message || "The site could not be reached." },
      ],
      unreachable: true,
    });
  }

  const homeText = pages[0].text;
  const allText = combinedText(pages);
  const legal = legalName.trim();
  const display = displayName.trim();
  const lang = language || "English";

  // 1. Live & public — homepage only; this is specifically about the entry
  // point Meta's reviewer would land on.
  const loginWall = looksLikeLoginWall(hasPasswordField, homeText);
  const liveCheck = loginWall
    ? {
        title: "Site may have a login wall",
        status: "warn",
        message: "The site loaded, but the page contains signs of a login wall, password field, or an under-construction message.",
        tip: "Double check this manually — Meta needs to open the page without any login.",
      }
    : { title: "Site is live and public", status: "pass", message: "The site loaded successfully with no obvious login wall or under-construction markers." };

  // 1b. Secure connection (HTTPS) — checked on the final resolved URL, so a
  // site that redirects http → https on its own still passes.
  const secureCheck = isSecure
    ? { title: "Site uses a secure connection", status: "pass", message: "The site loads over HTTPS." }
    : {
        title: "Site isn't using a secure connection (HTTP)",
        status: "warn",
        message: "The site loads over plain HTTP, not HTTPS — browsers flag this as \"Not secure,\" which can undermine trust during review even though it isn't one of Meta's listed requirements.",
        tip: "Set up an SSL certificate and redirect http:// to https:// — most hosts (including Vercel) offer this for free.",
      };

  // 2. Legal name visible — anywhere on the site
  const legalPage = findTermPage(pages, legal);
  const legalFound = !!legalPage;
  const legalNameCheck = legalFound
    ? { title: "Legal name is visible", status: "pass", message: `"${legal}" was found on the site${pageNote(legalPage)}.`, evidence: getSnippet(legalPage.text, legal) }
    : {
        title: "Legal name not found on the site",
        status: "fail",
        message: `"${legal}" was not found on ${pages.length > 1 ? `any of the ${pages.length} pages checked` : "the page"}.`,
        tip: "Add the exact legal entity name (as on the GST/incorporation certificate) to the footer, About, or Contact section.",
      };

  // 3. Display name linked to legal name
  const displayPage = findTermPage(pages, display);
  const displayFound = !!displayPage;
  const sameName = legal.toLowerCase() === display.toLowerCase();
  let linkCheck;
  if (sameName) {
    linkCheck = displayFound
      ? { title: "Display name matches the legal name", status: "pass", message: `Display name and legal name are the same, and it appears on the site${pageNote(displayPage)}.` }
      : { title: "Display name not found on the site", status: "fail", message: "Display name equals the legal name, but it wasn't found on the site.", tip: "Make sure the brand name is visible somewhere on the site." };
  } else if (displayFound && legalFound) {
    const bothPage = findPageWithBoth(pages, display, legal);
    if (bothPage) {
      const connector = new RegExp(
        `${escapeRegex(display.toLowerCase())}[^.]{0,40}(powered by|by)[^.]{0,40}${escapeRegex(legal.toLowerCase())}`, "i"
      );
      const reverseConnector = new RegExp(
        `${escapeRegex(legal.toLowerCase())}[^.]{0,40}(powered by|by|trading as|d/b/a)[^.]{0,40}${escapeRegex(display.toLowerCase())}`, "i"
      );
      const linked = connector.test(bothPage.text) || reverseConnector.test(bothPage.text);
      linkCheck = linked
        ? { title: "Display name is clearly linked", status: "pass", message: `Found a connecting phrase tying "${display}" to "${legal}"${pageNote(bothPage)}.`, evidence: getSnippet(bothPage.text, display) }
        : {
            title: "Link between names isn't clearly stated",
            status: "warn",
            message: `Both "${display}" and "${legal}" appear on the site${pageNote(bothPage)}, but no explicit connecting phrase (e.g. "powered by") was detected nearby.`,
            tip: `Add a line like "${display}, powered by ${legal}" in the footer.`,
          };
    } else {
      linkCheck = {
        title: "Link between names isn't clearly stated",
        status: "warn",
        message: `"${display}" is on the ${displayPage.label} page and "${legal}" is on the ${legalPage.label} page, but they don't appear together anywhere — so the connection isn't explicit.`,
        tip: `Add a line like "${display}, powered by ${legal}" somewhere both names appear together, e.g. the footer.`,
      };
    }
  } else if (displayFound && !legalFound) {
    linkCheck = {
      title: "Legal name missing — can't confirm the link",
      status: "fail",
      message: `"${display}" is on the site${pageNote(displayPage)}, but the legal name "${legal}" isn't found anywhere — so the two can't be linked.`,
      tip: "Add the legal name near the brand name, e.g. in the footer copyright line.",
    };
  } else {
    linkCheck = {
      title: "Display name not found on the site",
      status: "fail",
      message: `"${display}" was not found on ${pages.length > 1 ? `any of the ${pages.length} pages checked` : "the page"}.`,
      tip: "The requested display name must appear on the website, ideally linked to the legal name.",
    };
  }

  // 4. Consistent casing — across every page checked
  const caseInsensitive = new RegExp(`\\b${escapeRegex(display)}\\b`, "gi");
  const allMatches = allText.match(caseInsensitive) || [];
  const variants = [...new Set(allMatches)].filter((v) => v !== display);
  let castingCheck;
  if (!displayFound) {
    castingCheck = { title: "Can't verify spelling — name not found", status: "fail", message: "Can't check casing consistency because the display name wasn't found on the site." };
  } else if (variants.length === 0) {
    castingCheck = { title: "Spelling is consistent", status: "pass", message: `Every occurrence matches "${display}" exactly.` };
  } else {
    castingCheck = {
      title: "Inconsistent spelling found",
      status: "warn",
      message: `Found variant spelling(s) of the name: ${variants.slice(0, 5).map((v) => `"${v}"`).join(", ")}. Meta treats these as different names.`,
      tip: `Standardize every instance on the site to read exactly "${display}".`,
    };
  }

  // 5. Contact details — first page (in priority order) that has one
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const phoneRe = /(\+?\d[\d\s\-().]{8,14}\d)/;
  const contactPage = pages.find((p) => emailRe.test(p.text) || phoneRe.test(p.text));
  let contactCheck;
  if (contactPage) {
    const emailMatch = contactPage.text.match(emailRe);
    const phoneMatch = contactPage.text.match(phoneRe);
    contactCheck = {
      title: "Working contact details found",
      status: "pass",
      message: `Found ${[emailMatch && "an email address", phoneMatch && "a phone number"].filter(Boolean).join(" and ")} on the site${pageNote(contactPage)}.`,
      evidence: [emailMatch && emailMatch[0], phoneMatch && phoneMatch[0].trim()].filter(Boolean).join("  ·  "),
    };
  } else {
    contactCheck = { title: "No contact details found", status: "fail", message: `No email address or phone number was detected on ${pages.length > 1 ? `any of the ${pages.length} pages checked` : "the page"}.`, tip: "Add a reachable phone number or email." };
  }

  // 6. Language match — across every page checked
  const scriptInfo = SCRIPT_RANGES[lang] || SCRIPT_RANGES.English;
  const scriptMatches = (allText.match(scriptInfo.regex) || []).length;
  const totalLetters = (allText.match(/[A-Za-z\u0900-\u097F\u0A80-\u0AFF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0980-\u09FF\u0A00-\u0A7F\u0600-\u06FF]/g) || []).length;
  const ratio = totalLetters > 0 ? scriptMatches / totalLetters : 0;
  const languageCheck =
    totalLetters === 0
      ? { title: "Not enough text to check language", status: "warn", message: "Couldn't detect enough readable text to evaluate language." }
      : ratio > 0.6
      ? { title: "Language matches", status: "pass", message: `Content is predominantly ${scriptInfo.name} script, consistent with a ${lang} display name request.` }
      : {
          title: "Language doesn't match the request",
          status: "warn",
          message: `Only ${Math.round(ratio * 100)}% of readable text is in ${scriptInfo.name} script, but the display name is being requested in ${lang}.`,
          tip: `If the display name is in ${lang}, the site's core content should be in that language too.`,
        };

  // Restricted words in display name
  const restrictedHit = RESTRICTED_WORDS.find((w) => display.toLowerCase().includes(w));
  const restrictedCheck = restrictedHit
    ? { title: `Restricted word found: "${restrictedHit}"`, status: "fail", message: `The requested display name includes "${restrictedHit}", which Meta rejects outright.`, tip: "Remove restricted words like Official, Verified, WhatsApp, Facebook, or Messenger." }
    : { title: "No restricted words in display name", status: "pass", message: "No restricted words found in the display name." };

  const checks = [liveCheck, secureCheck, legalNameCheck, linkCheck, castingCheck, contactCheck, languageCheck, restrictedCheck];
  const pagesChecked = pages.map((p) => ({ label: p.label, url: p.url }));
  const pagesFailed = failedPages.map((p) => ({ label: p.label, url: p.url, reason: p.reason }));

  return res.status(200).json({ target, checks, pagesChecked, pagesFailed, unreachable: false });
};
