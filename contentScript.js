const extensionAPI = typeof browser !== "undefined" ? browser : chrome;
const manifestVersion = extensionAPI?.runtime?.getManifest?.()?.version || "dev";
let debugEnabled = false;
const POST_ROOT_SELECTOR = [
  '[data-urn^="urn:li:activity"]',
  '[data-urn^="urn:li:ugcPost"]',
  '[data-id^="urn:li:activity"]',
  '[data-id^="urn:li:ugcPost"]',
  'article[data-urn^="urn:li:activity"]',
  'article[data-urn^="urn:li:ugcPost"]',
  'article[data-id^="urn:li:activity"]',
  'article[data-id^="urn:li:ugcPost"]',
  "article.feed-shared-update-v2",
  "div.feed-shared-update-v2"
].join(", ");
const COMMENT_NODE_SELECTOR =
  'article[data-id^="urn:li:comment"], [data-test-id="comment"], .comments-comment-item, li.comments-comment-item, .comments-comment-item__main-content, .comments-comment-item__main, .comments-comment-item__body, .comments-comment-item__nested, [data-urn^="urn:li:comment"], li.social-details-social-activity__comment-item, .comments-comment-meta';

function debugLog(...parts) {
  if (!debugEnabled) return;
  const ts = new Date().toISOString();
  console.log(`[LinkedInScraper v${manifestVersion} ${ts}]`, ...parts);
}

extensionAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCRAPE_LINKEDIN") {
    debugLog("Received scrape request on", location.href);
    Promise.resolve(scrapeLinkedIn())
      .then((result) => {
        if (typeof sendResponse === "function") {
          sendResponse({ result });
        }
      })
      .catch((error) => {
        debugLog("Scrape failed", error);
        if (typeof sendResponse === "function") {
          sendResponse({ error: error?.message || String(error) });
        }
      });

    return true; // async response
  }

  if (message?.type === "SET_DEBUG") {
    debugEnabled = !!message.enabled;
    if (extensionAPI?.storage?.local?.set) {
      extensionAPI.storage.local.set({ debugEnabled });
    }
    if (typeof sendResponse === "function") {
      sendResponse({ ok: true });
    }
    return true;
  }

  return undefined;
});

async function scrapeLinkedIn() {
  const postRoot = findActivePostRoot();

  if (!postRoot) {
    debugLog("No post root detected near viewport");
    return {
      url: window.location.href,
      scrapedAt: new Date().toISOString(),
      post: null,
      comments: []
    };
  }

  debugLog("Found post root", postRoot.getAttribute("data-urn") || postRoot.tagName);
  await ensureExpanded(postRoot);
  const post = scrapeMainPost(postRoot);
  const comments = scrapeComments(postRoot);
  const postType = detectPostType(postRoot);

  return {
    url: window.location.href,
    postType,
    scrapedAt: new Date().toISOString(),
    totalComments: comments.length,
    post,
    comments,
    debugHtml: serializeNodeForDebug(postRoot)
  };
}

function findActivePostRoot() {
  const modalContainer = document.querySelector('div[role="dialog"]');
  if (modalContainer) {
    const modalPost = modalContainer.querySelector(POST_ROOT_SELECTOR);
    if (modalPost) {
      debugLog("Detected modal dialog post");
      return modalPost;
    }
  }

  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;
  const centerElement = document.elementFromPoint(viewportCenterX, viewportCenterY);

  if (centerElement) {
    const centerPost = centerElement.closest(POST_ROOT_SELECTOR);
    if (centerPost) {
      debugLog("Post selected via element under viewport center");
      return centerPost;
    }

    const commentAncestor = centerElement.closest(COMMENT_NODE_SELECTOR);
    if (commentAncestor) {
      const owningPost = commentAncestor.closest(POST_ROOT_SELECTOR);
      if (owningPost) {
        debugLog("Viewport center lies within a comment; resolved to owning post");
        return owningPost;
      }
    }
  }

  const candidates = Array.from(document.querySelectorAll(POST_ROOT_SELECTOR));
  if (!candidates.length) {
    return null;
  }

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let containing = null;

  candidates.forEach((node) => {
    const rect = node.getBoundingClientRect();
    const isHidden = rect.height < 60 || rect.bottom <= 0 || rect.top >= window.innerHeight;
    if (isHidden) return;

    if (!containing && rect.top <= viewportCenterY && rect.bottom >= viewportCenterY) {
      containing = node;
    }

    const nodeCenter = rect.top + rect.height / 2;
    const distance = Math.abs(nodeCenter - viewportCenterY);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  });

  if (containing) {
    debugLog("Viewport center lies within candidate");
    return containing;
  }

  if (best) {
    debugLog("Closest candidate distance", bestDistance);
    return best;
  }

  const fallbackElement = document.elementFromPoint(viewportCenterX, viewportCenterY);
  const fallbackPost = fallbackElement?.closest(POST_ROOT_SELECTOR);
  if (fallbackPost) {
    debugLog("Falling back to element under center");
    return fallbackPost;
  }

  const fallbackComment = fallbackElement?.closest(COMMENT_NODE_SELECTOR);
  if (fallbackComment) {
    const owningPost = fallbackComment.closest(POST_ROOT_SELECTOR);
    if (owningPost) {
      return owningPost;
    }
  }

  return candidates[0] || null;
}

function scrapeMainPost(postRoot) {
  if (!postRoot) return null;

  const authorEl = findAuthorElement(postRoot);
  const contentEl = findContentElement(postRoot);
  const timestamp = extractPostTimestamp(postRoot);

  const authorName = extractAuthorName(authorEl);
  const authorProfile = resolveProfileUrl(authorEl);

  return {
    author: authorName,
    authorProfile,
    text: cleanText(contentEl?.innerText),
    timestamp
  };
}

function scrapeComments(postRoot) {
  if (!postRoot) {
    return [];
  }

  const candidateNodes = Array.from(postRoot.querySelectorAll(COMMENT_NODE_SELECTOR));
  const seenNodes = new Set();
  const commentNodes = [];

  candidateNodes.forEach((node) => {
    const article = node.closest('article[data-id^="urn:li:comment"]');
    const sourceNode = article || node;
    if (seenNodes.has(sourceNode)) return;
    seenNodes.add(sourceNode);
    commentNodes.push(sourceNode);
  });
  const out = [];

  commentNodes.forEach((n) => {
    const authorInfo = extractCommentAuthor(n);
    const textEl =
      n.querySelector("span.break-words, span[dir], div.comments-comment-item__main-content") || n;
    const timestamp = extractCommentTimestamp(n);

    out.push({
      author: authorInfo.name,
      authorProfile: authorInfo.profile,
      text: cleanText(textEl?.innerText),
      timestamp
    });
  });

  if (!out.length) {
    debugLog("No comments detected after expansion");
  } else {
    debugLog("Collected comments", out.length);
  }
  return out;
}

function findAuthorElement(root) {
  const actorContainer =
    root.querySelector(".update-components-actor__container") ||
    root.querySelector(".feed-shared-actor__container");

  if (actorContainer) {
    const withinContainer =
      actorContainer.querySelector(".update-components-actor__meta-link") ||
      actorContainer.querySelector(".feed-shared-actor__name") ||
      actorContainer.querySelector(".update-components-actor__title") ||
      actorContainer.querySelector('.update-components-actor__name a[href*="/in/"]');

    if (withinContainer) {
      return withinContainer;
    }
  }

  return (
    root.querySelector(".update-components-actor__meta-link") ||
    root.querySelector(".update-components-actor__title") ||
    root.querySelector('.update-components-actor__name a[href*="/in/"]') ||
    root.querySelector('a[href*="/in/"][data-field="actor-link"]') ||
    root.querySelector(".feed-shared-actor__title a") ||
    root.querySelector(".feed-shared-actor__title") ||
    root.querySelector('a[href*="/in/"]')
  );
}

function findContentElement(root) {
  const selectors = [
    '[data-test-id="main-feed-activity-card__commentary"]',
    ".feed-shared-inline-show-more-text",
    ".update-components-text",
    ".break-words",
    'span[dir][aria-hidden="false"]',
    "div.feed-shared-update-v2__description",
    ".update-components-text-view",
    ".feed-shared-text"
  ];

  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el && !isInsideComment(el)) return el;
  }

  const fallback = root.firstElementChild;
  return fallback && !isInsideComment(fallback) ? fallback : root;
}

function cleanText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function isInsideComment(node) {
  if (!node) return false;
  return !!node.closest(COMMENT_NODE_SELECTOR);
}

function extractCommentAuthor(node) {
  const authorEl =
    node.querySelector(
      '.comments-comment-item__author, [data-test-id="comment-author-link"], a[href*="/in/"], .comments-comment-meta__description-container a, .comments-comment-meta__headline a, .comments-comment-meta__description-title a'
    ) ||
    node.querySelector(".comments-comment-meta__description-container") ||
    node.querySelector(".comments-comment-meta__description-title") ||
    node.querySelector("[data-test-id='comment-author-name']");

  const nameEl =
    authorEl?.querySelector(".comments-comment-meta__description-title span[aria-hidden='true']") ||
    authorEl?.querySelector(".comments-comment-meta__description-title") ||
    authorEl;

  let name = cleanText(nameEl?.textContent) || cleanText(authorEl?.getAttribute?.("aria-label"));
  name = normalizeName(name);
  const profile = resolveProfileUrl(authorEl);

  if (!name) {
    const avatarAlt = node.querySelector("img")?.getAttribute("alt");
    if (avatarAlt) {
      name = cleanText(avatarAlt);
    }
  }

  return {
    name,
    profile
  };
}

function extractCommentTimestamp(node) {
  const timeEl =
    node.querySelector("time") ||
    node.querySelector('[data-test-id="comment-timestamp"]') ||
    node.querySelector(".comments-comment-item__timestamp") ||
    node.querySelector('[data-test-id="social-detail-base-comment__timestamp"]') ||
    node.querySelector(".comments-comment-meta__timestamp") ||
    node.querySelector(".comments-comment-meta__data time");

  if (!timeEl) return null;

  const raw =
    timeEl.getAttribute("datetime") ||
    timeEl.getAttribute("data-time") ||
    timeEl.getAttribute("data-timestamp") ||
    timeEl.dataset?.time ||
    timeEl.dataset?.timestamp ||
    timeEl.dataset?.testTimestamp ||
    null;

  const normalized = normalizeTimestamp(raw) || normalizeTimestamp(timeEl.textContent);
  return normalized || cleanText(timeEl.textContent) || null;
}

async function ensureExpanded(root) {
  await expandPostContent(root);
  await expandComments(root);
}

async function expandPostContent(root) {
  const buttons = Array.from(
    root.querySelectorAll(
      [
        'button[aria-label*="See more"]',
        'button[aria-label*="see more"]',
        'button[aria-label*="Show more"]',
        "button.feed-shared-inline-show-more-text__see-more-less-toggle",
        "button.update-components-text-view__button"
      ].join(", ")
    )
  );

  for (const btn of buttons) {
    const ariaExpanded = btn.getAttribute("aria-expanded");
    if (ariaExpanded === "true") continue;
    debugLog("Expanding post body via", btn?.className || btn?.innerText);
    btn.click();
    await waitFor(() => !btn.isConnected || btn.getAttribute("aria-expanded") === "true", 1200);
  }
}

async function expandComments(root) {
  const seenButtons = new WeakSet();
  const MAX_ROUNDS = 8;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const buttons = getCommentExpanders(root, seenButtons);
    if (!buttons.length) {
      break;
    }

    debugLog("Comment expanders found", buttons.length, "round", round + 1);
    for (const btn of buttons) {
      seenButtons.add(btn);
      const alreadyExpanded = btn.getAttribute("aria-expanded") === "true";
      if (alreadyExpanded) {
        continue;
      }

      debugLog("Clicking comment expander", btn?.getAttribute("aria-label") || btn?.innerText);
      btn.click();
      await sleep(800);
    }
  }

  const commentsLoaded = await waitFor(
    () => root.querySelectorAll(COMMENT_NODE_SELECTOR).length > 0,
    4000
  );

  if (!commentsLoaded) {
    debugLog("Comments did not render in time after clicking expanders");
  }
}

function waitFor(predicate, timeout = 1000, interval = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCommentExpanders(root, seenButtons) {
  const selectors = [
    'button[aria-label*=" comment"]',
    'button[aria-label^="comment"]',
    'button[aria-label*="Comment"]',
    'button[data-test-id*="comments"]',
    'button[data-test-id*="comment__view"]',
    'button[data-test-id*="comment__load"]',
    "button.comments-comments-list__trigger",
    "button.comments-comments-list__see-more",
    "button.comments-comments-list__load-more",
    "button.comments-comment-social-bar__replies-toggle",
    'button[data-control-name*="comment"]',
    'button[aria-controls*="comments"]',
    'span[role="button"][aria-label*="comment"]',
    'span[role="button"][data-test-id*="comment"]'
  ];

  return Array.from(root.querySelectorAll(selectors.join(", "))).filter((btn) => {
    if (seenButtons?.has(btn)) {
      return false;
    }

    const text = (btn.getAttribute("aria-label") || btn.textContent || "").toLowerCase().trim();
    const hasKeyword =
      text.includes("comment") ||
      text.includes("comments") ||
      /see (more|previous) replies/.test(text) ||
      /view (more|previous) replies/.test(text) ||
      text.includes("load more replies");

    const isReaction =
      text.startsWith("react") ||
      text.startsWith("unreact") ||
      text.startsWith("like to") ||
      text.includes("react like");

    if (!hasKeyword || isReaction) {
      return false;
    }

    const isPlainReply =
      text === "reply" ||
      (text.startsWith("reply") && !text.includes("view") && !text.includes("see") && !text.includes("load"));

    if (isPlainReply) {
      return false;
    }

    const reactionIcon =
      btn.closest('[data-control-name*="reaction"], [aria-label*="reaction"]') ||
      btn.querySelector("span.reactions-icon") ||
      text.includes("reaction");

    return !reactionIcon;
  });
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const trimmed = value.toString().trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) return null;
    const millis = trimmed.length <= 10 ? asNumber * 1000 : asNumber;
    return new Date(millis).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  return relativeTextToISO(trimmed);
}

function extractPostTimestamp(root) {
  const timeEl =
    root.querySelector("time") ||
    root.querySelector('[data-test-id="main-feed-activity-card__timestamp"]') ||
    root.querySelector(".update-components-actor__sub-description time") ||
    root.querySelector(".update-components-actor__sub-description");

  if (!timeEl) {
    return null;
  }

  const raw =
    timeEl.getAttribute("datetime") ||
    timeEl.getAttribute("data-time") ||
    timeEl.getAttribute("data-timestamp") ||
    timeEl.dataset?.time ||
    timeEl.dataset?.timestamp ||
    null;

  const normalized = normalizeTimestamp(raw) || normalizeTimestamp(timeEl.textContent);
  return normalized || cleanText(timeEl.textContent) || null;
}

function serializeNodeForDebug(node) {
  if (!node || node.childElementCount > 500) {
    return null;
  }

  const clone = node.cloneNode(true);
  clone.querySelectorAll("script, style").forEach((el) => el.remove());
  return clone.outerHTML;
}

function normalizeName(name) {
  const trimmed = cleanText(name);
  if (!trimmed) return null;

  const viewMatch = trimmed.match(/^view[:\s]+(.+?)(?:['’`´]s\b| graphic|$)/i);
  if (viewMatch) {
    return viewMatch[1].trim();
  }

  return trimmed;
}

function resolveProfileUrl(element) {
  if (!element) return null;
  const anchor =
    (element.tagName === "A" ? element : element.closest('a[href*="/in/"], a[data-entity-urn]')) ||
    null;

  if (!anchor) {
    return null;
  }

  return anchor.getAttribute("href") || anchor.dataset?.entityUrn || anchor.dataset?.entityHovercardId || null;
}

function extractAuthorName(authorEl) {
  if (!authorEl) return null;

  const nameNode =
    authorEl.querySelector(".update-components-actor__title span[aria-hidden='true']") ||
    authorEl.querySelector(".update-components-actor__title span") ||
    authorEl.querySelector(".feed-shared-actor__title span[aria-hidden='true']") ||
    authorEl.querySelector(".feed-shared-actor__title span") ||
    authorEl;

  const text =
    cleanText(nameNode?.textContent) || cleanText(authorEl?.getAttribute?.("aria-label")) || null;

  return normalizeName(text);
}

function relativeTextToISO(text) {
  if (!text) return null;
  const normalized = text
    .split(/[•|]/)[0]
    .replace(/[^\w\s]+$/g, "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  if (["just now", "now", "recently"].includes(normalized)) {
    return new Date().toISOString();
  }

  const match = normalized.match(
    /^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mos?|mo|years?|yrs?|y)$/i
  );

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const unitToMs = {
    s: 1000,
    sec: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    mins: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hr: 3600000,
    hrs: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
    w: 604800000,
    week: 604800000,
    weeks: 604800000,
    mo: 2629800000,
    mos: 2629800000,
    month: 2629800000,
    months: 2629800000,
    y: 31557600000,
    yr: 31557600000,
    yrs: 31557600000,
    year: 31557600000,
    years: 31557600000
  };

  const unitKey = unit.replace(/s$/, "");
  const ms = unitToMs[unit] ?? unitToMs[unitKey];
  if (!ms) {
    return null;
  }

  return new Date(Date.now() - amount * ms).toISOString();
}

function detectPostType(root) {
  const headerText = cleanText(
    root.querySelector(".update-components-header__text-view")?.innerText
  );

  if (!headerText) {
    return "original";
  }

  const lower = headerText.toLowerCase();
  if (lower.includes("reposted") || lower.includes("shared this") || lower.includes("reshared")) {
    return "repost";
  }

  return "original";
}

// Initialize debug flag from storage (best effort).
try {
  extensionAPI?.storage?.local?.get?.("debugEnabled", (res) => {
    if (extensionAPI.runtime?.lastError) return;
    debugEnabled = !!(res && res.debugEnabled);
  });
} catch (_err) {
  // ignore
}
