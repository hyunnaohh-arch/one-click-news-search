const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dayjs = require("dayjs");
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

const REQUEST_TIMEOUT = 8000;
const DEFAULT_MAX_PAGES_PER_SITE = 120;
const MAX_PAGES_HARD_LIMIT = 400;
const MAX_SITES = 200;
const MAX_KEYWORD_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; connect-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

function isPrivateIp(hostname) {
  const ipVersion = net.isIP(hostname);
  if (!ipVersion) {
    return false;
  }

  if (ipVersion === 4) {
    const [a, b] = hostname.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    return false;
  }

  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function isBlockedHost(hostname) {
  const lowered = String(hostname || "").toLowerCase();
  if (!lowered) {
    return true;
  }

  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local")
  ) {
    return true;
  }

  return isPrivateIp(lowered);
}

function normalizeUrl(input) {
  if (!input || typeof input !== "string") {
    return "";
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (withProtocol.length > MAX_URL_LENGTH) {
    return "";
  }

  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    if (isBlockedHost(parsed.hostname)) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    responseType: "text",
    maxRedirects: 5,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return response.data;
}

function sendNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function parseDate(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }

  const candidate = dayjs(cleaned);
  if (candidate.isValid()) {
    return candidate.toDate();
  }

  const native = new Date(cleaned);
  if (!Number.isNaN(native.getTime())) {
    return native;
  }

  return null;
}

function isReasonablePublishedDate(dateValue) {
  if (!dateValue) {
    return false;
  }
  const time = dayjs(dateValue);
  if (!time.isValid()) {
    return false;
  }

  const lower = dayjs("1990-01-01");
  const upper = dayjs().add(1, "day").endOf("day");
  return !time.isBefore(lower) && !time.isAfter(upper);
}

function normalizePlainText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isNoisyTextBlock(text) {
  const value = normalizePlainText(text);
  if (!value) {
    return true;
  }

  const basicNoise = /友情链接|相关链接|相关阅读|网站地图|上一篇|下一篇|分享|打印|关闭窗口/.test(
    value
  );
  const foreignAffairsListCount = (
    value.match(/省外办|市外办|自治区外办|地方外办/g) || []
  ).length;
  const heavyDirectoryNoise = foreignAffairsListCount >= 4;

  return basicNoise || heavyDirectoryNoise;
}

function extractMainContentMeta($) {
  const body = $("body").first().clone();
  if (!body.length) {
    return {
      text: normalizePlainText($.text()),
      paragraphCount: 0,
      paragraphs: [],
    };
  }

  body
    .find(
      "script,style,noscript,svg,iframe,header,footer,nav,aside,form,button,input,select,textarea"
    )
    .remove();
  body
    .find(
      "#appendix-list,#relnews-list,.news-foot,.related,.related-news,.recommend,.hot-news,.footer-links,.friend-links,.link-list,.share,.breadcrumb,.crumbs"
    )
    .remove();

  const containerSelectors = [
    "#News_Body_Txt_A",
    ".news-main",
    ".TRS_UEDITOR",
    ".trs_web",
    "article",
    "main",
    "[role='main']",
    ".article",
    ".article-content",
    ".article_body",
    ".content",
    ".detail",
    ".details",
    ".post",
    ".post-content",
    ".entry-content",
    ".news-content",
    ".txt",
    "#content",
    "#article",
    "#main",
  ];

  let bestText = "";
  let bestParagraphCount = 0;
  let bestParagraphs = [];
  let bestScore = -1;
  for (const selector of containerSelectors) {
    body.find(selector).each((_, element) => {
      const text = normalizePlainText($(element).text());
      if (!text || text.length < 80) {
        return;
      }
      const paragraphs = $(element)
        .find("p")
        .toArray()
        .map((node) => normalizePlainText($(node).text()))
        .filter((line) => line.length >= 20 && !isNoisyTextBlock(line));
      const paragraphCount = paragraphs.length;
      const textForScore = text.slice(0, 3000);
      const score =
        textForScore.length +
        paragraphCount * 80 -
        (isNoisyTextBlock(textForScore) ? 1200 : 0);
      if (score > bestScore) {
        bestText = text;
        bestParagraphCount = paragraphCount;
        bestParagraphs = paragraphs;
        bestScore = score;
      }
    });
  }

  if (bestText.length >= 80) {
    return {
      text: bestText,
      paragraphCount: bestParagraphCount,
      paragraphs: bestParagraphs,
    };
  }

  const paragraphParts = [];
  body.find("p").each((_, element) => {
    const text = normalizePlainText($(element).text());
    if (text.length >= 20 && !isNoisyTextBlock(text)) {
      paragraphParts.push(text);
    }
  });

  const paragraphText = paragraphParts.join(" ");
  if (paragraphText.length >= 80) {
    return {
      text: paragraphText,
      paragraphCount: paragraphParts.length,
      paragraphs: paragraphParts,
    };
  }

  return {
    text: normalizePlainText(body.text()),
    paragraphCount: paragraphParts.length,
    paragraphs: paragraphParts,
  };
}

function matchKeywordInBody(mainMeta, keyword, strictMode) {
  const normalizedKeyword = normalizePlainText(keyword);
  if (!normalizedKeyword) {
    return { matched: false, matchedLine: "" };
  }

  const terms = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return { matched: false, matchedLine: "" };
  }

  if (Array.isArray(mainMeta.paragraphs) && mainMeta.paragraphs.length > 0) {
    const line =
      mainMeta.paragraphs.find((value) => terms.every((term) => value.includes(term))) || "";
    if (line) {
      return { matched: true, matchedLine: line };
    }
  }

  if (strictMode) {
    return { matched: false, matchedLine: "" };
  }

  if (terms.every((term) => mainMeta.text.includes(term))) {
    return { matched: true, matchedLine: "" };
  }

  return { matched: false, matchedLine: "" };
}

function buildHitSnippet(mainMeta, keyword, preferredLine = "") {
  const sourceTexts =
    Array.isArray(mainMeta.paragraphs) && mainMeta.paragraphs.length
      ? mainMeta.paragraphs
      : [mainMeta.text];
  const normalizedKeyword = normalizePlainText(keyword);
  const terms = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return "";
  }

  let bestLine = preferredLine || "";
  for (const line of sourceTexts) {
    if (terms.every((term) => line.includes(term))) {
      bestLine = line;
      break;
    }
  }
  if (!bestLine) {
    bestLine = sourceTexts.find((line) => terms.some((term) => line.includes(term))) || "";
  }
  if (!bestLine) {
    if (!mainMeta.text) {
      return "";
    }
    return `${mainMeta.text.slice(0, 120)}${mainMeta.text.length > 120 ? "..." : ""}`;
  }

  const firstTerm = terms.find((term) => bestLine.includes(term)) || terms[0];
  const idx = Math.max(0, bestLine.indexOf(firstTerm));
  const start = Math.max(0, idx - 45);
  const end = Math.min(bestLine.length, idx + firstTerm.length + 75);
  const snippet = bestLine.slice(start, end);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < bestLine.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

function isLikelyDetailPage(url, mainText, paragraphCount) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return mainText.length >= 120;
  }

  const path = parsed.pathname || "";
  const indexLikePath =
    path === "/" ||
    /\/(index|list|channel|columns?)\.s?html?$/i.test(path) ||
    /\/(index|list)\/?$/i.test(path);

  const detailByUrl =
    /(\.s?html?$|\/\d{4}[\/_-]\d{1,2}[\/_-]\d{1,2}\/|detail|article|content|show|view|notice|bulletin|zhaopin|xxgk|zwgk|tzgg|[?&](id|articleid|contentid|docid)=)/i.test(
      `${path}${parsed.search}`
    );

  const detailByBody = mainText.length >= 120 && paragraphCount >= 1;
  if (indexLikePath && !detailByBody) {
    return false;
  }

  return detailByUrl || detailByBody;
}

function isLikelyListPage($, currentUrl, mainMeta) {
  let parsed;
  try {
    parsed = new URL(currentUrl);
  } catch (error) {
    return false;
  }

  const path = parsed.pathname || "";
  const pathWithQuery = `${path}${parsed.search || ""}`;
  // 明显详情页链接（如 t20240529_xxx.htm）不应被判定为列表页。
  if (isDetailLikeUrlText(pathWithQuery) && !/_new\/?$/i.test(path)) {
    return false;
  }
  const listByPath =
    /\/(index|list|channel|columns?)\.s?html?$/i.test(path) ||
    /\/(index|list)\/?$/i.test(path) ||
    /_new\/?$/i.test(path);

  const mainContainer =
    $("#News_Body_Txt_A, .news-main, .TRS_UEDITOR, .trs_web, article, main, #content, #main")
      .first();
  const scope = mainContainer.length ? mainContainer : $("body");

  const anchors = scope.find("a[href]");
  const anchorCount = anchors.length;
  if (anchorCount === 0) {
    return false;
  }

  let detailLikeLinkCount = 0;
  anchors.each((_, el) => {
    const href = $(el).attr("href") || "";
    if (isDetailLikeUrlText(href)) {
      detailLikeLinkCount += 1;
    }
  });

  const linkDensity = anchorCount / Math.max(mainMeta.paragraphCount || 1, 1);
  const manyArticleLinks = detailLikeLinkCount >= 8;
  const listByDensity = anchorCount >= 20 && linkDensity >= 6;

  return listByPath || manyArticleLinks || listByDensity;
}

function getListPageHint($, currentUrl, mainMeta) {
  if (!isLikelyListPage($, currentUrl, mainMeta)) {
    return null;
  }

  const mainContainer =
    $("#News_Body_Txt_A, .news-main, .TRS_UEDITOR, .trs_web, article, main, #content, #main")
      .first();
  const scope = mainContainer.length ? mainContainer : $("body");
  const anchors = scope.find("a[href]");
  let detailLikeLinkCount = 0;
  anchors.each((_, el) => {
    const href = $(el).attr("href") || "";
    if (isDetailLikeUrlText(href)) {
      detailLikeLinkCount += 1;
    }
  });

  if (detailLikeLinkCount < 8) {
    return null;
  }

  return {
    listUrl: currentUrl,
    detailLikeLinkCount,
    totalLinkCount: anchors.length,
  };
}

function parseDateFromLdJson(rawJson) {
  if (!rawJson || typeof rawJson !== "string") {
    return null;
  }

  try {
    const data = JSON.parse(rawJson);
    const array = Array.isArray(data) ? data : [data];

    for (const item of array) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const possible =
        item.datePublished || item.dateCreated || item.uploadDate || null;
      const date = parseDate(possible);
      if (date) {
        return date;
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

function extractPublishedDate($, html) {
  const selectorValues = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("meta[name='publishdate']").attr("content"),
    $("meta[name='publish_time']").attr("content"),
    $("meta[name='published-time']").attr("content"),
    $("meta[name='date']").attr("content"),
    $("meta[itemprop='datePublished']").attr("content"),
    $("time").first().attr("datetime"),
  ];

  for (const value of selectorValues) {
    const date = parseDate(value);
    if (date && isReasonablePublishedDate(date)) {
      return date;
    }
  }

  const scriptDate = parseDateFromLdJson(
    $("script[type='application/ld+json']").first().html()
  );
  if (scriptDate && isReasonablePublishedDate(scriptDate)) {
    return scriptDate;
  }

  // 只在含发布时间语义的文本中提取，避免命中菜单/版权等无关日期。
  const labeledDateRegex =
    /(发布时间|发布于|发布时间：|日期：|时间：|成文日期|发文时间|公开时间)[^0-9]{0,8}(\d{4}[年\/-]\d{1,2}[月\/-]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/i;
  const candidates = [
    $("body").text(),
    $("#News_Body_Txt_A, .news-main, .TRS_UEDITOR, article, main, #content").text(),
    html,
  ];
  for (const content of candidates) {
    const match = String(content || "").match(labeledDateRegex);
    if (!match || !match[2]) {
      continue;
    }
    const date = parseDate(
      match[2].replace("年", "-").replace("月", "-").replace("日", "")
    );
    if (date && isReasonablePublishedDate(date)) {
      return date;
    }
  }

  return null;
}

function extractDateFromUrl(url) {
  // 仅接受详情页常见日期模式，避免将无关路径数字当发布时间。
  const ymdHit = url.match(/\/(20\d{2})[\/_-](\d{1,2})[\/_-](\d{1,2})\//);
  if (ymdHit) {
    const y = ymdHit[1];
    const m = ymdHit[2].padStart(2, "0");
    const d = ymdHit[3].padStart(2, "0");
    const date = parseDate(`${y}-${m}-${d} 00:00:00`);
    return isReasonablePublishedDate(date) ? date : null;
  }

  const compactHit = url.match(/t(20\d{2})(\d{2})(\d{2})_/i);
  if (!compactHit) {
    return null;
  }
  const date = parseDate(`${compactHit[1]}-${compactHit[2]}-${compactHit[3]} 00:00:00`);
  return isReasonablePublishedDate(date) ? date : null;
}

function isSkippableLink(url) {
  return /\.(jpg|jpeg|png|gif|svg|webp|bmp|pdf|zip|rar|7z|docx?|xlsx?|pptx?|mp4|mp3)$/i.test(
    url.pathname
  );
}

function isDetailLikeUrlText(value) {
  return /(\.s?html?$|\/\d{4}[\/_-]\d{1,2}[\/_-]\d{1,2}\/|t\d{8}_\d+|detail|article|content|show|view|notice|bulletin|[?&](id|articleid|contentid|docid)=)/i.test(
    value
  );
}

function isSameSite(baseHost, targetHost) {
  return targetHost === baseHost || targetHost.endsWith(`.${baseHost}`);
}

function isAllowedTraversalHost(hostname, allowedHosts) {
  for (const host of allowedHosts) {
    if (hostname === host || hostname.endsWith(`.${host}`)) {
      return true;
    }
  }
  return false;
}

function getNormalizedKeywordTerms(keyword) {
  return normalizePlainText(keyword).split(/\s+/).filter(Boolean);
}

function buildSectionSeedUrls(siteRootUrl) {
  const seeds = [];
  try {
    const root = new URL(siteRootUrl);
    const commonPaths = ["/zt/", "/xw/", "/xwzx/", "/zw/", "/zwgk/", "/xxgk/"];
    commonPaths.forEach((path) => {
      const url = new URL(path, root.origin).toString();
      if (url !== siteRootUrl) {
        seeds.push(url);
      }
    });
  } catch (error) {
    return [];
  }
  return seeds;
}

function scoreKeywordTermsInText(text, keywordTerms) {
  const normalized = normalizePlainText(text);
  if (!normalized || keywordTerms.length === 0) {
    return 0;
  }
  const allMatched = keywordTerms.every((term) => normalized.includes(term));
  if (allMatched) {
    return 20;
  }
  const partialCount = keywordTerms.filter((term) => normalized.includes(term)).length;
  return partialCount > 0 ? partialCount * 5 : 0;
}

async function bootstrapSectionSeeds(siteRootUrl, allowedHosts, keyword) {
  const seeded = [];
  const seededDetails = [];
  const keywordTerms = getNormalizedKeywordTerms(keyword);
  const sectionRoots = buildSectionSeedUrls(siteRootUrl).slice(0, 3);
  for (const sectionUrl of sectionRoots) {
    try {
      const html = await fetchHtml(sectionUrl);
      const sectionPath = (() => {
        try {
          const match = (new URL(sectionUrl).pathname || "/").match(/^\/(zt|xw|xwzx|zw|zwgk|xxgk)\//i);
          return match ? match[1] : "";
        } catch (error) {
          return "";
        }
      })();
      if (!sectionPath) {
        continue;
      }
      const sectionChildren = extractSectionChildrenFromHtml(
        html,
        sectionUrl,
        allowedHosts,
        sectionPath
      );
      const ranked = [];
      for (const childUrl of sectionChildren.slice(0, 40)) {
        let score = 0;
        score += scoreKeywordTermsInText(childUrl, keywordTerms);
        try {
          const childHtml = await fetchHtml(childUrl);
          const childText = childHtml.slice(0, 18000);
          const textScore = scoreKeywordTermsInText(childText, keywordTerms);
          score += textScore;

          if (textScore >= 20) {
            const $child = cheerio.load(childHtml);
            const detailLinks = extractCandidateLinks($child, childUrl, allowedHosts, keyword).filter(
              (url) => isDetailLikeUrlText(url)
            );
            seededDetails.push(...detailLinks.slice(0, 60));
          }
        } catch (error) {
          // ignore child prefetch failures
        }
        ranked.push({ childUrl, score });
      }
      ranked.sort((a, b) => b.score - a.score);
      seeded.push(...ranked.map((item) => item.childUrl));
    } catch (error) {
      continue;
    }
  }
  return Array.from(new Set([...seededDetails, ...seeded]));
}

function discoverAliasHosts($, currentUrl, allowedHosts) {
  const hostCount = new Map();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    try {
      const absolute = new URL(href, currentUrl);
      if (isBlockedHost(absolute.hostname)) {
        return;
      }
      if (!/\.gov\.cn$/i.test(absolute.hostname)) {
        return;
      }
      if (isAllowedTraversalHost(absolute.hostname, allowedHosts)) {
        return;
      }
      hostCount.set(absolute.hostname, (hostCount.get(absolute.hostname) || 0) + 1);
    } catch (error) {
      return;
    }
  });

  Array.from(hostCount.entries())
    .filter((entry) => entry[1] >= 20)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .forEach((entry) => {
      allowedHosts.add(entry[0]);
    });
}

function buildSiteSearchUrls($, currentUrl, keyword, allowedHosts) {
  const urls = new Set();
  const keywordTerms = getNormalizedKeywordTerms(keyword);
  if (!keywordTerms.length) {
    return [];
  }

  $("form[action]").each((_, form) => {
    const action = $(form).attr("action");
    if (!action || !/search|sousuo|query|retrieve|find/i.test(action)) {
      return;
    }
    try {
      const actionUrl = new URL(action, currentUrl);
      if (!isAllowedTraversalHost(actionUrl.hostname, allowedHosts)) {
        return;
      }

      const params = new URLSearchParams();
      let hasKeywordField = false;
      $(form)
        .find("input[name],select[name],textarea[name]")
        .each((_, field) => {
          const name = ($(field).attr("name") || "").trim();
          if (!name) {
            return;
          }
          const type = ($(field).attr("type") || "").toLowerCase();
          const value = ($(field).attr("value") || "").trim();
          const lowerName = name.toLowerCase();
          const keywordField = /(key|keyword|q|query|search|wd)/i.test(lowerName);
          if (keywordField) {
            hasKeywordField = true;
            params.set(name, keyword);
            return;
          }
          if (type === "hidden" && value) {
            params.set(name, value);
          }
        });

      if (!hasKeywordField) {
        ["key", "keyword", "q"].forEach((name) => {
          if (!params.has(name)) {
            params.set(name, keyword);
          }
        });
      }

      actionUrl.search = params.toString();
      urls.add(actionUrl.toString());
    } catch (error) {
      return;
    }
  });

  return Array.from(urls);
}

async function bootstrapLinksFromSiteSearch({ $, pageUrl, keyword, allowedHosts }) {
  const searchUrls = buildSiteSearchUrls($, pageUrl, keyword, allowedHosts);
  if (!searchUrls.length) {
    return [];
  }

  const seeded = [];
  for (const searchUrl of searchUrls.slice(0, 3)) {
    try {
      const searchHtml = await fetchHtml(searchUrl);
      const $search = cheerio.load(searchHtml);
      discoverAliasHosts($search, searchUrl, allowedHosts);
      const links = extractCandidateLinks($search, searchUrl, allowedHosts, keyword);
      seeded.push(...links.slice(0, 150));
    } catch (error) {
      continue;
    }
  }

  return Array.from(new Set(seeded));
}

function extractCandidateLinks($, currentUrl, allowedHosts, keyword) {
  const linkScores = new Map();
  const keywordTerms = getNormalizedKeywordTerms(keyword);
  let currentPath = "/";
  try {
    currentPath = new URL(currentUrl).pathname || "/";
  } catch (error) {
    currentPath = "/";
  }
  const sectionIndexMatch = currentPath.match(/^\/(zt|xw|xwzx|zw|zwgk|xxgk)\/$/i);

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    if (
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("#")
    ) {
      return;
    }

    try {
      const absolute = new URL(href, currentUrl);
      if (isBlockedHost(absolute.hostname)) {
        return;
      }
      if (!isAllowedTraversalHost(absolute.hostname, allowedHosts) || isSkippableLink(absolute)) {
        return;
      }

      absolute.hash = "";
      const normalized = absolute.href;
      const pathAndQuery = `${absolute.pathname}${absolute.search}`;
      let score = 0;
      if (isDetailLikeUrlText(pathAndQuery)) {
        score += 6;
      }
      const anchorText = normalizePlainText($(element).text());
      if (keywordTerms.length > 0 && anchorText) {
        if (keywordTerms.every((term) => anchorText.includes(term))) {
          score += 10;
        } else if (keywordTerms.some((term) => anchorText.includes(term))) {
          score += 5;
        }
      }
      const urlText = normalizePlainText(pathAndQuery);
      if (keywordTerms.length > 0 && urlText) {
        if (keywordTerms.every((term) => urlText.includes(term))) {
          score += 6;
        } else if (keywordTerms.some((term) => urlText.includes(term))) {
          score += 3;
        }
      }
      const dateFromUrl = extractDateFromUrl(normalized);
      if (dateFromUrl) {
        const year = dayjs(dateFromUrl).year();
        if (year >= 2024) {
          score += 3;
        } else if (year >= 2022) {
          score += 2;
        } else if (year >= 2020) {
          score += 1;
        }
      }
      if (/\/(index|list|channel|columns?)\.s?html?$/i.test(absolute.pathname)) {
        score -= 2;
      }
      if (/_new\/?$/i.test(absolute.pathname)) {
        score -= 1;
      }
      if (sectionIndexMatch) {
        const section = sectionIndexMatch[1].toLowerCase();
        const childSectionPattern = new RegExp(`^\\/${section}\\/[^/]+\\/$`, "i");
        if (childSectionPattern.test(absolute.pathname)) {
          score += 25;
        }
      }

      const prev = linkScores.get(normalized);
      if (prev === undefined || score > prev) {
        linkScores.set(normalized, score);
      }
    } catch (error) {
      return;
    }
  });

  return Array.from(linkScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map((entry) => entry[0]);
}

function extractCandidateLinksFromRawHtml(html, currentUrl, allowedHosts) {
  const links = new Set();
  const content = String(html || "");
  const pathRegex =
    /(\/(?:zt|xw|xwzx|zw|zwgk|xxgk)\/[a-zA-Z0-9_-]+\/(?:\d{6}\/t\d{8}_\d+\.htm)?)/g;
  let match = null;
  while ((match = pathRegex.exec(content)) !== null) {
    const path = match[1];
    try {
      const absolute = new URL(path, currentUrl);
      if (isBlockedHost(absolute.hostname)) {
        continue;
      }
      if (!isAllowedTraversalHost(absolute.hostname, allowedHosts)) {
        continue;
      }
      absolute.hash = "";
      links.add(absolute.toString());
    } catch (error) {
      continue;
    }
  }
  return Array.from(links);
}

function extractSectionChildrenFromHtml(html, currentUrl, allowedHosts, sectionName) {
  const links = new Set();
  const section = String(sectionName || "").toLowerCase();
  if (!section) {
    return [];
  }
  const regex = new RegExp(`\\/${section}\\/[a-zA-Z0-9_-]+\\/`, "g");
  const content = String(html || "");
  let match = null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const absolute = new URL(match[0], currentUrl);
      if (isBlockedHost(absolute.hostname)) {
        continue;
      }
      if (!isAllowedTraversalHost(absolute.hostname, allowedHosts)) {
        continue;
      }
      absolute.hash = "";
      links.add(absolute.toString());
    } catch (error) {
      continue;
    }
  }
  return Array.from(links);
}

function isSectionChildUrl(parentUrl, childUrl) {
  try {
    const parentPath = new URL(parentUrl).pathname || "/";
    const childPath = new URL(childUrl).pathname || "/";
    const match = parentPath.match(/^\/(zt|xw|xwzx|zw|zwgk|xxgk)\/$/i);
    if (!match) {
      return false;
    }
    const section = match[1].toLowerCase();
    return new RegExp(`^\\/${section}\\/[^/]+\\/$`, "i").test(childPath);
  } catch (error) {
    return false;
  }
}

function extractPageDate($, html, url) {
  return extractPublishedDate($, html) || extractDateFromUrl(url);
}

function isDateInRange(dateValue, startDate, endDate) {
  if (!dateValue) {
    return false;
  }

  const time = dayjs(dateValue);
  return (
    time.isValid() &&
    !time.isBefore(startDate.startOf("day")) &&
    !time.isAfter(endDate.endOf("day"))
  );
}

async function searchOneSiteStream({
  siteUrl,
  keyword,
  startDate,
  endDate,
  maxPages,
  strictMode,
  emit,
  shouldStop,
}) {
  const normalized = normalizeUrl(siteUrl);
  if (shouldStop()) {
    return { site: normalized || siteUrl, scannedPages: 0, matchedCount: 0, error: "已取消" };
  }
  if (!normalized) {
    emit({
      type: "site_done",
      site: siteUrl,
      scannedPages: 0,
      matchedCount: 0,
      error: "站点为空或格式无效",
    });
    return { site: siteUrl, scannedPages: 0, matchedCount: 0, error: "站点为空或格式无效" };
  }

  try {
    const root = new URL(normalized);
    const allowedHosts = new Set([root.hostname]);
    const initialSectionSeeds = buildSectionSeedUrls(normalized);
    const queue = [normalized, ...initialSectionSeeds];
    const queued = new Set(queue);
    const visited = new Set();
    const hintedListPages = new Set();
    let searchBootstrapped = false;
    const pendingSectionSeeds = new Set();
    let scannedPages = 0;
    let matchedCount = 0;

    emit({
      type: "site_start",
      site: normalized,
      maxPages,
      message: `开始全站搜索：${normalized}`,
    });

    const deepSectionSeeds = await bootstrapSectionSeeds(normalized, allowedHosts, keyword);
    for (let i = deepSectionSeeds.length - 1; i >= 0; i -= 1) {
      const url = deepSectionSeeds[i];
      if (queued.has(url) || visited.has(url)) {
        continue;
      }
      queue.unshift(url);
      queued.add(url);
      if (/^https?:\/\/[^/]+\/(zt|xw|xwzx|zw|zwgk|xxgk)\/[^/]+\/$/i.test(url)) {
        pendingSectionSeeds.add(url);
      }
    }
    if (deepSectionSeeds.length) {
      emit({
        type: "search_seed_hint",
        site: normalized,
        pageUrl: normalized,
        seededCount: deepSectionSeeds.length,
        seedSample: deepSectionSeeds.slice(0, 8),
      });
    }

    while (queue.length > 0 && scannedPages < maxPages) {
      if (shouldStop()) {
        break;
      }
      const pageUrl = queue.shift();
      queued.delete(pageUrl);
      if (visited.has(pageUrl)) {
        continue;
      }
      visited.add(pageUrl);
      pendingSectionSeeds.delete(pageUrl);
      scannedPages += 1;

      emit({
        type: "page_scanned",
        site: normalized,
        scannedPages,
        queueSize: queue.length,
        url: pageUrl,
      });

      try {
        const html = await fetchHtml(pageUrl);
        if (shouldStop()) {
          break;
        }
        const $ = cheerio.load(html);
        discoverAliasHosts($, pageUrl, allowedHosts);

        if (!searchBootstrapped && scannedPages <= 2) {
          searchBootstrapped = true;
          const seededLinks = await bootstrapLinksFromSiteSearch({
            $,
            pageUrl,
            keyword,
            allowedHosts,
          });
          for (let i = seededLinks.length - 1; i >= 0; i -= 1) {
            const seeded = seededLinks[i];
            if (visited.has(seeded) || queued.has(seeded)) {
              continue;
            }
            queue.unshift(seeded);
            queued.add(seeded);
          }
          if (seededLinks.length) {
            emit({
              type: "search_seed_hint",
              site: normalized,
              pageUrl,
              seededCount: seededLinks.length,
            });
          }
        }

        const mainContentMeta = extractMainContentMeta($);
        const keywordMatch = matchKeywordInBody(mainContentMeta, keyword, strictMode);
        const hasKeyword = keywordMatch.matched;
        const isDetailPage = isLikelyDetailPage(
          pageUrl,
          mainContentMeta.text,
          mainContentMeta.paragraphCount
        );
        const isListPage = isLikelyListPage($, pageUrl, mainContentMeta);
        const listHint = getListPageHint($, pageUrl, mainContentMeta);
        const pageDate = extractPageDate($, html, pageUrl);

        if (
          hasKeyword &&
          isDetailPage &&
          !isListPage &&
          isDateInRange(pageDate, startDate, endDate)
        ) {
          const title =
            $("meta[property='og:title']").attr("content") ||
            $("title").text().trim() ||
            $("h1").first().text().trim() ||
            "未识别标题";

          matchedCount += 1;
          emit({
            type: "result",
            item: {
              site: normalized,
              title,
              url: pageUrl,
              publishedAt: dayjs(pageDate).format("YYYY-MM-DD HH:mm:ss"),
              snippet: buildHitSnippet(mainContentMeta, keyword, keywordMatch.matchedLine),
            },
            scannedPages,
            matchedCount,
          });
        }

        const links = extractCandidateLinks($, pageUrl, allowedHosts, keyword);
        const rawLinks = extractCandidateLinksFromRawHtml(html, pageUrl, allowedHosts);
        for (const rawLink of rawLinks) {
          if (!links.includes(rawLink)) {
            links.unshift(rawLink);
          }
        }
        const pagePath = (() => {
          try {
            return new URL(pageUrl).pathname || "/";
          } catch (error) {
            return "/";
          }
        })();
        const sectionMatch = pagePath.match(/^\/(zt|xw|xwzx|zw|zwgk|xxgk)\/$/i);
        if (sectionMatch) {
          const sectionChildren = extractSectionChildrenFromHtml(
            html,
            pageUrl,
            allowedHosts,
            sectionMatch[1]
          );
          for (const childUrl of sectionChildren.reverse()) {
            if (!links.includes(childUrl)) {
              links.unshift(childUrl);
            }
          }
        }
        const prioritized = [];
        const normal = [];
        const queueSoftLimit = Math.max(maxPages * 20, 2000);
        for (const nextUrl of links) {
          if (visited.has(nextUrl) || queued.has(nextUrl)) {
            continue;
          }
          if (visited.size + queue.length >= queueSoftLimit) {
            continue;
          }
          const allowImmediateDrilldown =
            pendingSectionSeeds.size === 0 || (isListPage && hasKeyword);
          const shouldPrioritize =
            ((isListPage && isDetailLikeUrlText(nextUrl)) ||
              isSectionChildUrl(pageUrl, nextUrl)) &&
            allowImmediateDrilldown;
          if (shouldPrioritize) {
            prioritized.push(nextUrl);
            continue;
          }
          normal.push(nextUrl);
        }

        // 列表页下钻时优先扫描详情链接，避免“列表命中但详情未及时搜索”。
        for (let i = prioritized.length - 1; i >= 0; i -= 1) {
          const nextUrl = prioritized[i];
          queue.unshift(nextUrl);
          queued.add(nextUrl);
        }
        for (const nextUrl of normal) {
          queue.push(nextUrl);
          queued.add(nextUrl);
        }

        if (listHint && !hintedListPages.has(pageUrl)) {
          hintedListPages.add(pageUrl);
          emit({
            type: "list_page_hint",
            site: normalized,
            ...listHint,
            queuedDetailLinks: prioritized.length,
          });
        }
      } catch (error) {
        emit({
          type: "page_error",
          site: normalized,
          url: pageUrl,
          message: error.message,
        });
        continue;
      }
    }

    const summary = {
      site: normalized,
      scannedPages,
      matchedCount,
      error: shouldStop() ? "已取消" : "",
    };
    if (!shouldStop()) {
      emit({ type: "site_done", ...summary });
    }
    return summary;
  } catch (error) {
    const summary = {
      site: normalized,
      scannedPages: 0,
      matchedCount: 0,
      error: `抓取失败: ${error.message}`,
    };
    if (!shouldStop()) {
      emit({ type: "site_done", ...summary });
    }
    return summary;
  }
}

app.post("/api/search-stream", async (req, res) => {
  const { sites, keyword, startDate, endDate, maxPagesPerSite, strictMode } = req.body;

  if (!Array.isArray(sites) || sites.length === 0) {
    return res.status(400).json({ error: "请至少输入一个站点" });
  }
  if (sites.length > MAX_SITES) {
    return res.status(400).json({ error: `站点数量不能超过 ${MAX_SITES} 个` });
  }

  if (!keyword || typeof keyword !== "string") {
    return res.status(400).json({ error: "请输入关键词" });
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `关键词长度不能超过 ${MAX_KEYWORD_LENGTH} 个字符` });
  }

  const sanitizedSites = Array.from(
    new Set(
      sites
        .map((site) => normalizeUrl(String(site || "").trim()))
        .filter(Boolean)
    )
  );
  if (!sanitizedSites.length) {
    return res.status(400).json({ error: "没有可用站点，请检查网址格式" });
  }

  const start = dayjs(startDate);
  const end = dayjs(endDate);
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
    return res.status(400).json({ error: "时间范围无效" });
  }

  const parsedLimit = Number(maxPagesPerSite);
  const maxPages = Number.isFinite(parsedLimit)
    ? Math.max(10, Math.min(MAX_PAGES_HARD_LIMIT, Math.floor(parsedLimit)))
    : DEFAULT_MAX_PAGES_PER_SITE;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  let clientClosed = false;
  req.on("aborted", () => {
    clientClosed = true;
  });
  res.on("close", () => {
    clientClosed = true;
  });
  const shouldStop = () => clientClosed || res.writableEnded || res.destroyed;
  const safeSend = (payload) => {
    if (!shouldStop()) {
      sendNdjson(res, payload);
    }
  };

  safeSend({
    type: "search_start",
    keyword: keyword.trim(),
    startDate: start.format("YYYY-MM-DD"),
    endDate: end.format("YYYY-MM-DD"),
    siteCount: sanitizedSites.length,
    maxPagesPerSite: maxPages,
    strictMode: Boolean(strictMode),
  });

  const siteSummaries = [];
  let total = 0;

  for (const site of sanitizedSites) {
    if (shouldStop()) {
      break;
    }
    const summary = await searchOneSiteStream({
      siteUrl: site,
      keyword: keyword.trim(),
      startDate: start,
      endDate: end,
      maxPages,
      strictMode: Boolean(strictMode),
      shouldStop,
      emit: (event) => {
        if (shouldStop()) {
          return;
        }
        if (event.type === "result") {
          total += 1;
          safeSend({ ...event, total });
          return;
        }
        safeSend(event);
      },
    });
    siteSummaries.push(summary);
  }

  if (!shouldStop()) {
    safeSend({
      type: "search_done",
      total,
      perSite: siteSummaries,
    });
  }

  if (!res.writableEnded) {
    return res.end();
  }
  return undefined;
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
