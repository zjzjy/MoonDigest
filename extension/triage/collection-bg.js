"use strict";
// 合集 mode's worker side: read subscribed collections, read one recent page, unsubscribe, and ask AI for a
// content-only summary. It is loaded after triage-bg.js so it can reuse the B站 channel, CSRF handling and AI client.
(() => {
  const MAX_PAGES = 50;
  const AI_BATCH = 8;
  const ID_RE = /^\d+$/;

  function requireId(value, label = "合集 ID") {
    const id = String(value ?? "").trim();
    if (!ID_RE.test(id) || Number(id) <= 0) throw triageError(`缺少有效的${label}`);
    return id;
  }

  async function readAllCollections() {
    const mid = await triageMid();
    const collections = [];
    let count = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await triageBiliGet(CollectionCore.collectedUrl(mid, page));
      count = Number(data?.count) || count;
      const pageRows = Array.isArray(data?.list) ? data.list : [];
      collections.push(...pageRows.map(CollectionCore.normalizeCollection).filter((item) => item.id));
      if (!data?.has_more || !pageRows.length) break;
    }
    const seen = new Set();
    return {
      mid,
      count,
      collections: collections.filter((item) => !seen.has(item.id) && seen.add(item.id))
    };
  }

  async function readDetail({ id }) {
    const collectionId = requireId(id);
    const data = await triageBiliGet(CollectionCore.seasonUrl(collectionId, 1, 40));
    return { detail: CollectionCore.normalizeDetail(data, collectionId) };
  }

  async function unsubscribe({ id }) {
    const collectionId = requireId(id);
    const cookie = await chrome.cookies.get({ url: TRIAGE_BILI_WEB, name: "bili_jct" });
    if (!cookie?.value) throw triageNotLoggedIn();
    const json = await triageBiliFetch(CollectionCore.unfavUrl(collectionId, cookie.value), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    triageBiliData(json);
    return { id: collectionId };
  }

  function aiPrompt(collections) {
    const facts = collections.map((item) => ({
      id: item.id,
      title: item.title,
      upper: item.upper?.name || "",
      intro: item.intro || "",
      mediaCount: item.mediaCount || 0,
      recent: (Array.isArray(item.items) ? item.items : []).slice(0, 20).map((video) => video.title)
    }));
    return [
      "你只负责提炼 B站 UGC 合集的内容，不判断是否应该取消订阅。",
      "根据标题、UP 主、简介、视频数量和近期视频标题，为每个合集写一句话中文主题和 2-5 个短标签。",
      "不要推测播放量、更新日期或用户偏好，不要输出主观订阅结论，不要输出 JSON 之外的文字。",
      '返回对象格式：{"合集ID":{"theme":"一句话主题","traits":["标签1","标签2"]}}。',
      `合集数据：${JSON.stringify(facts)}`
    ].join("\n");
  }

  async function summarize({ collections, aiProviderId = "" }) {
    const list = (Array.isArray(collections) ? collections : []).slice(0, AI_BATCH);
    if (!list.length) throw triageError("缺少要提炼的合集");
    const ids = new Set();
    for (const item of list) {
      const id = requireId(item?.id);
      if (ids.has(id)) throw triageError("同一批里有重复合集");
      ids.add(id);
    }
    const thinking = (await triageAiSettings()).triageThinking;
    const { content, model } = await triageChat(
      [
        {
          role: "system",
          content: "你是严谨的视频合集内容摘要器。只提炼内容，不评价是否值得订阅，结果必须是合法 JSON。"
        },
        { role: "user", content: aiPrompt(list) }
      ],
      1800,
      thinking,
      aiProviderId
    );
    const parsed = CollectionCore.parseSummaryObject(content);
    const summaries = {};
    for (const item of list) {
      const id = String(item.id);
      summaries[id] = { ...CollectionCore.cleanSummary(parsed[id]), model, generatedAt: Date.now(), promptVersion: 1 };
    }
    return { summaries };
  }

  const handlers = {
    "collection-list": () => readAllCollections(),
    "collection-detail": (message) => readDetail(message),
    "collection-unfav": (message) => unsubscribe(message),
    "collection-ai": (message) => summarize(message)
  };

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    triageListen("collection-", handlers);
  }

  globalThis.CollectionBackground = { handlers };
})();
