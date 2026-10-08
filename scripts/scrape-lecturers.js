// Scrapes https://sibstrin.ru/timetable/lecturer/ - the PER-LECTURER
// timetable (as opposed to scrape-schedule.js, which scrapes ONE group at
// a time from /timetable/group/). Meant to run WEEKLY (see
// .github/workflows/update-teachers.yml), on the same self-hosted runner
// as the group scraper, for the same reason: the site blocks GitHub's
// cloud IPs, so this has to run from a normal residential connection.
//
//   npm install puppeteer-extra puppeteer-extra-plugin-stealth
//   node scripts/scrape-lecturers.js
//
// What it does, in order:
//   1. Opens the lecturer page and reads the FULL list of lecturer names
//      straight from the "Преподаватель" dropdown - no need to type them
//      in by hand.
//   2. For any name not already in teacher_roster, generates a random
//      access code and inserts it there (existing codes are left alone,
//      so re-running this never invalidates a code someone was already
//      emailed).
//   3. Selects each lecturer in turn, scrapes their 2-week table (same
//      parsing logic as the group scraper - copied here rather than
//      imported so this file can run standalone), and upserts every
//      lesson into schedule_slots. Each lesson's student-group label
//      (e.g. "128 гр.") is resolved against the `groups` table, CREATING
//      the group if it doesn't exist yet - this is how the group list
//      naturally grows beyond whatever Tim has entered by hand so far.
//
// IMPORTANT - same caveat as scrape-schedule.js: this was written without
// being able to test against the live site (it blocks fetches from
// outside a real browser/residential IP, sandboxes included). The cell
// text parsing in particular (classifyLecturerCell) is a best guess at
// the lecturer view's layout, based on the group view's real, confirmed
// layout - the first real run's debug-page.html is what tells us whether
// it needs adjusting, exactly like the group scraper did.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TARGET_URL = process.env.LECTURER_TIMETABLE_URL || "https://sibstrin.ru/timetable/lecturer/";
const HOMEPAGE_URL = "https://sibstrin.ru/";
const RUCAPTCHA_KEY = process.env.RUCAPTCHA_KEY || "";
const RUCAPTCHA_HOST = "https://rucaptcha.com";
// Scraping every lecturer's full 2-week table is a lot of page loads - cap
// it per run (env-overridable) so a first test run doesn't take hours.
const MAX_LECTURERS_PER_RUN = parseInt(process.env.MAX_LECTURERS_PER_RUN || "9999", 10);
// GROUPS MODE (used by update-schedule.yml): don't touch the database at all.
// Just open the timetable of every teacher who has an access code in
// teacher_roster (i.e. the app's own teachers), note every student group
// that appears in it, and write those group numbers to lecturer-groups.txt.
// The group scraper then scrapes each of those groups with its proven
// parser - so a teacher automatically sees lessons in ALL their groups,
// and adding a teacher to teacher_roster is the only step ever needed.
const GROUPS_MODE = process.env.LECTURER_GROUPS_MODE === "1";
const GROUPS_OUT_FILE = path.join(__dirname, "..", "lecturer-groups.txt");

// "Валиева Елена Николаевна" / "Валиева Е. Н." / "Валиева Е.Н." -> "валиеваен"
function nameKey(txt) {
  var parts = String(txt || "").replace(/\u00a0/g, " ").replace(/ё/g, "е").replace(/Ё/g, "Е")
    .replace(/[\s.]+/g, " ").trim().split(" ");
  return (parts[0] + (parts[1] || "").charAt(0) + (parts[2] || "").charAt(0)).toLowerCase();
}

// Every student group number mentioned in one cell, e.g.
// "121, 122, 124, 128 гр. История России ..." -> ["121","122","124","128"],
// "128(1) гр. ..." -> ["128"]. Only numbers directly before "гр" count, so
// room numbers ("306 ауд.") and dates are never mistaken for groups.
function groupsInCell(text) {
  var out = [];
  var clean = String(text || "").replace(/\(\d+\)/g, "");
  var re = /((?:\d{2,4}\s*,\s*)*\d{2,4})\s*гр/g;
  var m;
  while ((m = re.exec(clean))) {
    m[1].split(",").forEach(function (n) { n = n.trim(); if (n && out.indexOf(n) === -1) out.push(n); });
  }
  return out;
}

const TIMES = [
  "08:30-10:00", "10:15-11:45", "12:00-13:30", "14:10-15:35",
  "15:45-17:10", "17:20-18:45", "18:50-20:15", "20:20-21:50"
];
const DAY_WORDS = { "пн": 0, "понедельник": 0, "вт": 1, "вторник": 1, "ср": 2, "среда": 2, "чт": 3, "четверг": 3, "пт": 4, "пятница": 4, "сб": 5, "суббота": 5 };

// A lecturer's cell shows which GROUP the lesson is for instead of which
// teacher (that's a given - it's THEIR page). Otherwise the same shape as
// the group view: a room/audience line, a subject line, and a groups line.
function classifyLecturerCell(lines) {
  var out = { groups: "", subject: "", room: "" };
  lines.forEach(function (raw) {
    var l = raw.trim();
    if (!l) return;
    if (/^[\d\s,()]+гр\.?$/i.test(l) && !out.groups) { out.groups = l; return; }
    if ((/^(лек|пр|лаб)\.?\s*\//i.test(l) || /ауд\.?$/i.test(l)) && !out.room) { out.room = l; return; }
    out.subject = out.subject ? out.subject + " " + l : l;
  });
  return out;
}

function emptyPart() { return { groups: "", subject: "", room: "" }; }
function emptyWeeks() {
  var weeks = [{ days: [] }, { days: [] }];
  for (var w = 0; w < 2; w++) {
    for (var d = 0; d < 6; d++) {
      weeks[w].days.push({ date: "", slots: TIMES.map(function () { return { split: false, parts: [emptyPart()] }; }) });
    }
  }
  return weeks;
}

function isoDate(ddmmyyyy) {
  var m = ddmmyyyy.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}

function randomCode() {
  // 6 chars, no ambiguous 0/O/1/I - easy to read out or type from an email.
  var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var out = "";
  var bytes = crypto.randomBytes(6);
  for (var i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function run() {
  const puppeteer = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(StealthPlugin());
  const browser = await puppeteer.launch({
    headless: false, // see scrape-schedule.js's comment - headless is more detectable here
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1400, height: 1000 });

  console.log("Opening", TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // ---------- captcha/gate handling - identical approach to scrape-schedule.js ----------
  function rucaptchaRequest(url) {
    return new Promise(function (resolve, reject) {
      require("https").get(url, function (res) {
        var body = "";
        res.on("data", function (chunk) { body += chunk; });
        res.on("end", function () {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("Bad response from rucaptcha: " + body)); }
        });
      }).on("error", reject);
    });
  }
  async function findYandexSitekey() {
    return page.evaluate(function () {
      var el = document.querySelector("[data-sitekey]");
      if (el) return el.getAttribute("data-sitekey");
      var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe"));
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || "";
        if (src.indexOf("captcha.yandex") !== -1) {
          var m = src.match(/[?&]sitekey=([^&]+)/);
          if (m) return decodeURIComponent(m[1]);
        }
      }
      var m2 = document.documentElement.innerHTML.match(/ysc1_[A-Za-z0-9_-]+/);
      if (m2) return m2[0];
      return null;
    });
  }
  async function solveYandexCaptcha() {
    if (!RUCAPTCHA_KEY) { console.log("No RUCAPTCHA_KEY set - can't auto-solve a real captcha."); return false; }
    var sitekey = await findYandexSitekey();
    if (!sitekey) { console.log("No Yandex SmartCaptcha sitekey found - nothing to solve here."); return false; }
    console.log("Found Yandex SmartCaptcha sitekey, sending to rucaptcha.com...");
    var submitUrl = RUCAPTCHA_HOST + "/in.php?key=" + encodeURIComponent(RUCAPTCHA_KEY) +
      "&method=yandex&sitekey=" + encodeURIComponent(sitekey) + "&pageurl=" + encodeURIComponent(page.url()) + "&json=1";
    var submitRes = await rucaptchaRequest(submitUrl);
    if (submitRes.status !== 1) { console.log("rucaptcha rejected the request: " + JSON.stringify(submitRes)); return false; }
    var taskId = submitRes.request;
    console.log("rucaptcha task id " + taskId + " - waiting (usually 10-40s)...");
    var token = null;
    for (var attempt = 0; attempt < 24 && !token; attempt++) {
      await new Promise(function (r) { setTimeout(r, 5000); });
      var pollUrl = RUCAPTCHA_HOST + "/res.php?key=" + encodeURIComponent(RUCAPTCHA_KEY) + "&action=get&id=" + taskId + "&json=1";
      var pollRes = await rucaptchaRequest(pollUrl);
      if (pollRes.status === 1) token = pollRes.request;
      else if (pollRes.request !== "CAPCHA_NOT_READY") { console.log("rucaptcha error: " + JSON.stringify(pollRes)); return false; }
    }
    if (!token) { console.log("Gave up waiting for rucaptcha after 2 minutes."); return false; }
    console.log("Got a solved token, injecting it into the page...");
    return page.evaluate(function (tok) {
      var input = document.querySelector('input[name="smart-token"]');
      if (input) {
        input.value = tok;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        var cbNames = ["smartCaptchaCallback", "onCaptchaSuccess", "captchaCallback"];
        for (var i = 0; i < cbNames.length; i++) { if (typeof window[cbNames[i]] === "function") { window[cbNames[i]](tok); break; } }
        var form = input.closest("form");
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
        return true;
      }
      return false;
    }, token);
  }
  async function tryDismissGate() {
    var solved = await solveYandexCaptcha();
    if (solved) return "(captcha solved via rucaptcha)";
    return page.evaluate(function () {
      var keywordRe = /(не робот|я человек|подтвердить|продолжить|войти|verify|i am human|i'm not a robot|continue|confirm|accept|соглас)/i;
      var candidates = Array.prototype.slice.call(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], label, span, div'));
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].innerText || candidates[i].value || "").trim();
        if (text && text.length < 60 && keywordRe.test(text)) { candidates[i].click(); return text; }
      }
      var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
      if (boxes.length === 1 && !boxes[0].checked) { boxes[0].click(); return "(checkbox)"; }
      return null;
    });
  }

  await tryDismissGate();
  await new Promise(function (r) { setTimeout(r, 500); });

  // ---------- Step 1: read every lecturer name straight from the dropdown ----------
  function findLecturerSelect() {
    return page.evaluate(function () {
      var selects = Array.prototype.slice.call(document.querySelectorAll("select"));
      // Prefer one whose nearby label mentions "преподавател"; fall back to
      // "whichever select has the most options" if that heuristic misses.
      var best = null, bestCount = -1;
      selects.forEach(function (sel) {
        var opts = Array.prototype.slice.call(sel.options).map(function (o) { return o.textContent.trim(); }).filter(Boolean);
        var label = (sel.closest("label") || sel.parentElement || {}).textContent || "";
        var looksRight = /преподавател/i.test(label) || /преподавател/i.test(sel.name || "") || /преподавател/i.test(sel.id || "");
        if (looksRight) { best = opts; bestCount = 999999; }
        else if (opts.length > bestCount) { best = opts; bestCount = opts.length; }
      });
      return best || [];
    });
  }

  var lecturerNames = await findLecturerSelect();
  // Drop an empty/placeholder first option like "Выберите преподавателя".
  lecturerNames = lecturerNames.filter(function (n) { return n && !/выбер/i.test(n); });
  console.log("Found " + lecturerNames.length + " lecturers in the dropdown.");
  if (!lecturerNames.length) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, "..", "debug-lecturer-page.html"), html);
    console.error("Could not find the lecturer dropdown at all. See debug-lecturer-page.html.");
    await browser.close();
    process.exit(1);
  }

  // ---------- Step 2: make sure every one of them has a teacher_roster row ----------
  var newCodes = GROUPS_MODE ? [] : await ensureRosterRows(lecturerNames);
  if (newCodes.length) {
    console.log("\n" + newCodes.length + " NEW lecturers were added to teacher_roster with a fresh code each:");
    newCodes.forEach(function (r) { console.log("  " + r.full_name + " -> " + r.access_code); });
    console.log("(Tim: query 'select full_name, access_code from teacher_roster' any time to see everyone's code and email it out.)\n");
  } else if (!GROUPS_MODE) {
    console.log("No new lecturers - teacher_roster already has everyone.");
  }

  // ---------- Step 3: scrape each lecturer's own 2-week table ----------
  async function selectLecturerAndSubmit(name) {
    var selected = await page.evaluate(function (n) {
      var selects = Array.prototype.slice.call(document.querySelectorAll("select"));
      for (var i = 0; i < selects.length; i++) {
        var sel = selects[i];
        var opts = Array.prototype.slice.call(sel.options);
        var match = opts.filter(function (o) { return o.textContent.trim() === n; })[0];
        if (match) { sel.value = match.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, name);
    if (!selected) return false;
    return page.evaluate(function () {
      var candidates = Array.prototype.slice.call(document.querySelectorAll('button, input[type="submit"], a'));
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].innerText || candidates[i].value || "").trim();
        if (/показать/i.test(text)) { candidates[i].click(); return true; }
      }
      var anySelect = document.querySelector("select");
      var form = anySelect ? anySelect.closest("form") : null;
      if (form) { form.submit(); return true; }
      return false;
    });
  }

  async function extractBestTable() {
    var tables = await page.evaluate(function () {
      function gridFromTable(table) {
        var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
        var grid = [];
        var pending = [];
        rows.forEach(function (tr, rIdx) {
          grid[rIdx] = grid[rIdx] || [];
          pending.forEach(function (p) { if (p.remaining > 0) grid[rIdx][p.col] = p.text; });
          var col = 0;
          var newPending = [];
          Array.prototype.slice.call(tr.children).forEach(function (td) {
            while (grid[rIdx][col] !== undefined) col++;
            var rowspan = parseInt(td.getAttribute("rowspan") || "1", 10);
            var colspan = parseInt(td.getAttribute("colspan") || "1", 10);
            var text = td.innerText || td.textContent || "";
            for (var cs = 0; cs < colspan; cs++) {
              grid[rIdx][col + cs] = text;
              if (rowspan > 1) newPending.push({ col: col + cs, remaining: rowspan - 1, text: text });
            }
            col += colspan;
          });
          pending.forEach(function (p) { p.remaining--; });
          pending = pending.filter(function (p) { return p.remaining > 0; }).concat(newPending);
        });
        return grid;
      }
      return Array.prototype.slice.call(document.querySelectorAll("table")).map(gridFromTable);
    });
    for (var t = 0; t < tables.length; t++) {
      var grid = tables[t];
      var headerText = (grid[0] || []).join(" ").toLowerCase();
      var leftColText = grid.map(function (r) { return (r[0] || "") + " " + (r[1] || ""); }).join(" ").toLowerCase();
      var timeHits = (headerText.match(/\d{1,2}[:.]\d{2}/g) || []).length;
      var dayHits = Object.keys(DAY_WORDS).filter(function (d) { return leftColText.indexOf(d) !== -1; }).length;
      if (timeHits >= 4 && dayHits >= 3) return grid;
    }
    return null;
  }

  function gridToWeeks(grid) {
    var weeks = emptyWeeks();
    var curWeek = 0, curDay = -1;
    grid.forEach(function (row) {
      var first = (row[0] || "").trim().toLowerCase();
      if (/^\d+\s*недел/.test(first)) { curWeek = /^2/.test(first) ? 1 : 0; curDay = -1; return; }
      var dayMatch = Object.keys(DAY_WORDS).filter(function (d) { return first.indexOf(d) === 0; })[0];
      if (dayMatch !== undefined) {
        curDay = DAY_WORDS[dayMatch];
        var dm = row.join(" ").match(/\d{1,2}\.\d{1,2}\.\d{4}/);
        if (dm) weeks[curWeek].days[curDay].date = dm[0];
      }
      if (curDay < 0) return;
      var dataCols = row.slice(Math.max(0, row.length - TIMES.length));
      dataCols.forEach(function (cellText, i) {
        if (i >= 8 || !cellText) return;
        var lines = cellText.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
        if (!lines.length) return;
        var parsed = classifyLecturerCell(lines);
        if (!parsed.subject && !parsed.groups) return;
        var slot = weeks[curWeek].days[curDay].slots[i];
        var firstEmpty = !slot.parts[0].subject && !slot.parts[0].groups;
        if (firstEmpty) slot.parts[0] = parsed;
        else if (slot.parts[0].groups !== parsed.groups) { slot.split = true; slot.parts[1] = parsed; }
      });
    });
    return weeks;
  }

  if (GROUPS_MODE) {
    var roster = await sbFetch("/rest/v1/teacher_roster?select=full_name");
    var wanted = (roster || []).map(function (r) { return r.full_name; });
    console.log("App teachers (teacher_roster): " + wanted.join("; "));
    var allGroups = [];
    for (var wi = 0; wi < wanted.length; wi++) {
      var key = nameKey(wanted[wi]);
      var dropdownName = lecturerNames.filter(function (n) { return nameKey(n) === key; })[0];
      if (!dropdownName) { console.log("  " + wanted[wi] + ": not found in the lecturer dropdown, skipping."); continue; }

      var picked = await selectLecturerAndSubmit(dropdownName);
      if (!picked) { console.log("  " + dropdownName + ": could not select in the form, skipping."); continue; }
      await new Promise(function (r) { setTimeout(r, 1200); });
      await tryDismissGate();
      await new Promise(function (r) { setTimeout(r, 500); });
      try { await page.waitForSelector("table", { timeout: 15000 }); }
      catch (e) { console.log("  " + dropdownName + ": no table appeared, skipping."); continue; }

      var cells = await page.evaluate(function () {
        return Array.prototype.slice.call(document.querySelectorAll("td")).map(function (td) { return td.innerText || td.textContent || ""; });
      });
      var mine = [];
      cells.forEach(function (c) { groupsInCell(c).forEach(function (g) { if (mine.indexOf(g) === -1) mine.push(g); }); });
      console.log("  " + dropdownName + " teaches groups: " + (mine.join(", ") || "(none found)"));
      mine.forEach(function (g) { if (allGroups.indexOf(g) === -1) allGroups.push(g); });

      await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await tryDismissGate();
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    if (!allGroups.length) {
      fs.writeFileSync(path.join(__dirname, "..", "debug-lecturer-page.html"), await page.content());
    }
    fs.writeFileSync(GROUPS_OUT_FILE, allGroups.join("\n"));
    console.log("\nGroups to scrape: " + (allGroups.join(", ") || "(none)") + " -> " + GROUPS_OUT_FILE);
    await browser.close();
    return;
  }

  var lecturersToScrape = lecturerNames.slice(0, MAX_LECTURERS_PER_RUN);
  var totalWritten = 0;
  for (var li = 0; li < lecturersToScrape.length; li++) {
    var lecturerName = lecturersToScrape[li];
    console.log("\n[" + (li + 1) + "/" + lecturersToScrape.length + "] " + lecturerName);

    var ok = await selectLecturerAndSubmit(lecturerName);
    if (!ok) { console.log("  could not select this lecturer in the form, skipping."); continue; }
    await new Promise(function (r) { setTimeout(r, 1200); });
    await tryDismissGate();
    await new Promise(function (r) { setTimeout(r, 500); });

    try { await page.waitForSelector("table", { timeout: 10000 }); }
    catch (e) { console.log("  no table appeared for this lecturer, skipping."); continue; }

    var grid = await extractBestTable();
    if (!grid) { console.log("  page had a table but it didn't look like a timetable, skipping."); continue; }

    var weeks = gridToWeeks(grid);
    var written = await writeLecturerWeeksToSupabase(lecturerName, weeks);
    totalWritten += written;
    console.log("  wrote " + written + " lesson(s).");

    // Go back to the lecturer list page for the next iteration.
    await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await tryDismissGate();
    await new Promise(function (r) { setTimeout(r, 400); });
  }

  await browser.close();
  console.log("\nDone. " + totalWritten + " total lesson-rows written across " + lecturersToScrape.length + " lecturer(s).");
}

// ---------- Supabase (plain REST + service role key) ----------
var SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path_, options) {
  options = options || {};
  var headers = Object.assign({ "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY, "Content-Type": "application/json" }, options.headers || {});
  var res = await fetch(SUPABASE_URL + path_, Object.assign({}, options, { headers: headers }));
  if (!res.ok) { var body = await res.text(); throw new Error("Supabase " + path_ + " -> " + res.status + ": " + body); }
  var text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function ensureRosterRows(names) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  var existing = await sbFetch("/rest/v1/teacher_roster?select=full_name");
  var have = {};
  (existing || []).forEach(function (r) { have[r.full_name] = true; });
  var created = [];
  for (var i = 0; i < names.length; i++) {
    if (have[names[i]]) continue;
    var code = randomCode();
    await sbFetch("/rest/v1/teacher_roster", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({ full_name: names[i], access_code: code })
    });
    created.push({ full_name: names[i], access_code: code });
  }
  return created;
}

async function ensureGroupId(groupLabel, cache) {
  // groupLabel looks like "128 гр." or "128(1) гр." - the group's bare name
  // is whatever comes before " гр" (matches how the group scraper's own
  // GROUP_NAME values are stored, e.g. "128").
  var name = (groupLabel || "").replace(/\s*\(.*?\)/, "").replace(/гр\.?$/i, "").trim();
  if (!name) return null;
  if (cache[name]) return cache[name];
  var rows = await sbFetch("/rest/v1/groups?name=eq." + encodeURIComponent(name) + "&select=id");
  var id;
  if (rows && rows.length) {
    id = rows[0].id;
  } else {
    var created = await sbFetch("/rest/v1/groups", {
      method: "POST",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ name: name })
    });
    id = created[0].id;
    console.log('  (created new group "' + name + '" - first time we\'ve seen it)');
  }
  cache[name] = id;
  return id;
}

async function writeLecturerWeeksToSupabase(lecturerName, weeks) {
  var groupIdCache = {};
  var written = 0;

  for (var w = 0; w < weeks.length; w++) {
    for (var d = 0; d < weeks[w].days.length; d++) {
      var day = weeks[w].days[d];
      for (var s = 0; s < day.slots.length; s++) {
        var slot = day.slots[s];
        for (var pi = 0; pi < slot.parts.length; pi++) {
          var part = slot.parts[pi];
          if (!part.subject && !part.groups) continue;

          var groupId = await ensureGroupId(part.groups, groupIdCache);
          if (!groupId) continue; // couldn't tell which group this lesson is for - skip rather than guess

          var teacherRows = await sbFetch(
            "/rest/v1/teachers?on_conflict=group_id,full_name",
            { method: "POST", headers: { "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ group_id: groupId, full_name: lecturerName }) }
          );
          var teacherId = teacherRows && teacherRows[0] ? teacherRows[0].id : null;

          await sbFetch(
            "/rest/v1/schedule_slots?on_conflict=group_id,week_number,day_index,slot_index,part_index",
            {
              method: "POST",
              headers: { "Prefer": "resolution=merge-duplicates" },
              body: JSON.stringify({
                group_id: groupId,
                week_number: w + 1,
                day_index: d,
                slot_index: s,
                part_index: pi,
                lesson_date: day.date ? isoDate(day.date) : null,
                subject: part.subject || null,
                teacher_id: teacherId,
                room: part.room || null,
                groups_label: part.groups || null,
                updated_at: new Date().toISOString()
              })
            }
          );
          written++;
        }
      }
    }
  }
  return written;
}

if (require.main === module) {
  run().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  classifyLecturerCell, isoDate, randomCode, nameKey, groupsInCell,
  __test: { ensureRosterRows, ensureGroupId, writeLecturerWeeksToSupabase }
};
