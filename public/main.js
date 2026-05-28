const sitesInput = document.getElementById("sitesInput");
const xlsxFile = document.getElementById("xlsxFile");
const keywordInput = document.getElementById("keywordInput");
const daysInput = document.getElementById("daysInput");
const maxPagesInput = document.getElementById("maxPagesInput");
const strictModeInput = document.getElementById("strictModeInput");
const startDateInput = document.getElementById("startDate");
const endDateInput = document.getElementById("endDate");
const applyDaysBtn = document.getElementById("applyDaysBtn");
const searchBtn = document.getElementById("searchBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const loadingBox = document.getElementById("loadingBox");
const loadingText = document.getElementById("loadingText");
const resultSummary = document.getElementById("resultSummary");
const resultList = document.getElementById("resultList");
const pageSizeSelect = document.getElementById("pageSizeSelect");
const exportScopeSelect = document.getElementById("exportScopeSelect");
const exportBtn = document.getElementById("exportBtn");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfo = document.getElementById("pageInfo");
const listHintPanel = document.getElementById("listHintPanel");
const listHintList = document.getElementById("listHintList");
const siteNoticePanel = document.getElementById("siteNoticePanel");
const siteNoticeList = document.getElementById("siteNoticeList");
const searchTabBtn = document.getElementById("searchTabBtn");
const historyTabBtn = document.getElementById("historyTabBtn");
const searchTabContent = document.getElementById("searchTabContent");
const historyTabContent = document.getElementById("historyTabContent");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const SEARCH_HISTORY_STORAGE_KEY = "ocs.searchHistory.v1";
const SEARCH_HISTORY_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_HISTORY_MAX = 30;

let currentTotal = 0;
let currentAbortController = null;
let isSearching = false;
let allResults = [];
let currentPage = 1;
let activeKeyword = "";
let listHints = [];
let searchHistory = [];
let siteSearchDetectedMap = {};
let siteResultNotices = [];

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function applyRecentDays(days = 7) {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - safeDays + 1);

  startDateInput.value = formatDate(start);
  endDateInput.value = formatDate(end);
}

function getSitesFromTextarea() {
  return sitesInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function setActiveTab(tabName) {
  const showHistory = tabName === "history";
  searchTabBtn.classList.toggle("active", !showHistory);
  historyTabBtn.classList.toggle("active", showHistory);
  searchTabBtn.setAttribute("aria-selected", String(!showHistory));
  historyTabBtn.setAttribute("aria-selected", String(showHistory));
  searchTabContent.classList.toggle("hidden", showHistory);
  historyTabContent.classList.toggle("hidden", !showHistory);
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "-";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getSearchFingerprint(record) {
  const sites = Array.isArray(record.sites) ? record.sites : [];
  return JSON.stringify({
    sites: sites.map((site) => String(site || "").trim()).filter(Boolean).sort(),
    keyword: String(record.keyword || "").trim().toLowerCase(),
    startDate: String(record.startDate || ""),
    endDate: String(record.endDate || ""),
    maxPagesPerSite: Number(record.maxPagesPerSite) || 120,
    strictMode: Boolean(record.strictMode),
  });
}

function readSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function persistSearchHistory() {
  try {
    localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(searchHistory));
  } catch (error) {
    // localStorage 可能因隐私模式或容量限制不可用，此时忽略持久化失败。
  }
}

function pruneSearchHistory(records) {
  const now = Date.now();
  return records
    .filter((item) => item && typeof item === "object")
    .filter((item) => Number.isFinite(item.createdAt))
    .filter((item) => now - item.createdAt <= SEARCH_HISTORY_EXPIRE_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SEARCH_HISTORY_MAX);
}

function renderSearchHistory() {
  historyList.innerHTML = "";
  if (!searchHistory.length) {
    const empty = document.createElement("li");
    empty.className = "history-meta";
    empty.textContent = "暂无历史记录";
    historyList.appendChild(empty);
    clearHistoryBtn.disabled = true;
    return;
  }

  searchHistory.forEach((record) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";
    main.textContent = `关键词：${record.keyword || "-"}`;

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const siteCount = Array.isArray(record.sites) ? record.sites.length : 0;
    const modeText = record.strictMode ? "严格模式" : "普通模式";
    meta.textContent = `${formatDateTime(record.createdAt)} | ${siteCount} 个站点 | ${
      record.startDate || "-"
    } ~ ${record.endDate || "-"} | ${modeText}`;

    btn.appendChild(main);
    btn.appendChild(meta);
    btn.addEventListener("click", () => {
      const sites = Array.isArray(record.sites) ? record.sites : [];
      sitesInput.value = sites.join("\n");
      keywordInput.value = record.keyword || "";
      startDateInput.value = record.startDate || "";
      endDateInput.value = record.endDate || "";
      maxPagesInput.value = String(Number(record.maxPagesPerSite) || 120);
      strictModeInput.checked = Boolean(record.strictMode);
      if (Number.isFinite(record.days)) {
        daysInput.value = String(record.days);
      }
      setStatus("已填充历史搜索条件，可直接点击搜索");
    });

    li.appendChild(btn);
    historyList.appendChild(li);
  });

  clearHistoryBtn.disabled = false;
}

function loadSearchHistory() {
  const loaded = readSearchHistory();
  searchHistory = pruneSearchHistory(loaded);
  persistSearchHistory();
  renderSearchHistory();
}

function saveSearchHistory(record) {
  const incoming = {
    sites: Array.isArray(record.sites)
      ? record.sites.map((site) => String(site || "").trim()).filter(Boolean)
      : [],
    keyword: String(record.keyword || "").trim(),
    startDate: String(record.startDate || ""),
    endDate: String(record.endDate || ""),
    maxPagesPerSite: Number(record.maxPagesPerSite) || 120,
    strictMode: Boolean(record.strictMode),
    days: Number(record.days) || 7,
    createdAt: Date.now(),
  };
  if (!incoming.sites.length || !incoming.keyword || !incoming.startDate || !incoming.endDate) {
    return;
  }

  const incomingFingerprint = getSearchFingerprint(incoming);
  const deduped = searchHistory.filter((item) => getSearchFingerprint(item) !== incomingFingerprint);
  searchHistory = pruneSearchHistory([incoming, ...deduped]);
  persistSearchHistory();
  renderSearchHistory();
}

function clearResults() {
  currentTotal = 0;
  allResults = [];
  listHints = [];
  currentPage = 1;
  siteSearchDetectedMap = {};
  siteResultNotices = [];
  resultList.innerHTML = "";
  resultSummary.textContent = "暂无结果";
  listHintList.innerHTML = "";
  listHintPanel.classList.add("hidden");
  siteNoticeList.innerHTML = "";
  siteNoticePanel.classList.add("hidden");
  updatePaginationControls();
  updateExportState();
}

function renderSummary(startDate, endDate) {
  resultSummary.textContent = `已找到 ${currentTotal} 条结果（${startDate} ~ ${endDate}）`;
}

function getKeywordTerms(keyword) {
  return String(keyword || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function appendHighlightedText(container, text, keyword) {
  const rawText = String(text || "");
  const lowerText = rawText.toLowerCase();
  const terms = getKeywordTerms(keyword);

  if (!terms.length || !rawText) {
    container.textContent = rawText;
    return;
  }

  let cursor = 0;
  while (cursor < rawText.length) {
    let matchedTerm = "";
    for (const term of terms) {
      if (lowerText.startsWith(term, cursor)) {
        matchedTerm = rawText.slice(cursor, cursor + term.length);
        break;
      }
    }

    if (matchedTerm) {
      const mark = document.createElement("mark");
      mark.textContent = matchedTerm;
      container.appendChild(mark);
      cursor += matchedTerm.length;
      continue;
    }

    let nextMatch = rawText.length;
    for (const term of terms) {
      const idx = lowerText.indexOf(term, cursor);
      if (idx !== -1) {
        nextMatch = Math.min(nextMatch, idx);
      }
    }

    container.appendChild(document.createTextNode(rawText.slice(cursor, nextMatch)));
    cursor = nextMatch;
  }
}

function buildResultItem(item) {
  const li = document.createElement("li");
  const title = document.createElement("strong");
  appendHighlightedText(title, item.title || "未识别标题", activeKeyword);

  const siteLine = document.createElement("div");
  siteLine.textContent = `站点：${item.site || "-"}`;

  const timeLine = document.createElement("div");
  timeLine.textContent = `发布时间：${item.publishedAt || "-"}`;

  const linkLine = document.createElement("div");
  linkLine.textContent = "链接：";
  const link = document.createElement("a");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  try {
    const safeUrl = new URL(item.url);
    if (["http:", "https:"].includes(safeUrl.protocol)) {
      link.href = safeUrl.toString();
      link.textContent = safeUrl.toString();
    } else {
      link.textContent = "无效链接";
    }
  } catch (error) {
    link.textContent = "无效链接";
  }
  linkLine.appendChild(link);

  li.appendChild(title);
  li.appendChild(siteLine);
  li.appendChild(timeLine);
  li.appendChild(linkLine);

  if (item.snippet) {
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    snippet.appendChild(document.createTextNode("命中片段："));
    appendHighlightedText(snippet, item.snippet, activeKeyword);
    li.appendChild(snippet);
  }

  return li;
}

function getPageSize() {
  const parsed = Number(pageSizeSelect.value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return parsed;
}

function getTotalPages() {
  return Math.max(1, Math.ceil(allResults.length / getPageSize()));
}

function updatePaginationControls() {
  const totalPages = getTotalPages();
  if (currentPage > totalPages) {
    currentPage = totalPages;
  }

  pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页`;
  prevPageBtn.disabled = allResults.length === 0 || currentPage <= 1;
  nextPageBtn.disabled = allResults.length === 0 || currentPage >= totalPages;
}

function updateExportState() {
  if (!allResults.length) {
    exportBtn.disabled = true;
    return;
  }
  const scope = exportScopeSelect.value === "current" ? "current" : "all";
  exportBtn.disabled = scope === "current" ? getCurrentPageItems().length === 0 : false;
}

function renderCurrentPage() {
  resultList.innerHTML = "";
  if (!allResults.length) {
    updatePaginationControls();
    updateExportState();
    return;
  }

  const pageSize = getPageSize();
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = allResults.slice(start, end);
  pageItems.forEach((item) => {
    resultList.appendChild(buildResultItem(item));
  });

  updatePaginationControls();
  updateExportState();
}

function getCurrentPageItems() {
  if (!allResults.length) {
    return [];
  }
  const pageSize = getPageSize();
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  return allResults.slice(start, end);
}

function addResult(item) {
  allResults.unshift(item);
  currentTotal = allResults.length;
  if (currentPage === 1) {
    renderCurrentPage();
  } else {
    updatePaginationControls();
    updateExportState();
  }
}

function renderListHints() {
  listHintList.innerHTML = "";
  if (!listHints.length) {
    listHintPanel.classList.add("hidden");
    return;
  }

  listHints.forEach((hint) => {
    const li = document.createElement("li");
    const queuedText =
      typeof hint.queuedDetailLinks === "number" ? `，本轮优先下钻 ${hint.queuedDetailLinks} 条` : "";
    const prefix = document.createTextNode(
      `列表页命中，详情候选约 ${hint.detailLikeLinkCount} 条${queuedText}：`
    );
    const link = document.createElement("a");
    link.href = hint.listUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = hint.listUrl;
    li.appendChild(prefix);
    li.appendChild(link);
    listHintList.appendChild(li);
  });
  listHintPanel.classList.remove("hidden");
}

function addListHint(hint) {
  if (!hint || !hint.listUrl) {
    return;
  }
  if (listHints.some((item) => item.listUrl === hint.listUrl)) {
    return;
  }
  listHints.push({
    listUrl: hint.listUrl,
    detailLikeLinkCount: hint.detailLikeLinkCount || 0,
    queuedDetailLinks:
      typeof hint.queuedDetailLinks === "number" ? hint.queuedDetailLinks : undefined,
  });
  renderListHints();
}

function renderSiteResultNotices() {
  siteNoticeList.innerHTML = "";
  if (!siteResultNotices.length) {
    siteNoticePanel.classList.add("hidden");
    return;
  }
  siteResultNotices.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item.text;
    siteNoticeList.appendChild(li);
  });
  siteNoticePanel.classList.remove("hidden");
}

function upsertSiteResultNotice(site, text) {
  if (!site || !text) {
    return;
  }
  const idx = siteResultNotices.findIndex((item) => item.site === site);
  if (idx >= 0) {
    siteResultNotices[idx].text = text;
  } else {
    siteResultNotices.push({ site, text });
  }
  renderSiteResultNotices();
}

function setStatus(message) {
  statusText.textContent = message;
}

function setLoading(loading, message = "正在搜索中...") {
  loadingBox.classList.toggle("hidden", !loading);
  loadingText.textContent = message;
}

function setSearchState(searching) {
  isSearching = searching;
  searchBtn.disabled = searching;
  stopBtn.disabled = !searching;
}

async function handleXlsxImport(file) {
  if (!file) {
    return;
  }

  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const urlSet = new Set();

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    rows.forEach((row) => {
      if (!Array.isArray(row)) {
        return;
      }

      row.forEach((cell) => {
        const text = String(cell || "").trim();
        if (!text) {
          return;
        }

        // 支持纯域名、http/https 地址，自动过滤表头等非 URL 文本。
        if (/^https?:\/\/[^\s]+$/i.test(text) || /^[\w.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(text)) {
          urlSet.add(text);
        }
      });
    });
  });

  const urls = Array.from(urlSet);

  if (!urls.length) {
    setStatus("XLSX 中没有识别到有效站点 URL");
    return;
  }

  const merged = Array.from(new Set([...getSitesFromTextarea(), ...urls]));
  sitesInput.value = merged.join("\n");
  setStatus(`已从 XLSX 导入 ${urls.length} 个站点`);
}

async function runSearch() {
  if (isSearching) {
    return;
  }

  const sites = getSitesFromTextarea();
  const keyword = keywordInput.value.trim();
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;
  const maxPagesPerSite = Number(maxPagesInput.value) || 120;
  const strictMode = Boolean(strictModeInput.checked);

  if (!sites.length) {
    setStatus("请先输入站点或导入 XLSX");
    return;
  }

  if (!keyword) {
    setStatus("请输入关键词");
    return;
  }

  if (!startDate || !endDate) {
    setStatus("请选择开始和结束日期");
    return;
  }

  saveSearchHistory({
    sites,
    keyword,
    startDate,
    endDate,
    maxPagesPerSite,
    strictMode,
    days: Number(daysInput.value),
  });

  setSearchState(true);
  clearResults();
  activeKeyword = keyword;
  setLoading(true, "正在全站搜索中...");
  setStatus("正在搜索，请稍候...");
  currentAbortController = new AbortController();

  try {
    const response = await fetch("/api/search-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        sites,
        keyword,
        startDate,
        endDate,
        maxPagesPerSite,
        strictMode,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "搜索失败");
    }

    if (!response.body) {
      throw new Error("浏览器不支持流式读取");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let lastStartDate = startDate;
    let lastEndDate = endDate;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch (error) {
          return;
        }

        if (event.type === "search_start") {
          lastStartDate = event.startDate || startDate;
          lastEndDate = event.endDate || endDate;
          const modeText = event.strictMode ? "严格模式" : "普通模式";
          setStatus(`开始搜索，共 ${event.siteCount} 个站点（${modeText}）`);
          renderSummary(lastStartDate, lastEndDate);
          return;
        }

        if (event.type === "site_start") {
          setLoading(true, `正在搜索：${event.site}`);
          setStatus(`开始搜索站点：${event.site}`);
          return;
        }

        if (event.type === "page_scanned") {
          setStatus(
            `站点 ${event.site} 已扫描 ${event.scannedPages} 页，待扫描 ${event.queueSize} 页`
          );
          return;
        }

        if (event.type === "result") {
          addResult(event.item);
          renderSummary(lastStartDate, lastEndDate);
          return;
        }

        if (event.type === "list_page_hint") {
          addListHint(event);
          return;
        }

        if (event.type === "search_seed_hint") {
          setStatus(
            `站点 ${event.site} 已通过站内检索引导下钻 ${event.seededCount} 条候选链接`
          );
          return;
        }

        if (event.type === "site_search_status") {
          siteSearchDetectedMap[event.site] = Boolean(event.detected);
          return;
        }

        if (event.type === "site_done") {
          const hasSiteSearchResult = Boolean(siteSearchDetectedMap[event.site]);
          if (!event.error) {
            const tipText = hasSiteSearchResult
              ? `站点 ${event.site}：以下是搜索结果`
              : `站点 ${event.site}：以下结果为代码扫描的结果，建议进入网站再次查询～`;
            upsertSiteResultNotice(event.site, tipText);
          }
          if (event.error) {
            setStatus(`站点完成：${event.site}（失败：${event.error}）`);
          } else {
            setStatus(
              `站点完成：${event.site}，扫描 ${event.scannedPages} 页，命中 ${event.matchedCount} 条`
            );
          }
          return;
        }

        if (event.type === "search_done") {
          const failed = (event.perSite || []).filter((item) => item.error);
          if (failed.length) {
            setStatus(`搜索完成，共 ${event.total} 条结果，${failed.length} 个站点失败`);
          } else {
            setStatus(`搜索完成，共 ${event.total} 条结果`);
          }
          currentTotal = allResults.length;
          renderSummary(lastStartDate, lastEndDate);
          renderCurrentPage();
        }
      });
    }
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("搜索已停止");
    } else {
      setStatus(`搜索失败：${error.message}`);
    }
  } finally {
    currentAbortController = null;
    setSearchState(false);
    setLoading(false);
  }
}

function stopSearch() {
  if (!isSearching || !currentAbortController) {
    return;
  }

  currentAbortController.abort();
  setStatus("正在停止搜索...");
  setLoading(true, "正在停止，请稍候...");
}

function exportResultsToXlsx() {
  if (!allResults.length) {
    setStatus("暂无可导出的结果");
    return;
  }

  const scope = exportScopeSelect.value === "current" ? "current" : "all";
  const sourceItems = scope === "current" ? getCurrentPageItems() : allResults;
  if (!sourceItems.length) {
    setStatus("当前页暂无可导出的结果");
    return;
  }

  const rows = sourceItems.map((item, index) => ({
    序号: index + 1,
    标题: item.title || "",
    站点: item.site || "",
    发布时间: item.publishedAt || "",
    链接: item.url || "",
    命中片段: item.snippet || "",
  }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "搜索结果");

  const now = new Date();
  const scopeText = scope === "current" ? "当前页" : "全部";
  const filename = `搜索结果_${scopeText}_${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(
    2,
    "0"
  )}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(
    2,
    "0"
  )}.xlsx`;

  XLSX.writeFile(workbook, filename);
  setStatus(`已导出 ${rows.length} 条结果（${scopeText}）到 ${filename}`);
}

applyDaysBtn.addEventListener("click", () => {
  const days = Number(daysInput.value);
  applyRecentDays(days);
});

xlsxFile.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  try {
    await handleXlsxImport(file);
  } catch (error) {
    setStatus(`导入失败：${error.message}`);
  } finally {
    xlsxFile.value = "";
  }
});

searchBtn.addEventListener("click", runSearch);
stopBtn.addEventListener("click", stopSearch);
prevPageBtn.addEventListener("click", () => {
  if (currentPage <= 1) {
    return;
  }
  currentPage -= 1;
  renderCurrentPage();
});
nextPageBtn.addEventListener("click", () => {
  if (currentPage >= getTotalPages()) {
    return;
  }
  currentPage += 1;
  renderCurrentPage();
});
pageSizeSelect.addEventListener("change", () => {
  currentPage = 1;
  renderCurrentPage();
});
exportScopeSelect.addEventListener("change", updateExportState);
exportBtn.addEventListener("click", exportResultsToXlsx);
searchTabBtn.addEventListener("click", () => setActiveTab("search"));
historyTabBtn.addEventListener("click", () => setActiveTab("history"));
clearHistoryBtn.addEventListener("click", () => {
  searchHistory = [];
  persistSearchHistory();
  renderSearchHistory();
  setStatus("已清空历史记录");
});
applyRecentDays(7);
setActiveTab("search");
loadSearchHistory();
updatePaginationControls();
updateExportState();
