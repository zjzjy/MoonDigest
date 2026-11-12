"use strict";
// Pure data helpers for 合集 mode. This file never touches DOM, chrome.*, storage or network.
(() => {
  const DAY = 86400;
  const API = "https://api.bilibili.com";

  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const text = (value) => String(value ?? "").trim();

  function normalizeItem(raw = {}) {
    return {
      id: text(raw.id),
      bvid: text(raw.bvid),
      title: text(raw.title) || "无标题",
      cover: text(raw.cover),
      duration: Math.max(0, num(raw.duration)),
      pubtime: Math.max(0, num(raw.pubtime))
    };
  }

  function normalizeCollection(raw = {}) {
    return {
      id: text(raw.id),
      title: text(raw.title) || "未命名合集",
      cover: text(raw.cover),
      upper: {
        mid: text(raw.upper?.mid),
        name: text(raw.upper?.name)
      },
      intro: text(raw.intro),
      mediaCount: Math.max(0, num(raw.media_count ?? raw.mediaCount)),
      viewCount: Math.max(0, num(raw.view_count ?? raw.viewCount)),
      state: num(raw.state),
      mtime: Math.max(0, num(raw.mtime)),
      invalid: raw.invalid === true || num(raw.state) !== 0 || (raw.fav_state != null && num(raw.fav_state) === 0)
    };
  }

  function normalizeDetail(raw = {}, collectionId = "", invalid = false) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const items = (Array.isArray(source.items) ? source.items : Array.isArray(source.medias) ? source.medias : [])
      .map(normalizeItem)
      .filter((item) => item.bvid || item.title)
      .sort((a, b) => b.pubtime - a.pubtime || a.title.localeCompare(b.title, "zh-CN"));
    return {
      collectionId: text(collectionId || source.collectionId),
      invalid: source.invalid === true || invalid,
      info: source.info || null,
      items,
      latestAt: items.reduce((latest, item) => Math.max(latest, item.pubtime), 0),
      fetchedAt: Date.now()
    };
  }

  const examples = (detail, limit = 3) =>
    [...(Array.isArray(detail?.items) ? detail.items : [])]
      .sort((a, b) => b.pubtime - a.pubtime)
      .slice(0, Math.max(0, limit));

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function metrics(detail, nowMs = Date.now()) {
    const items = [...(Array.isArray(detail?.items) ? detail.items : [])]
      .filter((item) => num(item.pubtime) > 0)
      .sort((a, b) => num(b.pubtime) - num(a.pubtime));
    const latestAt = num(items[0]?.pubtime);
    const nowSeconds = Math.floor(num(nowMs) / 1000);
    const last30 = items.filter((item) => num(item.pubtime) >= nowSeconds - 30 * DAY).length;
    const last90 = items.filter((item) => num(item.pubtime) >= nowSeconds - 90 * DAY).length;
    const recent = items.slice(0, 11);
    const gaps = [];
    for (let i = 0; i < recent.length - 1; i++) {
      const days = (num(recent[i].pubtime) - num(recent[i + 1].pubtime)) / DAY;
      if (days > 0) gaps.push(days);
    }
    const medianGap = median(gaps.slice(0, 10));
    const gapDays = medianGap == null ? null : Math.max(1, Math.round(medianGap));
    let label;
    if (detail?.invalid) label = "该合集已失效";
    else if (!items.length) label = "暂无视频";
    else if (!gapDays) label = last30 ? `近 30 天 ${last30} 期 · 更新频率待观察` : "近 30 天未更新 · 更新频率待观察";
    else if (!last30) label = `近 30 天未更新 · 约每 ${gapDays} 天一期`;
    else label = `近 30 天 ${last30} 期 · 约每 ${gapDays} 天一期`;
    return { latestAt, last30, last90, gapDays, label };
  }

  function hash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function fingerprint(collection, detail, recentLimit = 20) {
    const recent = examples(detail, recentLimit).map((item) => `${item.pubtime}|${item.title}`).join("\n");
    const latestAt = detail?.latestAt ?? examples(detail, 1)[0]?.pubtime ?? 0;
    return hash([
      text(collection?.title),
      text(collection?.intro),
      num(latestAt),
      num(collection?.mediaCount),
      recent
    ].join("\u001f"));
  }

  function cleanSummary(raw) {
    const theme = text(raw?.theme).replace(/\s+/g, " ").slice(0, 80);
    const traits = [...new Set((Array.isArray(raw?.traits) ? raw.traits : [])
      .map((item) => text(item).replace(/\s+/g, " "))
      .filter(Boolean))]
      .slice(0, 5);
    if (!theme || traits.length < 2) throw new Error("AI 摘要缺少主题或标签");
    return { theme, traits };
  }

  function parseSummaryObject(content) {
    const value = text(content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 没有返回 JSON");
    return JSON.parse(value.slice(start, end + 1));
  }

  const searchWords = (query) => text(query).toLowerCase().split(/\s+/).filter(Boolean);

  function filterCollections(rows, query = "", filter = "all") {
    const words = searchWords(query);
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      const haystack = [
        row.title,
        row.upper?.name,
        row.intro,
        row.summary?.theme,
        ...(row.summary?.traits || []),
        ...(row.detail?.items || []).slice(0, 20).map((item) => item.title)
      ].join("\n").toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
      if (filter === "recent30") return num(row.metrics?.last30) > 0;
      if (filter === "recent90") return num(row.metrics?.last90) > 0;
      if (filter === "stale") return !row.invalid && num(row.detail?.items?.length) > 0 && num(row.metrics?.last30) === 0;
      if (filter === "invalid") return Boolean(row.invalid);
      return true;
    });
  }

  function sortCollections(rows, sort = "updated") {
    const list = [...(Array.isArray(rows) ? rows : [])];
    if (sort === "count") {
      return list.sort((a, b) => num(b.mediaCount) - num(a.mediaCount) || a.title.localeCompare(b.title, "zh-CN"));
    }
    if (sort === "title") {
      return list.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    }
    if (sort === "source") return list;
    return list.sort((a, b) => {
      const av = num(a.metrics?.latestAt);
      const bv = num(b.metrics?.latestAt);
      if (!av && !bv) return a.title.localeCompare(b.title, "zh-CN");
      if (!av) return 1;
      if (!bv) return -1;
      return bv - av || a.title.localeCompare(b.title, "zh-CN");
    });
  }

  function batches(rows, size = 8) {
    const n = Math.max(1, Math.floor(num(size)));
    const list = Array.isArray(rows) ? rows : [];
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  function pruneSelection(selected, rows) {
    const live = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.id)));
    return [...(selected || [])].map(String).filter((id) => live.has(id));
  }

  function allVisibleSelected(selected, rows) {
    const visible = (Array.isArray(rows) ? rows : []).map((row) => String(row.id));
    const ids = new Set([...(selected || [])].map(String));
    return visible.length > 0 && visible.every((id) => ids.has(id));
  }

  function toggleVisibleSelection(selected, rows) {
    const ids = new Set([...(selected || [])].map(String));
    const visible = (Array.isArray(rows) ? rows : []).map((row) => String(row.id));
    const all = allVisibleSelected(ids, rows);
    for (const id of visible) {
      if (all) ids.delete(id);
      else ids.add(id);
    }
    return [...ids];
  }

  const collectedUrl = (mid, page = 1) =>
    `${API}/x/v3/fav/folder/collected/list?pn=${Math.max(1, Math.floor(num(page)))}&ps=50&up_mid=${encodeURIComponent(text(mid))}&platform=web`;

  const seasonUrl = (id, page = 1, size = 40) =>
    `${API}/x/space/fav/season/list?season_id=${encodeURIComponent(text(id))}&pn=${Math.max(1, Math.floor(num(page)))}&ps=${Math.max(1, Math.floor(num(size)))}`;

  const unfavUrl = (id, csrf) =>
    `${API}/x/v3/fav/season/unfav?season_id=${encodeURIComponent(text(id))}&platform=web&csrf=${encodeURIComponent(text(csrf))}`;

  globalThis.CollectionCore = {
    DAY,
    normalizeItem,
    normalizeCollection,
    normalizeDetail,
    examples,
    metrics,
    fingerprint,
    cleanSummary,
    parseSummaryObject,
    filterCollections,
    sortCollections,
    batches,
    pruneSelection,
    allVisibleSelected,
    toggleVisibleSelection,
    collectedUrl,
    seasonUrl,
    unfavUrl
  };
})();
