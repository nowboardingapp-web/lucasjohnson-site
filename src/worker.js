// lucasjohnson.app Worker
// - Serves the static site from public/ (assets are matched first; this code only runs for the daily job
//   and for requests that don't match a file).
// - Every morning, emails yesterday's Web Analytics numbers, broken down by page, app, referrer, country and device.
//
// Settings (Cloudflare dashboard › Workers & Pages › lucasjohnson-site › Settings › Variables and Secrets):
//   CF_API_TOKEN   (secret)  API token with "Account Analytics: Read"
//   CF_ACCOUNT_ID  (text)    your Cloudflare account ID
//   CF_SITE_TAG    (text)    the Web Analytics site tag for lucasjohnson.app
//   STATS_TO       (text)    where to send the email (must be a verified Email Routing destination)
//   STATS_FROM     (text)    optional, defaults to stats@lucasjohnson.app
//   STATS_KEY      (secret)  optional, lets you send a test email by opening /__stats?key=<STATS_KEY>
import { EmailMessage } from "cloudflare:email";

const TZ = "America/New_York";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) return new Response("Not found", { status: 404 });
      try {
        const report = await buildReport(env);
        if (url.searchParams.get("send") === "1") { await sendReport(env, report); return new Response("Sent to " + env.STATS_TO); }
        return new Response(report.html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch (e) { return new Response("Error: " + e.message, { status: 500 }); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildReport(env).then((r) => sendReport(env, r)));
  },
};

// ---------- data ----------
const QUERY = `query($acct: string!, $site: string!, $s: Time!, $e: Time!, $ps: Time!, $ws: Time!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    day:   rumPageloadEventsAdaptiveGroups(limit: 1,  filter: { siteTag: $site, datetime_geq: $s,  datetime_lt: $e }) { count sum { visits } }
    prev:  rumPageloadEventsAdaptiveGroups(limit: 1,  filter: { siteTag: $site, datetime_geq: $ps, datetime_lt: $s }) { count sum { visits } }
    week:  rumPageloadEventsAdaptiveGroups(limit: 1,  filter: { siteTag: $site, datetime_geq: $ws, datetime_lt: $e }) { count sum { visits } }
    pages: rumPageloadEventsAdaptiveGroups(limit: 50, filter: { siteTag: $site, datetime_geq: $s,  datetime_lt: $e }, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
    refs:  rumPageloadEventsAdaptiveGroups(limit: 12, filter: { siteTag: $site, datetime_geq: $s,  datetime_lt: $e }, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
    ctry:  rumPageloadEventsAdaptiveGroups(limit: 8,  filter: { siteTag: $site, datetime_geq: $s,  datetime_lt: $e }, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
    dev:   rumPageloadEventsAdaptiveGroups(limit: 5,  filter: { siteTag: $site, datetime_geq: $s,  datetime_lt: $e }, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { deviceType } }
  } }
}`;

// Start of "today" in New York, as a UTC Date.
function nyMidnight(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const sinceMidnightMs = (Number(parts.hour) * 60 + Number(parts.minute)) * 60000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs);
}

const APPS = [["hingeworthy", "Hingeworthy"], ["now-boarding", "Now Boarding"], ["presspal", "PressPal"]];
function cleanPath(p) {
  let x = (p || "/").replace(/index\.html$/, "").replace(/\.html$/, "");
  if (x.length > 1) x = x.replace(/\/$/, "");
  return x || "/";
}
function appOf(p) {
  for (const [slug, name] of APPS) if (p === "/" + slug || p.startsWith("/" + slug + "/")) return name;
  if (p === "/") return "Home page";
  if (p.startsWith("/request")) return "Requests page";
  return "Other";
}

async function buildReport(env) {
  for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_SITE_TAG"]) if (!env[k]) throw new Error(k + " is not set");
  const end = nyMidnight(new Date());               // start of today
  const start = new Date(end.getTime() - 86400000);  // start of yesterday (DST days are off by an hour at most)
  const prevStart = new Date(start.getTime() - 86400000);
  const weekStart = new Date(end.getTime() - 7 * 86400000);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.CF_API_TOKEN },
    body: JSON.stringify({ query: QUERY, variables: { acct: env.CF_ACCOUNT_ID, site: env.CF_SITE_TAG, s: start.toISOString(), e: end.toISOString(), ps: prevStart.toISOString(), ws: weekStart.toISOString() } }),
  });
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  const a = json.data.viewer.accounts[0];
  const tot = (g) => ({ views: g[0]?.count || 0, visits: g[0]?.sum?.visits || 0 });
  const day = tot(a.day), prev = tot(a.prev), week = tot(a.week);

  const pages = new Map(), apps = new Map();
  for (const r of a.pages) {
    const p = cleanPath(r.dimensions.requestPath);
    const cur = pages.get(p) || { views: 0, visits: 0 };
    cur.views += r.count; cur.visits += r.sum.visits; pages.set(p, cur);
    const app = appOf(p);
    const ac = apps.get(app) || { views: 0, visits: 0 };
    ac.views += r.count; ac.visits += r.sum.visits; apps.set(app, ac);
  }
  const sortBy = (m) => [...m.entries()].sort((x, y) => y[1].views - x[1].views);
  const refs = a.refs.filter((r) => !/(^|\.)lucasjohnson\.app$/.test(r.dimensions.refererHost || "")).map((r) => [r.dimensions.refererHost || "Direct / unknown", r.sum.visits]);
  const ctry = a.ctry.map((r) => [r.dimensions.countryName || "Unknown", r.sum.visits]);
  const dev = a.dev.map((r) => [r.dimensions.deviceType || "Unknown", r.sum.visits]);

  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(new Date(start.getTime() + 12 * 3600000));
  const change = prev.visits ? Math.round(((day.visits - prev.visits) / prev.visits) * 100) : null;
  const changeText = change === null ? "" : ` (${change >= 0 ? "+" : ""}${change}% vs the day before)`;
  const subject = `lucasjohnson.app: ${day.visits} visit${day.visits === 1 ? "" : "s"} on ${dateLabel}`;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const table = (title, head, rows) => rows.length ? `<h3 style="margin:22px 0 6px;font-size:15px">${title}</h3><table style="border-collapse:collapse;width:100%;font-size:14px">` +
    `<tr>${head.map((h, i) => `<th style="text-align:${i ? "right" : "left"};color:#6b7280;font-weight:600;padding:4px 0;border-bottom:1px solid #e5e7eb">${h}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? "right" : "left"};padding:5px 0;border-bottom:1px solid #f1f2f4">${esc(c)}</td>`).join("")}</tr>`).join("") + `</table>` : "";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,sans-serif;color:#13151a">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:24px">
<p style="margin:0;color:#6b7280;font-size:13px">lucasjohnson.app · ${esc(dateLabel)}</p>
<p style="margin:8px 0 0;font-size:30px;font-weight:700">${day.visits} visits · ${day.views} page views</p>
<p style="margin:4px 0 0;color:#6b7280;font-size:14px">${esc(changeText.trim().replace(/^\(|\)$/g, ""))}${changeText ? " · " : ""}Last 7 days: ${week.visits} visits, ${week.views} page views</p>
${table("By app", ["App", "Visits", "Page views"], sortBy(apps).map(([k, v]) => [k, v.visits, v.views]))}
${table("By page", ["Page", "Visits", "Page views"], sortBy(pages).slice(0, 15).map(([k, v]) => [k, v.visits, v.views]))}
${table("Where visitors came from", ["Source", "Visits"], refs)}
${table("Countries", ["Country", "Visits"], ctry)}
${table("Devices", ["Device", "Visits"], dev)}
<p style="margin:22px 0 0;color:#9ca3af;font-size:12px">From Cloudflare Web Analytics. Your own visits are included.</p>
</div></body></html>`;
  const text = [`lucasjohnson.app, ${dateLabel}`, `${day.visits} visits, ${day.views} page views${changeText}`, `Last 7 days: ${week.visits} visits, ${week.views} page views`, "",
    "By app:", ...sortBy(apps).map(([k, v]) => `  ${k}: ${v.visits} visits, ${v.views} views`), "",
    "By page:", ...sortBy(pages).slice(0, 15).map(([k, v]) => `  ${k}: ${v.visits} visits, ${v.views} views`), "",
    "Sources:", ...refs.map(([k, v]) => `  ${k}: ${v}`), "", "Countries:", ...ctry.map(([k, v]) => `  ${k}: ${v}`), "", "Devices:", ...dev.map(([k, v]) => `  ${k}: ${v}`)].join("\n");
  return { subject, html, text };
}

// ---------- email ----------
function b64(str) {
  const bytes = new TextEncoder().encode(str); let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{76}/g, "$&\r\n");
}
async function sendReport(env, report) {
  if (!env.STATS_TO) throw new Error("STATS_TO is not set");
  const from = env.STATS_FROM || "stats@lucasjohnson.app";
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  const raw = [
    `From: lucasjohnson.app stats <${from}>`, `To: <${env.STATS_TO}>`,
    `Subject: =?UTF-8?B?${b64(report.subject).replace(/\r\n/g, "")}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@lucasjohnson.app>`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(report.text),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(report.html),
    `--${boundary}--`, "",
  ].join("\r\n");
  await env.EMAIL.send(new EmailMessage(from, env.STATS_TO, raw));
}
