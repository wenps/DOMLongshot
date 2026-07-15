chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DOM_LONGSHOT_STOP_SELECTION" && sender.tab?.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, { type: "DOM_LONGSHOT_STOP" }).catch(() => {});
    return false;
  }

  if (message?.type !== "DOM_LONGSHOT_CAPTURE") {
    return false;
  }

  if (!sender.tab?.active || sender.tab.windowId == null) {
    sendResponse({ ok: false, error: "截图页面已经不是当前活动标签页。" });
    return false;
  }

  chrome.tabs.captureVisibleTab(
    sender.tab.windowId,
    { format: "png" },
    (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error || !dataUrl) {
        sendResponse({
          ok: false,
          error: error?.message || "浏览器没有返回截图数据。"
        });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    }
  );

  return true;
});
