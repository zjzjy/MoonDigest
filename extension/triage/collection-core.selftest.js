// node extension/triage/collection-core.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(__dirname, "collection-core.js"), "utf8"), ctx);
const C = ctx.CollectionCore;

const now = Date.UTC(2026, 10, 12) / 1000;
const detail = { items: [
  { pubtime: now - 2 * 86400 },
  { pubtime: now - 10 * 86400 },
  { pubtime: now - 40 * 86400 }
] };
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.metrics(detail, now * 1000))), {
  latestAt: now - 2 * 86400,
  last30: 2,
  last90: 3,
  gapDays: 19,
  label: "近 30 天 2 期 · 约每 19 天一期"
});
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.examples({ items: [
  { title: "old", pubtime: 1 },
  { title: "new", pubtime: 3 },
  { title: "mid", pubtime: 2 },
  { title: "older", pubtime: 0 }
] }).map((item) => item.title))), ["new", "mid", "old"]);

const collection = { title: "A", intro: "", mediaCount: 2 };
assert.notStrictEqual(
  C.fingerprint(collection, { latestAt: 10, items: [{ title: "x", pubtime: 10 }] }),
  C.fingerprint(collection, { latestAt: 11, items: [{ title: "x", pubtime: 11 }] })
);
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.batches(Array.from({ length: 17 }, (_, i) => ({ id: String(i) })), 8).map((batch) => batch.length))), [8, 8, 1]);
assert.strictEqual(C.collectedUrl(651215721, 2), "https://api.bilibili.com/x/v3/fav/folder/collected/list?pn=2&ps=50&up_mid=651215721&platform=web");
assert.strictEqual(C.unfavUrl(8583497, "token"), "https://api.bilibili.com/x/v3/fav/season/unfav?season_id=8583497&platform=web&csrf=token");
assert.strictEqual(C.normalizeCollection({ id: "1", state: 0, invalid: false }).invalid, false);
assert.strictEqual(C.normalizeCollection({ id: "2", state: 0, fav_state: 0 }).invalid, true);

const parsed = C.parseSummaryObject('```json\n{"1":{"theme":"主题","traits":["A","B"]}}\n```');
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.cleanSummary(parsed["1"]))), { theme: "主题", traits: ["A", "B"] });
assert.throws(() => C.cleanSummary({ theme: "只有主题", traits: [] }), /缺少主题或标签/);
const visible = [{ id: "1" }, { id: "2" }];
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.pruneSelection(new Set(["1", "9"]), visible))), ["1"]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.toggleVisibleSelection(new Set(["1", "9"]), visible))), ["1", "9", "2"]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(C.toggleVisibleSelection(new Set(["1", "2", "9"]), visible))), ["9"]);

console.log("collection-core selftest ok");
