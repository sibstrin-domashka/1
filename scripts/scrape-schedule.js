// Scrapes the university timetable page and writes schedule.json in the
// format the Домашка app expects. Meant to run on a schedule via
// GitHub Actions (see .github/workflows/update-schedule.yml), but you
// can also run it locally:
//
//   npm install puppeteer
//   node scripts/scrape-schedule.js
//
// IMPORTANT — this is a first version. It was written without being able
// to test against the live site (the site blocks automated fetches from
// outside a real browser, and that includes the sandbox this was written
// in). It uses a real headless Chrome (via Puppeteer) so it should look
// like a normal visitor, and it always saves debug-page.html next to
// schedule.json so mistakes are easy to diagnose. If the first run
// doesn't produce a correct schedule.json, send back debug-page.html
// (or just the Action's log) and the parsing logic below can be fixed
// to match the real page structure.

const fs = require("fs");
const path = require("path");

const TARGET_URL =
  process.env.TIMETABLE_URL ||
  "https://sibstrin.ru/timetable/group/";
const HOMEPAGE_URL = "https://sibstrin.ru/";
const GROUP_NAME = process.env.TIMETABLE_GROUP_NAME || "128";
const RUCAPTCHA_KEY = process.env.RUCAPTCHA_KEY || "";
const RUCAPTCHA_HOST = "https://rucaptcha.com";

const TIMES = [
  "08:30-10:00", "10:15-11:45", "12:00-13:30", "14:10-15:35",
  "15:45-17:10", "17:20-18:45", "18:50-20:15", "20:20-21:50"
];
const DAY_WORDS = { "пн": 0, "понедельник": 0, "вт": 1, "вторник": 1, "ср": 2, "среда": 2, "чт": 3, "четверг": 3, "пт": 4, "пятница": 4, "сб": 5, "суббота": 5 };

// The site has shipped two cell formats so far:
//   old: one hyphen-delimited line  "121, 128 гр.-Физика-Глазкова Л. В.-Лек./373 ауд."
//   new: separate lines, no hyphens  "121, 128 гр." / "Физика" / "Глазкова Л. В." / "Лек./373 ауд."
// Splitting on hyphens silently broke on the new format (the whole cell
// landed in `subject`, teacher stayed empty). Instead we anchor on the two
// things that never change: the groups end with "гр.", and the teacher is
// "Фамилия И. О." - the only place initials appear. Subject is whatever sits
// between them, room is whatever follows the teacher. A hyphenated subject
// ("Научно-исследовательская работа") and a hyphenated surname both survive.
var TEACHER_RE = /([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s+([А-ЯЁ])\.\s*([А-ЯЁ])\.?/;
var SEP_RE = /^[\s\-\u2013\u2014]+|[\s\-\u2013\u2014]+$/g;

function classifyLines(lines) {
  var out = { groups: "", subject: "", teacher: "", room: "" };
  var text = lines.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return out;

  // Old single-line format: hyphens are the separators, split from both ends.
  if (/гр\.\s*-/.test(text)) {
    var parts = text.split("-").map(function (p) { return p.trim(); }).filter(function (p) { return p.length; });
    if (parts.length >= 4) {
      out.groups = parts[0];
      out.room = parts[parts.length - 1];
      out.teacher = parts[parts.length - 2];
      out.subject = parts.slice(1, parts.length - 2).join("-");
      var tm = out.teacher.match(TEACHER_RE);
      if (tm) out.teacher = tm[1] + " " + tm[2] + ". " + tm[3] + ".";
      return out;
    }
  }

  var rest = text;
  var g = rest.match(/^([0-9(),\s]+гр\.)/);
  if (g) {
    out.groups = g[1].trim();
    rest = rest.slice(g[0].length);
  }

  var m = rest.match(TEACHER_RE);
  if (m) {
    out.subject = rest.slice(0, m.index).replace(SEP_RE, "");
    // Always store as "Фамилия И. О." so the same person is never saved twice
    // under slightly different spellings ("К. Н" vs "К.Н." vs "К. Н.").
    out.teacher = m[1] + " " + m[2] + ". " + m[3] + ".";
    out.room = rest.slice(m.index + m[0].length).replace(SEP_RE, "");
  } else {
    // No recognisable teacher - keep the text as the subject rather than
    // silently dropping a real (if unusual) cell.
    out.subject = rest.replace(SEP_RE, "");
  }
  return out;
}

function emptyPart() { return { groups: "", subject: "", teacher: "", room: "" }; }
function emptyWeeks() {
  var weeks = [{ days: [] }, { days: [] }];
  for (var w = 0; w < 2; w++) {
    for (var d = 0; d < 6; d++) {
      weeks[w].days.push({ date: "", slots: TIMES.map(function () { return { split: false, parts: [emptyPart()] }; }) });
    }
  }
  return weeks;
}

async function run() {
  // puppeteer-extra + stealth plugin masks common automation fingerprints
  // (navigator.webdriver, missing plugins/mimeTypes, odd permissions
  // behavior, etc.) that bot-detection systems commonly check for -
  // plain Puppeteer is trivially detectable by those checks.
  const puppeteer = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(StealthPlugin());
  const browser = await puppeteer.launch({
    // Headless Chrome has technical fingerprints (e.g. software/SwiftShader
    // GPU rendering) that survive the stealth plugin's patching and get
    // caught by more advanced bot-detection - confirmed by real Chrome on
    // this exact machine/network working fine while headless Puppeteer did
    // not. A real, visible browser window sidesteps that entirely. This
    // will briefly pop up a real Chrome window when the runner executes.
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1400, height: 1000 });

  console.log("Opening", TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // ---------- Real captcha solving via rucaptcha.com (Yandex SmartCaptcha) ----------
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
      // Strategy 1: an element with a data-sitekey attribute (the standard
      // way Yandex SmartCaptcha widgets are marked up).
      var el = document.querySelector("[data-sitekey]");
      if (el) return el.getAttribute("data-sitekey");
      // Strategy 2: an iframe whose src embeds the sitekey as a query param.
      var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe"));
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || "";
        if (src.indexOf("captcha.yandex") !== -1) {
          var m = src.match(/[?&]sitekey=([^&]+)/);
          if (m) return decodeURIComponent(m[1]);
        }
      }
      // Strategy 3: a "ysc1_..." style key sitting anywhere in the raw HTML
      // (inline script config, etc.)
      var m2 = document.documentElement.innerHTML.match(/ysc1_[A-Za-z0-9_-]+/);
      if (m2) return m2[0];
      return null;
    });
  }

  async function solveYandexCaptcha() {
    if (!RUCAPTCHA_KEY) {
      console.log("No RUCAPTCHA_KEY set - can't auto-solve a real captcha.");
      return false;
    }
    var sitekey = await findYandexSitekey();
    if (!sitekey) {
      console.log("No Yandex SmartCaptcha sitekey found on the page - nothing to solve here.");
      return false;
    }
    console.log("Found Yandex SmartCaptcha sitekey, sending to rucaptcha.com...");

    var submitUrl = RUCAPTCHA_HOST + "/in.php?key=" + encodeURIComponent(RUCAPTCHA_KEY) +
      "&method=yandex&sitekey=" + encodeURIComponent(sitekey) +
      "&pageurl=" + encodeURIComponent(page.url()) + "&json=1";
    var submitRes = await rucaptchaRequest(submitUrl);
    if (submitRes.status !== 1) {
      console.log("rucaptcha rejected the request: " + JSON.stringify(submitRes));
      return false;
    }
    var taskId = submitRes.request;
    console.log("rucaptcha task id " + taskId + " - waiting for a human worker to solve it (usually 10-40s)...");

    var token = null;
    for (var attempt = 0; attempt < 24 && !token; attempt++) {
      await new Promise(function (r) { setTimeout(r, 5000); });
      var pollUrl = RUCAPTCHA_HOST + "/res.php?key=" + encodeURIComponent(RUCAPTCHA_KEY) +
        "&action=get&id=" + taskId + "&json=1";
      var pollRes = await rucaptchaRequest(pollUrl);
      if (pollRes.status === 1) {
        token = pollRes.request;
      } else if (pollRes.request !== "CAPCHA_NOT_READY") {
        console.log("rucaptcha error while polling: " + JSON.stringify(pollRes));
        return false;
      }
    }
    if (!token) {
      console.log("Gave up waiting for rucaptcha after 2 minutes.");
      return false;
    }
    console.log("Got a solved token, injecting it into the page...");

    var applied = await page.evaluate(function (tok) {
      var input = document.querySelector('input[name="smart-token"]');
      if (input) {
        input.value = tok;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Yandex SmartCaptcha widgets are usually configured with a callback
      // function name; try the common global names if present.
      var cbNames = ["smartCaptchaCallback", "onCaptchaSuccess", "captchaCallback"];
      for (var i = 0; i < cbNames.length; i++) {
        if (typeof window[cbNames[i]] === "function") { window[cbNames[i]](tok); break; }
      }
      // Also try submitting the enclosing form directly, in case the site
      // just checks the hidden field's value on submit.
      if (input) {
        var form = input.closest("form");
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
        return true;
      }
      return false;
    }, token);

    if (!applied) {
      console.log("Solved the captcha but couldn't find the smart-token field to apply it to.");
    }
    return applied;
  }

  // Some sites show a one-time "confirm you're not a robot" / "continue"
  // button to automated browsers even without a real captcha. Try clicking
  // anything that looks like that, a few times, before giving up.
  async function tryDismissGate() {
    var solved = await solveYandexCaptcha();
    if (solved) return "(captcha solved via rucaptcha)";
    return page.evaluate(function () {
      var keywordRe = /(не робот|я человек|подтвердить|продолжить|войти|verify|i am human|i'm not a robot|continue|confirm|accept|соглас)/i;
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], label, span, div')
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.innerText || el.value || "").trim();
        if (text && text.length < 60 && keywordRe.test(text)) {
          el.click();
          return text;
        }
      }
      // Fallback: a lone checkbox with no matching label text nearby
      // (common for lightweight "I'm not a robot" gates).
      var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
      if (boxes.length === 1 && !boxes[0].checked) {
        boxes[0].click();
        return "(checkbox)";
      }
      return null;
    });
  }

  await tryDismissGate();
  await new Promise(function (r) { setTimeout(r, 500); });

  async function clickScheduleLinkFromHomepage() {
    console.log("Looking for the 'Расписание обучения группы' link on the homepage...");
    var linkClicked = await page.evaluate(function () {
      var candidates = Array.prototype.slice.call(document.querySelectorAll("a"));
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].textContent || "").trim().toLowerCase();
        if (text.indexOf("расписание") !== -1 && text.indexOf("групп") !== -1 && text.indexOf("сесси") === -1) {
          candidates[i].click();
          return true;
        }
      }
      return false;
    });
    if (!linkClicked) {
      console.log("Could not find the 'Расписание обучения группы' link on the homepage.");
      return false;
    }
    console.log("Clicked the link, waiting for the schedule page to load...");
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 });
    } catch (e) {
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
    await tryDismissGate();
    await new Promise(function (r) { setTimeout(r, 500); });
    return true;
  }

  // The site expects a real form submission: pick the group from the
  // "Учебная группа" dropdown by its visible text (works for ANY group,
  // not just one hardcoded id), then click "Показать".
  async function selectGroupAndSubmit(groupName) {
    var selected = await page.evaluate(function (name) {
      var selects = Array.prototype.slice.call(document.querySelectorAll("select"));
      for (var i = 0; i < selects.length; i++) {
        var sel = selects[i];
        var opts = Array.prototype.slice.call(sel.options);
        var match = opts.filter(function (o) { return o.textContent.trim() === name; })[0];
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, groupName);

    if (!selected) return false;

    return page.evaluate(function () {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type="submit"], a')
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.innerText || el.value || "").trim();
        if (/показать/i.test(text)) { el.click(); return true; }
      }
      var anySelect = document.querySelector("select");
      var form = anySelect ? anySelect.closest("form") : null;
      if (form) { form.submit(); return true; }
      return false;
    });
  }


  console.log("Selecting group '" + GROUP_NAME + "' in the form...");
  var formOk = await selectGroupAndSubmit(GROUP_NAME);
  if (!formOk) {
    console.log("Could not find/select group '" + GROUP_NAME + "' directly at " + TARGET_URL + " - trying via the homepage instead.");
    await page.goto(HOMEPAGE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await tryDismissGate();
    await new Promise(function (r) { setTimeout(r, 500); });
    var viaHomepage = await clickScheduleLinkFromHomepage();
    if (viaHomepage) {
      formOk = await selectGroupAndSubmit(GROUP_NAME);
      if (!formOk) {
        console.log("Still could not find/select group '" + GROUP_NAME + "' after going via the homepage.");
      }
    }
  }
  if (formOk) {
    await new Promise(function (r) { setTimeout(r, 1500); });
  }

  var tableFound = false;
  for (var attempt = 0; attempt < 3 && !tableFound; attempt++) {
    try {
      await page.waitForSelector("table", { timeout: 15000 });
      tableFound = true;
    } catch (e) {
      var clickedText = await tryDismissGate();
      if (clickedText) {
        console.log('Attempt ' + (attempt + 1) + ': no table yet, clicked a button that said "' + clickedText + '", trying again.');
        await new Promise(function (r) { setTimeout(r, 2000); });
      } else {
        console.log("Attempt " + (attempt + 1) + ": no table yet, and nothing obvious to click.");
        break;
      }
    }
  }

  if (!tableFound) {
    // Print a visible snippet of whatever IS on the page, straight into the
    // Action log, so this can be diagnosed from the log screenshot alone -
    // no need to download and unzip the debug-page.html artifact.
    var bodySnippet = await page.evaluate(function () {
      return (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600);
    });
    console.log("No <table> appeared. Visible page text right now:");
    console.log(bodySnippet || "(page body is empty)");
  }

  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, "..", "debug-page.html"), html);

  // Extract every table on the page as a rowspan/colspan-aware grid of
  // plain text cells, so split (subgroup) cells land in the right place
  // without any text-heuristic guessing.
  const tables = await page.evaluate(function () {
    function gridFromTable(table) {
      var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
      var grid = [];
      var pending = [];
      rows.forEach(function (tr, rIdx) {
        grid[rIdx] = grid[rIdx] || [];
        pending.forEach(function (p) { if (p.remaining > 0) grid[rIdx][p.col] = p.text; });
        var col = 0;
        var newPending = [];
        var cells = Array.prototype.slice.call(tr.children);
        cells.forEach(function (td) {
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

  await browser.close();

  // Pick the table that actually looks like the timetable. Match on a real
  // "HH:MM - HH:MM" time RANGE, not just any HH:MM - a lone HH:MM also
  // matches the page's own "Расписание занятий (сформировано: 18:38)"
  // banner timestamp, which used to trick this into matching that banner
  // instead of the real header row (confirmed via a live debug dump).
  var TIME_RANGE_RE = /\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}/g;
  var best = null, headerRowIdx = -1, dataStartCol = -1;
  for (var t = 0; t < tables.length; t++) {
    var grid = tables[t];
    var wholeText = grid.map(function (r) { return r.join(" "); }).join(" ").toLowerCase();
    var timeHits = (wholeText.match(TIME_RANGE_RE) || []).length;
    var dayHits = Object.keys(DAY_WORDS).filter(function (d) { return wholeText.indexOf(d) !== -1; }).length;
    if (timeHits >= 4 && dayHits >= 3) { best = grid; break; }
  }

  if (!best) {
    console.error("Could not find a table that looks like the timetable. See debug-page.html for what the page actually rendered.");
    process.exit(1);
  }

  // Find the actual header row (may not be row 0 - this site has a few
  // banner/metadata rows above it) and the column where the real time
  // slots start, instead of assuming "the last 8 columns".
  for (var hr = 0; hr < best.length; hr++) {
    var row0 = best[hr] || [];
    for (var hc = 0; hc < row0.length; hc++) {
      if (TIME_RANGE_RE.test(row0[hc] || "")) {
        TIME_RANGE_RE.lastIndex = 0;
        headerRowIdx = hr; dataStartCol = hc;
        break;
      }
    }
    if (headerRowIdx >= 0) break;
  }
  if (dataStartCol < 0) dataStartCol = Math.max(0, (best[0] || []).length - TIMES.length); // fallback to the old assumption

  var weeks = emptyWeeks();
  var curWeek = 0, curDay = -1;

  best.forEach(function (row) {
    var col0 = (row[0] || "").trim().toLowerCase();
    var col1 = (row[1] || "").trim().toLowerCase();

    // This site repeats the week label on EVERY day row (not just once per
    // week-section), so week and day are read independently from the same
    // row rather than treated as mutually exclusive.
    var weekMatch = /^(\d+)\s*недел/.exec(col0);
    if (weekMatch) curWeek = (weekMatch[1] === "2") ? 1 : 0;

    var dayMatch = Object.keys(DAY_WORDS).filter(function (d) { return col1.indexOf(d) === 0; })[0];
    if (dayMatch !== undefined) {
      curDay = DAY_WORDS[dayMatch];
      var dm = row.join(" ").match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if (dm) weeks[curWeek].days[curDay].date = dm[0];
    } else if (!weekMatch) {
      return; // neither a week nor a day marker on this row - a banner/header row, skip it
    }
    if (curDay < 0) return;

    var dataCols = row.slice(dataStartCol, dataStartCol + TIMES.length);
    dataCols.forEach(function (cellText, i) {
      if (i >= 8 || !cellText) return;
      var lines = cellText.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!lines.length) return;
      var parsed = classifyLines(lines);
      if (!parsed.subject && !parsed.groups) return;
      var slot = weeks[curWeek].days[curDay].slots[i];
      var firstEmpty = !slot.parts[0].subject && !slot.parts[0].groups;
      if (firstEmpty) {
        slot.parts[0] = parsed;
      } else if (slot.parts[0].subject !== parsed.subject || slot.parts[0].teacher !== parsed.teacher) {
        slot.split = true;
        slot.parts[1] = parsed;
      }
    });
  });

  var lessonCount = 0;
  weeks.forEach(function (week) {
    week.days.forEach(function (day) {
      day.slots.forEach(function (slot) {
        slot.parts.forEach(function (part) { if (part.subject || part.groups) lessonCount++; });
      });
    });
  });

  if (lessonCount === 0) {
    console.error(
      "Found a table that LOOKED like the timetable, but parsed 0 actual lessons out of it. " +
      "Dumping every row of the detected table below (this site has a few banner/metadata " +
      "rows at the very top - 'Расписание занятий...', 'В период с...', 'Группа: ...' - which " +
      "genuinely span the full width via colspan, so they ate the whole sample budget last " +
      "time before reaching the real day rows; showing everything this time instead):"
    );
    console.error("Detected table has " + best.length + " rows, first row has " + (best[0] || []).length + " columns.");
    for (var r0 = 0; r0 < best.length; r0++) {
      var rowCells = (best[r0] || []).map(function (c) { return JSON.stringify((c || "").replace(/\n/g, "~")); });
      // Collapse a run of identical adjacent cells (a colspan banner) down to
      // one shown copy + a count, so a real day row isn't pushed off-screen
      // by 14 repeats of the same banner string.
      var collapsed = [];
      for (var ci = 0; ci < rowCells.length; ci++) {
        if (collapsed.length && collapsed[collapsed.length - 1].text === rowCells[ci]) {
          collapsed[collapsed.length - 1].count++;
        } else {
          collapsed.push({ text: rowCells[ci], count: 1 });
        }
      }
      console.error("row " + r0 + ": " + collapsed.map(function (g) { return g.count > 1 ? (g.text + " x" + g.count) : g.text; }).join(" | "));
    }
    console.error(
      "This almost always means either (a) classifyLines() doesn't recognise this real line " +
      "format, or (b) the 'last 8 columns are the time slots' assumption in the row-parsing " +
      "loop below is picking the wrong columns for this page's table. Compare the dump above " +
      "against classifyLines() and the dataCols slice further down."
    );
    process.exit(1);
  }
  console.log("Parsed " + lessonCount + " lesson(s) from the table before writing to Supabase.");

  await writeToSupabase(weeks);
  console.log("Wrote schedule to Supabase");
}

// ---------- Supabase (written via plain REST + service role key, no SDK needed) ----------

var SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, options) {
  options = options || {};
  var headers = Object.assign({
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json"
  }, options.headers || {});
  var res = await fetch(SUPABASE_URL + path, Object.assign({}, options, { headers: headers }));
  if (!res.ok) {
    var body = await res.text();
    throw new Error("Supabase " + path + " -> " + res.status + ": " + body);
  }
  var text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function writeToSupabase(weeks) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (as GitHub Actions secrets).");
  }

  // Create the group on first sight, so adding a new group to the workflow
  // is the only step needed (teachers who also teach that group then see
  // those lessons too).
  var groups = await sbFetch(
    "/rest/v1/groups?on_conflict=name",
    {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ name: GROUP_NAME })
    }
  );
  if (!groups || !groups.length) {
    throw new Error("Could not find or create group '" + GROUP_NAME + "' in Supabase.");
  }
  var groupId = groups[0].id;

  // Upsert every distinct teacher name we saw, and build name -> id.
  var teacherNames = {};
  weeks.forEach(function (w) { w.days.forEach(function (d) { d.slots.forEach(function (s) {
    s.parts.forEach(function (p) { if (p.teacher) teacherNames[p.teacher] = true; });
  }); }); });

  var teacherIdByName = {};
  var names = Object.keys(teacherNames);
  for (var i = 0; i < names.length; i++) {
    var rows = await sbFetch(
      "/rest/v1/teachers?on_conflict=group_id,full_name",
      {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ group_id: groupId, full_name: names[i] })
      }
    );
    if (rows && rows[0]) teacherIdByName[names[i]] = rows[0].id;
  }

  // Upsert every slot, tracking which (week,day,slot,part) combos we touched
  // so anything left over from a previous scrape (a lesson that no longer
  // exists) can be cleaned up afterwards.
  var touched = {};
  for (var w = 0; w < weeks.length; w++) {
    for (var d = 0; d < weeks[w].days.length; d++) {
      var day = weeks[w].days[d];
      for (var s = 0; s < day.slots.length; s++) {
        var slot = day.slots[s];
        for (var pi = 0; pi < slot.parts.length; pi++) {
          var part = slot.parts[pi];
          if (!part.subject && !part.groups) continue;
          var key = (w + 1) + ":" + d + ":" + s + ":" + pi;
          touched[key] = true;
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
                teacher_id: part.teacher ? (teacherIdByName[part.teacher] || null) : null,
                room: part.room || null,
                groups_label: part.groups || null,
                updated_at: new Date().toISOString()
              })
            }
          );
        }
      }
    }
  }

  // Remove slots that used to exist for this group but weren't seen this run.
  var existing = await sbFetch(
    "/rest/v1/schedule_slots?group_id=eq." + groupId + "&select=id,week_number,day_index,slot_index,part_index"
  );
  var staleIds = (existing || [])
    .filter(function (r) {
      var key = r.week_number + ":" + r.day_index + ":" + r.slot_index + ":" + r.part_index;
      return !touched[key];
    })
    .map(function (r) { return r.id; });

  for (var si = 0; si < staleIds.length; si++) {
    await sbFetch("/rest/v1/schedule_slots?id=eq." + staleIds[si], { method: "DELETE" });
  }

  console.log("Upserted " + Object.keys(touched).length + " slots, removed " + staleIds.length + " stale ones.");
}

function isoDate(ddmmyyyy) {
  var m = ddmmyyyy.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}

if (require.main === module) {
  run().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { writeToSupabase, isoDate, classifyLines };
