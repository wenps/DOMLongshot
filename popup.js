const selectButton = document.querySelector("#select");
const status = document.querySelector("#status");

selectButton.addEventListener("click", async () => {
  selectButton.disabled = true;
  status.textContent = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      throw new Error("请在普通 HTTP 或 HTTPS 网页中使用。 ");
    }

    if (chrome.webNavigation?.getAllFrames) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const injections = await Promise.allSettled(
        frames.map((frame) =>
          chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [frame.frameId] },
            files: ["content.js"]
          })
        )
      );
      if (!injections.some((result) => result.status === "fulfilled")) {
        throw new Error("当前页面不允许扩展注入元素选择器。 ");
      }
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"]
      });
    }
    await chrome.tabs.sendMessage(tab.id, { type: "DOM_LONGSHOT_START" });
    window.close();
  } catch (error) {
    status.textContent = error.message || "无法进入元素选择模式。";
    selectButton.disabled = false;
  }
});
