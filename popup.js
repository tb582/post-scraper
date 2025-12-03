const isFirefox = typeof browser !== "undefined";
const browserAPI = isFirefox ? browser : chrome;
const manifestVersion = browserAPI?.runtime?.getManifest?.()?.version || "dev";
let lastResult = null;
const copyButton = document.getElementById("copy");
const debugToggle = document.getElementById("debugToggle");

function debugLog(...parts) {
  const ts = new Date().toISOString();
  console.log(`[LinkedInScraper v${manifestVersion} ${ts}]`, ...parts);
}

initDebugToggle();

document.getElementById("scrape").addEventListener("click", async () => {
  const output = document.getElementById("output");
  output.textContent = "Scraping current tab...";
  setCopyButtonState(false);
  lastResult = null;

  try {
    const tab = await getActiveTab();

    if (!tab?.id) {
      output.textContent = "Unable to find the active tab.";
      return;
    }

    const response = await sendScrapeRequest(tab.id);
    debugLog("Popup got response", response);

    if (!response?.result) {
      output.textContent = "No result returned. Are you on a LinkedIn post page?";
      return;
    }

    lastResult = response.result;
    setCopyButtonState(true);
    output.textContent = JSON.stringify(lastResult, null, 2);
  } catch (error) {
    debugLog("Popup error", error);
    output.textContent = `Unable to scrape this tab:\n${error.message}`;
  }
});

copyButton.addEventListener("click", async () => {
  if (!lastResult) return;
  const payload = JSON.stringify(lastResult, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    showCopySuccess();
  } catch (err) {
    fallbackCopy(payload);
    showCopySuccess();
  }
});

function showCopySuccess() {
  const previous = copyButton.textContent;
  copyButton.textContent = "Copied!";
  setTimeout(() => {
    copyButton.textContent = previous;
  }, 1200);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function setCopyButtonState(enabled) {
  copyButton.disabled = !enabled;
}

function initDebugToggle() {
  try {
    browserAPI?.storage?.local?.get?.("debugEnabled", (res) => {
      const enabled = !!(res && res.debugEnabled);
      debugToggle.checked = enabled;
    });
  } catch (_err) {
    debugToggle.checked = false;
  }

  debugToggle.addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    try {
      await browserAPI.storage.local.set({ debugEnabled: enabled });
    } catch (_e) {
      /* ignore */
    }

    try {
      const tab = await getActiveTab();
      if (tab?.id) {
        sendDebugFlag(tab.id, enabled);
      }
    } catch (_err) {
      /* ignore */
    }
  });
}

function sendDebugFlag(tabId, enabled) {
  if (isFirefox) {
    browserAPI.tabs.sendMessage(tabId, { type: "SET_DEBUG", enabled }).catch(() => {});
    return;
  }

  browserAPI.tabs.sendMessage(tabId, { type: "SET_DEBUG", enabled }, () => {
    // ignore errors
  });
}

async function getActiveTab() {
  if (isFirefox) {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0];
  }

  return new Promise((resolve, reject) => {
    try {
      browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const err = browserAPI.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(tabs?.[0]);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function sendScrapeRequest(tabId) {
  try {
    return await sendScrapeMessage(tabId);
  } catch (error) {
    const message = error?.message || "";
    const missingReceiver =
      message.includes("Receiving end does not exist") ||
      message.includes("Could not establish connection") ||
      message.includes("No matching message handler") ||
      message.includes("The message port closed before a response was received.");

    // If the content script isn't injected (fresh install or updated tab), try to inject it once.
    if (missingReceiver && (await tryInjectContentScript(tabId))) {
      return sendScrapeMessage(tabId);
    }

    throw error;
  }
}

function sendScrapeMessage(tabId) {
  if (isFirefox) {
    return browserAPI.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN" });
  }

  return new Promise((resolve, reject) => {
    try {
      browserAPI.tabs.sendMessage(tabId, { type: "SCRAPE_LINKEDIN" }, (response) => {
        const err = browserAPI.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function tryInjectContentScript(tabId) {
  try {
    if (browserAPI?.scripting?.executeScript) {
      await browserAPI.scripting.executeScript({
        target: { tabId },
        files: ["contentScript.js"]
      });
      debugLog("Injected content script via scripting.executeScript");
      return true;
    }

    // Legacy fallback (unlikely on MV3, but harmless if available).
    if (browserAPI?.tabs?.executeScript) {
      await browserAPI.tabs.executeScript(tabId, { file: "contentScript.js" });
      debugLog("Injected content script via tabs.executeScript");
      return true;
    }
  } catch (err) {
    debugLog("Failed to inject content script", err?.message || err);
  }
  return false;
}
