import "./triage.js";

const UI = globalThis.TriageUi;
const T = globalThis.MoonTriage;
const Core = globalThis.CollectionCore;
const { esc, fmtDate, fmtCount, img } = UI;
const { send, toast, askConfirm } = T;

const CACHE_KEY = "collection_cache_v1";
const REMOVED_KEY = "collection_recently_removed_v1";
const AI_PROVIDER_KEY = MdgLimits.KEYS.aiSelectedProvider;
const DETAIL_GAP_MS = 400;
const WRITE_GAP_MS = 600;
const AI_SETUP_CODE = ["AI", "SETUP"].join("_");
const SORTS = {
  updated: "最近更新",
  count: "视频数",
  title: "标题",
  source: "订阅列表顺序"
};
const FILTERS = {
  all: "全部合集",
  recent30: "近 30 天有更新",
  recent90: "近 90 天有更新",
  stale: "长期未更新",
  invalid: MdgErrors.LABEL.invalid
};

const el = {};
for (const id of ["collectionSide", "collectionMain", "collectionHead", "collectionTools", "collectionBar", "collectionList"]) {
  el[id] = document.getElementById(id);
}

const S = {
  loaded: false,
  loading: false,
  loadError: "",
  rows: [],
  details: {},
  summaries: {},
  detailErrors: {},
  detailQueue: [],
  detailQueued: new Set(),
  detailRunning: false,
  selected: new Set(),
  query: "",
  filter: "all",
  sort: "updated",
  active: false,
  ai: { running: false, done: 0, total: 0, text: "", failed: [] },
  writes: { running: false, done: 0, total: 0, failed: [] }
};

let observer = null;

const providerId = () => {
  try {
    return localStorage.getItem(AI_PROVIDER_KEY) || "";
  } catch {
    return "";
  }
};

const rowById = (id) => S.rows.find((row) => row.id === String(id));
const detailOf = (id) => S.details[String(id)] || null;
const summaryOf = (id) => S.summaries[String(id)] || null;
const canWrite = () => !S.writes.running && !S.ai.running;

function collectionLink(row) {
  const first = Core.examples(detailOf(row.id), 1)[0];
  return first?.bvid ? `https://www.bilibili.com/video/${encodeURIComponent(first.bvid)}` : "";
}

function syncRow(row) {
  const detail = detailOf(row.id);
  row.detail = detail;
  row.summary = summaryOf(row.id);
  row.metrics = detail ? Core.metrics(detail, Date.now()) : null;
  row.invalid = Boolean(row.invalid || detail?.invalid);
  return row;
}

function syncAllRows() {
  for (const row of S.rows) syncRow(row);
}

function visibleRows() {
  const filtered = Core.filterCollections(S.rows, S.query, S.filter);
  return Core.sortCollections(filtered, S.sort);
}

function counts() {
  const out = { all: S.rows.length, recent30: 0, recent90: 0, stale: 0, invalid: 0 };
  for (const row of S.rows) {
    const metrics = row.metrics;
    if (metrics?.last30 > 0) out.recent30++;
    if (metrics?.last90 > 0) out.recent90++;
    if (!row.invalid && metrics?.latestAt && metrics.last30 === 0) out.stale++;
    if (row.invalid) out.invalid++;
  }
  return out;
}

async function loadCache() {
  const got = await chrome.storage.local.get(CACHE_KEY);
  const cache = got[CACHE_KEY];
  if (!cache || typeof cache !== "object") return;
  S.details = cache.details && typeof cache.details === "object" ? cache.details : {};
  S.summaries = cache.summaries && typeof cache.summaries === "object" ? cache.summaries : {};
  const rows = Array.isArray(cache.rows) ? cache.rows : [];
  S.rows = rows.map((row) => Core.normalizeCollection(row));
  syncAllRows();
  S.loaded = S.rows.length > 0;
}

async function saveCache() {
  const rows = S.rows.map(({ detail, summary, metrics, ...row }) => row);
  await chrome.storage.local.set({
    [CACHE_KEY]: {
      savedAt: Date.now(),
      rows,
      details: S.details,
      summaries: S.summaries
    }
  });
}

async function rememberRemoved(row) {
  const got = await chrome.storage.local.get(REMOVED_KEY);
  const list = Array.isArray(got[REMOVED_KEY]) ? got[REMOVED_KEY] : [];
  await chrome.storage.local.set({
    [REMOVED_KEY]: [{ id: row.id, title: row.title, upper: row.upper?.name || "", removedAt: Date.now() }, ...list].slice(0, 50)
  });
}

function mergeFreshRows(collections) {
  const old = new Map(S.rows.map((row) => [row.id, row]));
  for (const fresh of collections) {
    const before = old.get(fresh.id);
    if (before && (before.mtime !== fresh.mtime || before.mediaCount !== fresh.mediaCount || before.title !== fresh.title)) {
      delete S.details[fresh.id];
      delete S.summaries[fresh.id];
      delete S.detailErrors[fresh.id];
    }
  }
  S.rows = collections.map(Core.normalizeCollection);
  syncAllRows();
  for (const id of [...S.selected]) if (!rowById(id)) S.selected.delete(id);
}

async function loadList(force = false) {
  if (S.loading || (!force && S.loaded)) return;
  S.loading = true;
  S.loadError = "";
  renderHead();
  renderList();
  const result = await send({ type: "collection-list" });
  S.loading = false;
  if (!result.ok) {
    S.loadError = MdgErrors.text(result);
    renderHead();
    renderList();
    return;
  }
  mergeFreshRows(result.data?.collections || []);
  S.loaded = true;
  await saveCache();
  renderAll();
  queueVisibleDetails();
}

function queueDetail(id) {
  const key = String(id);
  const row = rowById(key);
  if (!row || row.invalid || S.details[key] || S.detailQueued.has(key)) return;
  S.detailQueued.add(key);
  S.detailQueue.push(key);
  drainDetails();
}

async function drainDetails() {
  if (S.detailRunning) return;
  S.detailRunning = true;
  try {
    while (S.detailQueue.length) {
      const id = S.detailQueue.shift();
      const row = rowById(id);
      if (!row || row.invalid || S.details[id]) {
        S.detailQueued.delete(id);
        continue;
      }
      const result = await send({ type: "collection-detail", id });
      S.detailQueued.delete(id);
      if (result.ok) {
        S.details[id] = Core.normalizeDetail(result.data?.detail, id, row.invalid);
        delete S.detailErrors[id];
      } else {
        S.detailErrors[id] = MdgErrors.text(result);
      }
      syncRow(row);
      if (S.active) renderAll();
      await saveCache();
      if (S.detailQueue.length) await sleep(DETAIL_GAP_MS);
    }
  } finally {
    S.detailRunning = false;
  }
}

function queueVisibleDetails() {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) queueDetail(entry.target.dataset.id);
      }
    }, { root: el.collectionList, rootMargin: "160px" });
  }
  observer.disconnect();
  for (const card of el.collectionList.querySelectorAll(".collection-card")) observer.observe(card);
}

function queueFirstCardDetails(limit = 8) {
  for (const card of [...el.collectionList.querySelectorAll(".collection-card")].slice(0, limit)) queueDetail(card.dataset.id);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function renderSide() {
  const c = counts();
  el.collectionSide.innerHTML = `
    <div class="side-head">合集筛选</div>
    ${Object.entries(FILTERS).map(([id, label]) => `
      <button type="button" class="side-item${S.filter === id ? " on" : ""}" data-filter="${id}">
        <span class="side-name">${esc(label)}</span>
        <span class="side-count">${c[id]}</span>
      </button>
    `).join("")}
    <div class="side-foot">
      <button type="button" class="side-item" data-open-bili>在 B站打开我的收藏 ↗</button>
    </div>
  `;
}

function renderHead() {
  const visible = visibleRows();
  const status = S.loading ? "正在读取订阅合集…" : S.loadError ? `读取失败：${S.loadError}` : `${S.rows.length} 个合集`;
  const detailPending = S.detailQueued.size;
  el.collectionHead.innerHTML = `
    <div class="folder-info">
      <div class="collection-head-title">
        <strong>订阅合集</strong>
        <span class="collection-head-meta">${esc(status)}${S.loadError ? "" : ` · 当前列出 ${visible.length} 个`}${detailPending ? ` · 更新数据读取中 ${detailPending}` : ""}</span>
      </div>
    </div>
    <span class="collection-head-meta">${S.loaded ? "内容与更新数据来自 B站" : ""}</span>
  `;
}

function renderTools() {
  const provider = providerId();
  el.collectionTools.innerHTML = `
    <div class="collection-tools">
      <input id="collectionSearch" class="grow" type="search" value="${esc(S.query)}" placeholder="搜索合集、UP 主、摘要或视频标题" aria-label="搜索合集" />
      <select id="collectionSort" aria-label="合集排序">
        ${Object.entries(SORTS).map(([id, label]) => `<option value="${id}"${S.sort === id ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      <button type="button" data-refresh>${MdgErrors.LABEL.refresh}</button>
      <button type="button" class="primary" data-ai-batch${UI.reasonAttrs(S.ai.running ? "AI 提炼正在进行" : "", "提炼选中项；没有选中项时提炼当前筛选结果")}>✦ AI 提炼</button>
    </div>
  `;
  const search = el.collectionTools.querySelector("#collectionSearch");
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      S.query = search.value;
      pruneSelection();
      renderAll(false);
    }, 120);
  });
  el.collectionTools.querySelector("#collectionSort").addEventListener("change", (event) => {
    S.sort = event.target.value;
    renderAll(false);
  });
  if (!provider) el.collectionTools.querySelector("[data-ai-batch]").title = "AI 平台尚未配置，点击后可以前往设置";
}

function aiStatus() {
  if (S.ai.running) return `AI 提炼 ${S.ai.done}/${S.ai.total}${S.ai.text ? ` · ${S.ai.text}` : ""}`;
  if (S.ai.failed.length) return `AI 有 ${S.ai.failed.length} 个失败`;
  return "";
}

function writeStatus() {
  if (S.writes.running) return `取消订阅 ${S.writes.done}/${S.writes.total}`;
  if (S.writes.failed.length) return `取消订阅有 ${S.writes.failed.length} 个失败`;
  return "";
}

function renderBar() {
  const visible = visibleRows();
  const selected = S.selected.size;
  const allVisible = Core.allVisibleSelected(S.selected, visible);
  el.collectionBar.innerHTML = `
    <div class="collection-tools">
      <button type="button" data-select-all>${allVisible ? "取消全选" : `全选当前 ${visible.length} 个`}</button>
      <button type="button" data-select-none${UI.reasonAttrs(selected ? "" : "还没有选中合集", "清空已选合集")}>清空选择</button>
      <button type="button" class="st-danger" data-unsubscribe${UI.reasonAttrs(!selected ? "先选择要取消订阅的合集" : !canWrite() ? "AI 提炼或取消订阅正在进行" : "", "取消订阅选中的合集")}>取消订阅选中 ${selected} 个</button>
      <span class="grow"></span>
      ${aiStatus() ? `<span class="collection-ai-progress">${esc(aiStatus())}</span>` : ""}
      ${S.ai.failed.length && !S.ai.running ? `<button type="button" class="link" data-ai-retry>只重试 AI 失败项</button>` : ""}
      ${writeStatus() ? `<span class="${S.writes.failed.length ? "collection-fail" : "collection-ai-progress"}">${esc(writeStatus())}</span>` : ""}
      ${S.writes.failed.length && !S.writes.running ? `<button type="button" class="link" data-write-retry>只重试取消订阅失败项</button>` : ""}
    </div>
  `;
}

function summaryHtml(row) {
  if (row.invalid) return "";
  if (row.summary?.theme) {
    return `
      <p class="collection-summary"><strong>AI：</strong>${esc(row.summary.theme)}</p>
      <div class="collection-traits">${(row.summary.traits || []).map((tag) => `<span class="chip">${esc(tag)}</span>`).join("")}</div>
    `;
  }
  if (!row.detail) return `<p class="collection-summary collection-muted">正在读取近期内容…</p>`;
  if (S.detailErrors[row.id]) return `<p class="collection-summary collection-fail">近期内容读取失败：${esc(S.detailErrors[row.id])}</p>`;
  return `<p class="collection-summary collection-muted">等待 AI 提炼内容主题</p>`;
}

function examplesHtml(row) {
  const items = Core.examples(row.detail, 3);
  if (!items.length) return `<ul class="collection-examples"><li class="collection-muted">没有可显示的视频</li></ul>`;
  return `
    <ul class="collection-examples">
      ${items.map((item) => {
        const url = item.bvid ? `https://www.bilibili.com/video/${encodeURIComponent(item.bvid)}` : "";
        const label = url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
          : `<span>${esc(item.title)}</span>`;
        return `<li class="collection-example">${label}<time>${esc(fmtDate(item.pubtime))}</time></li>`;
      }).join("")}
    </ul>
  `;
}

function cardHtml(row) {
  const selected = S.selected.has(row.id);
  const url = collectionLink(row);
  const image = row.cover ? `<img class="collection-cover" src="${esc(img(row.cover, "320w_180h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "";
  const latest = row.metrics?.latestAt ? `最近更新 ${fmtDate(row.metrics.latestAt)}` : "更新时间待读取";
  const frequency = row.metrics?.label || "更新频率待读取";
  return `
    <article class="collection-card${selected ? " selected" : ""}" data-id="${esc(row.id)}" data-card>
      <div class="collection-cover-wrap">
        ${image}
        <label class="collection-pick toggle" title="选择这个合集">
          <input id="collection-pick-${esc(row.id)}" type="checkbox" data-pick="${esc(row.id)}" aria-label="选择合集《${esc(row.title)}》"${selected ? " checked" : ""} />
        </label>
      </div>
      <div class="collection-body">
        <h3 class="collection-title">
          ${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(row.title)}</a>` : esc(row.title)}
        </h3>
        <div class="collection-up">${esc(row.upper.name || "未知 UP 主")} · ${fmtCount(row.mediaCount)} 个视频</div>
        ${summaryHtml(row)}
        ${row.invalid
          ? `<div class="collection-facts"><span class="collection-state">该合集已失效，建议清理</span></div>`
          : `<div class="collection-facts"><span>${esc(latest)}</span><span>${esc(frequency)}</span></div>${examplesHtml(row)}`}
      </div>
    </article>
  `;
}

function renderList() {
  if (S.loading && !S.rows.length) {
    el.collectionList.innerHTML = `<p class="empty">正在读取订阅合集…</p>`;
    return;
  }
  if (S.loadError && !S.rows.length) {
    el.collectionList.innerHTML = `<div class="empty"><p>读取订阅合集失败</p><p>${esc(S.loadError)}</p><button type="button" data-empty-retry>${MdgErrors.LABEL.retry}</button></div>`;
    return;
  }
  const rows = visibleRows();
  if (!rows.length) {
    el.collectionList.innerHTML = `<p class="empty">${S.rows.length ? "当前筛选下没有合集" : "还没有订阅任何 UGC 合集"}</p>`;
    return;
  }
  el.collectionList.innerHTML = rows.map(cardHtml).join("");
  queueVisibleDetails();
  queueFirstCardDetails();
}

function renderAll(full = true) {
  if (!S.active) return;
  syncAllRows();
  if (full) renderSide();
  renderHead();
  if (full) renderTools();
  renderBar();
  renderList();
}

async function ensureDetails(ids) {
  const missing = ids.filter((id) => !detailOf(id));
  for (let index = 0; index < missing.length; index++) {
    const id = missing[index];
    const result = await send({ type: "collection-detail", id });
    if (!result.ok) throw new Error(`《${rowById(id)?.title || id}》近期内容读取失败：${MdgErrors.text(result)}`);
    const row = rowById(id);
    S.details[id] = Core.normalizeDetail(result.data?.detail, id, row?.invalid);
    syncRow(row);
    if (index < missing.length - 1) await sleep(DETAIL_GAP_MS);
  }
  if (missing.length) {
    await saveCache();
    renderAll();
  }
}

function aiInput(row) {
  return {
    id: row.id,
    title: row.title,
    upper: row.upper,
    intro: row.intro,
    mediaCount: row.mediaCount,
    items: Core.examples(row.detail, 20).map(({ title, pubtime }) => ({ title, pubtime }))
  };
}

async function runAi(ids, retry = false) {
  if (S.ai.running || S.writes.running) return;
  if (!providerId()) {
    toast("AI 平台还没配置，先去设置里添加平台和 API Key", true);
      T.aiError("AI 平台还没配置，先去设置里添加平台和 API Key", AI_SETUP_CODE);
    return;
  }
  let list = [...new Set(ids.map(String))].map(rowById).filter((row) => row && !row.invalid);
  list = list.filter((row) => {
    const detail = detailOf(row.id);
    return detail && summaryOf(row.id)?.fingerprint !== Core.fingerprint(row, detail);
  });
  if (!list.length) {
    toast(retry ? "没有仍需重试的 AI 提炼" : "这些合集的 AI 提炼已经是最新的");
    return;
  }
  S.ai = { running: true, done: 0, total: list.length, text: "读取近期内容", failed: [] };
  renderBar();
  try {
    await ensureDetails(list.map((row) => row.id));
    list = list.filter((row) => detailOf(row.id));
    S.ai.total = list.length;
    const groups = Core.batches(list, 8);
    for (const group of groups) {
      S.ai.text = `“${group[0].title}”等 ${group.length} 个`;
      renderBar();
      const result = await send({
        type: "collection-ai",
        collections: group.map(aiInput),
        aiProviderId: providerId()
      });
      if (!result.ok) {
        T.aiError(MdgErrors.text(result), result.code);
        S.ai.failed.push(...group.map((row) => ({ id: row.id, error: MdgErrors.text(result) })));
      } else {
        for (const row of group) {
          const raw = result.data?.summaries?.[row.id];
          if (!raw) {
            S.ai.failed.push({ id: row.id, error: "AI 没有返回这个合集" });
            continue;
          }
          S.summaries[row.id] = {
            ...raw,
            fingerprint: Core.fingerprint(row, detailOf(row.id))
          };
          S.ai.done++;
        }
        await saveCache();
        syncAllRows();
        renderAll();
      }
      renderBar();
      if (group !== groups.at(-1)) await sleep(500);
    }
  } catch (error) {
    const left = list.slice(S.ai.done).map((row) => ({ id: row.id, error: error?.message || String(error) }));
    S.ai.failed.push(...left);
    toast(error?.message || String(error), true);
  } finally {
    S.ai.running = false;
    S.ai.text = "";
    renderAll();
    if (S.ai.failed.length) toast(`AI 提炼完成，${S.ai.failed.length} 个失败`, true);
    else if (S.ai.done) toast(`AI 提炼完成 ${S.ai.done} 个`);
  }
}

function selectedOrVisibleIds() {
  if (S.selected.size) return [...S.selected];
  return visibleRows().filter((row) => !row.summary || row.summary.fingerprint !== Core.fingerprint(row, row.detail)).map((row) => row.id);
}

async function unsubscribe(ids) {
  if (!canWrite()) return;
  const targets = [...new Set(ids.map(String))].map(rowById).filter(Boolean);
  if (!targets.length) return;
  const names = targets.slice(0, 10).map((row) => row.title);
  const more = targets.length > 10 ? `<p class="collection-muted">另外还有 ${targets.length - 10} 个合集。</p>` : "";
  const ok = await askConfirm(
    `取消订阅这 ${targets.length} 个合集？`,
    `<p>这会直接改变 B站订阅，不会自动撤销。</p><ul>${names.map((name) => `<li>${esc(name)}</li>`).join("")}</ul>${more}`,
    `取消订阅 ${targets.length} 个`,
    { danger: true }
  );
  if (!ok) return;
  S.writes = { running: true, done: 0, total: targets.length, failed: [] };
  renderAll();
  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const result = await send({ type: "collection-unfav", id: row.id });
    if (result.ok) {
      S.writes.done++;
      await rememberRemoved(row);
      S.rows = S.rows.filter((item) => item.id !== row.id);
      S.selected.delete(row.id);
      delete S.details[row.id];
      delete S.summaries[row.id];
      delete S.detailErrors[row.id];
      await saveCache();
      renderAll();
    } else {
      S.writes.failed.push({ id: row.id, error: MdgErrors.text(result) });
      if (T.hold(result)) {
        S.writes.failed.push(...targets.slice(i + 1).map((item) => ({ id: item.id, error: "B站限流，未执行" })));
        break;
      }
    }
    if (i < targets.length - 1) await sleep(WRITE_GAP_MS);
  }
  S.writes.running = false;
  renderAll();
  if (S.writes.failed.length) toast(`取消订阅完成，${S.writes.failed.length} 个失败`, true);
  else toast(`已取消订阅 ${S.writes.done} 个合集`);
}

function selectedVisibleToggle() {
  const visible = visibleRows();
  S.selected = new Set(Core.toggleVisibleSelection(S.selected, visible));
  renderAll(false);
}

function pruneSelection(rows = visibleRows()) {
  S.selected = new Set(Core.pruneSelection(S.selected, rows));
}

async function activate() {
  S.active = true;
  el.collectionSide.hidden = false;
  el.collectionMain.hidden = false;
  if (!S.loaded && !S.loading) await loadCache();
  renderAll();
  if (!S.loaded) await loadList();
  else queueVisibleDetails();
}

function deactivate() {
  S.active = false;
  el.collectionSide.hidden = true;
  el.collectionMain.hidden = true;
}

el.collectionSide.addEventListener("click", (event) => {
  const filter = event.target.closest("[data-filter]")?.dataset.filter;
  if (filter) {
    S.filter = filter;
    if (filter === "recent30" || filter === "recent90" || filter === "stale") {
      for (const row of S.rows) queueDetail(row.id);
    }
    pruneSelection();
    renderAll();
    return;
  }
  if (event.target.closest("[data-open-bili]")) {
    window.open("https://space.bilibili.com/", "_blank", "noopener");
  }
});

el.collectionMain.addEventListener("click", async (event) => {
  const target = event.target;
  if (target.closest("[data-refresh]")) return loadList(true);
  if (target.closest("[data-empty-retry]")) return loadList(true);
  if (target.closest("[data-ai-batch]")) return runAi(selectedOrVisibleIds());
  if (target.closest("[data-ai-retry]")) return runAi(S.ai.failed.map((item) => item.id), true);
  if (target.closest("[data-write-retry]")) return unsubscribe(S.writes.failed.map((item) => item.id));
  if (target.closest("[data-select-all]")) {
    return selectedVisibleToggle();
  }
  if (target.closest("[data-select-none]")) {
    S.selected.clear();
    return renderAll(false);
  }
  if (target.closest("[data-unsubscribe]")) return unsubscribe([...S.selected]);
  if (target.closest("a, input, button, select")) return;
  const card = target.closest("[data-card]");
  if (!card) return;
  if (S.selected.has(card.dataset.id)) S.selected.delete(card.dataset.id);
  else S.selected.add(card.dataset.id);
  renderAll(false);
});

el.collectionMain.addEventListener("change", (event) => {
  const id = event.target.dataset?.pick;
  if (!id) return;
  if (event.target.checked) S.selected.add(id);
  else S.selected.delete(id);
  renderAll(false);
});

window.addEventListener("beforeunload", (event) => {
  if (!S.ai.running && !S.writes.running) return;
  event.preventDefault();
  event.returnValue = true;
});

globalThis.MoonCollections = { activate, deactivate, refresh: () => loadList(true) };
