// Runs scrape-schedule.js once per group, one after another.
//
// Groups come from two places, merged and de-duplicated:
//   1. TIMETABLE_GROUP_NAMES - a fixed list, e.g. "128,121,122,124"
//      (always scraped, even if step 2 found nothing)
//   2. lecturer-groups.txt - written just before this by
//      `LECTURER_GROUPS_MODE=1 node scripts/scrape-lecturers.js`: every group
//      that any app teacher (teacher_roster) teaches, read from their own
//      timetable on the university site.
//
// One group failing (captcha, site hiccup) never stops the rest. The step
// only fails if EVERY group failed.
//
//   node scripts/scrape-groups.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const fixed = (process.env.TIMETABLE_GROUP_NAMES || "128")
  .split(",").map(function (s) { return s.trim(); }).filter(Boolean);

var discovered = [];
var file = path.join(__dirname, "..", "lecturer-groups.txt");
if (fs.existsSync(file)) {
  discovered = fs.readFileSync(file, "utf8").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}

var groups = [];
fixed.concat(discovered).forEach(function (g) { if (groups.indexOf(g) === -1) groups.push(g); });

console.log("Fixed groups:      " + (fixed.join(", ") || "-"));
console.log("Teachers' groups:  " + (discovered.join(", ") || "- (lecturer step found none / didn't run)"));
console.log("Will scrape " + groups.length + " group(s): " + groups.join(", ") + "\n");

var ok = [], failed = [];
groups.forEach(function (g, i) {
  console.log("==================== [" + (i + 1) + "/" + groups.length + "] group " + g + " ====================");
  var res = spawnSync(process.execPath, [path.join(__dirname, "scrape-schedule.js")], {
    env: Object.assign({}, process.env, { TIMETABLE_GROUP_NAME: g }),
    stdio: "inherit"
  });
  (res.status === 0 ? ok : failed).push(g);
});

console.log("\nDone. Updated: " + (ok.join(", ") || "none") + ". Failed: " + (failed.join(", ") || "none") + ".");
if (!ok.length) process.exit(1);
