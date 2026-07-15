(() => {
  const GLOBAL_KEY = "__domLongshotLoaded";
  if (window[GLOBAL_KEY]) {
    return;
  }
  window[GLOBAL_KEY] = true;

  const CAPTURE_INTERVAL_MS = 600;
  const MAX_CANVAS_SIDE = 30000;
  const MAX_CANVAS_PIXELS = 100_000_000;
  const FRAME_CHANNEL = `dom-longshot-frame-${chrome.runtime.id}`;

  let selectionCleanup = null;
  const parentRequests = new Map();
  const frameRestorePositions = new Map();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "DOM_LONGSHOT_START") {
      startSelection();
    }
    if (message?.type === "DOM_LONGSHOT_STOP") {
      selectionCleanup?.();
    }
  });

  window.addEventListener("message", onFrameMessage, true);

  function startSelection() {
    selectionCleanup?.();

    const overlay = document.createElement("div");
    const label = document.createElement("div");
    const hint = document.createElement("div");
    let hoveredElement = null;

    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid #ff5a32",
      borderRadius: "3px",
      background: "rgba(255, 90, 50, 0.1)",
      boxShadow: "0 0 0 1px rgba(255,255,255,0.75), 0 8px 28px rgba(23,26,24,0.14)",
      boxSizing: "border-box",
      display: "none"
    });
    Object.assign(label.style, {
      position: "absolute",
      left: "-2px",
      bottom: "calc(100% + 7px)",
      maxWidth: "min(420px, 90vw)",
      padding: "6px 9px",
      overflow: "hidden",
      color: "#fff",
      background: "#171a18",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "5px",
      boxShadow: "0 5px 16px rgba(0,0,0,0.22)",
      font: "600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
    Object.assign(hint.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 14px",
      border: "1px solid rgba(255,255,255,0.13)",
      borderRadius: "7px",
      color: "#fff",
      background: "rgba(23,26,24,0.96)",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.24)",
      backdropFilter: "blur(8px)",
      font: "600 12px/1.4 ui-sans-serif, system-ui, sans-serif",
      pointerEvents: "none"
    });
    hint.textContent = "点击选择元素，按 Esc 取消";
    overlay.append(label);
    document.documentElement.append(overlay, hint);

    const updateOverlay = (element) => {
      const rect = element.getBoundingClientRect();
      const name = element.id
        ? `${element.tagName.toLowerCase()}#${element.id}`
        : element.classList.length
          ? `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join(".")}`
          : element.tagName.toLowerCase();

      Object.assign(overlay.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });
      label.textContent = `${name}  ${Math.round(rect.width)} x ${Math.round(rect.height)}`;
    };

    const onPointerMove = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === overlay || element === hint || overlay.contains(element)) {
        return;
      }
      hoveredElement = element;
      updateOverlay(element);
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      hint.remove();
      selectionCleanup = null;
    };

    const onClick = (event) => {
      if (!hoveredElement) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = hoveredElement;
      cleanup();
      void chrome.runtime.sendMessage({ type: "DOM_LONGSHOT_STOP_SELECTION" });
      void captureElement(target);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        void chrome.runtime.sendMessage({ type: "DOM_LONGSHOT_STOP_SELECTION" });
      }
    };

    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    selectionCleanup = cleanup;
  }

  async function captureElement(target) {
    const initialScrollX = window.scrollX;
    const initialScrollY = window.scrollY;
    const scrollSurface = findElementScrollSurface(target);
    const elementScrollMode = scrollSurface != null;
    const ownScrollContent = scrollSurface === target;
    const initialElementScroll = elementScrollMode
      ? { left: scrollSurface.scrollLeft, top: scrollSurface.scrollTop }
      : null;
    const previousElementScrollBehavior = elementScrollMode
      ? scrollSurface.style.scrollBehavior
      : null;
    const previousScrollSnapType = elementScrollMode
      ? scrollSurface.style.scrollSnapType
      : null;
    const sessionId = crypto.randomUUID();
    const rootStyle = document.documentElement.style;
    const previousScrollBehavior = rootStyle.scrollBehavior;
    const notice = createNotice();
    let outerScrollPositions = [];

    try {
      rootStyle.scrollBehavior = "auto";
      if (elementScrollMode) {
        outerScrollPositions = captureOuterScrollPositions(scrollSurface);
        scrollSurface.style.scrollBehavior = "auto";
        scrollSurface.style.scrollSnapType = "none";
        scrollSurface.scrollIntoView({ block: "start", inline: "start" });
        await waitForFrameLayout();
      }

      let frameContext = await getFrameContext(sessionId, true);
      await waitForFrameLayout();
      frameContext = await getFrameContext(sessionId, false);

      if (
        frameContext.clipRight - frameContext.clipLeft < window.innerWidth - 1 ||
        frameContext.clipBottom - frameContext.clipTop < window.innerHeight - 1
      ) {
        throw new Error("iframe 外框超出可见区域，暂时无法完整截图。 ");
      }

      const initialRect = target.getBoundingClientRect();
      if (initialRect.width <= 0 || initialRect.height <= 0) {
        throw new Error("这个元素没有可截图的可见尺寸。 ");
      }

      const scrollSurfaceRect = elementScrollMode
        ? getElementClientRect(scrollSurface)
        : null;
      const targetOriginInSurface = elementScrollMode && !ownScrollContent
        ? {
            left: initialRect.left - scrollSurfaceRect.left + scrollSurface.scrollLeft,
            top: initialRect.top - scrollSurfaceRect.top + scrollSurface.scrollTop
          }
        : null;
      const targetRect = ownScrollContent
        ? {
            left: 0,
            top: 0,
            right: scrollSurface.scrollWidth,
            bottom: scrollSurface.scrollHeight,
            width: scrollSurface.scrollWidth,
            height: scrollSurface.scrollHeight
          }
        : {
            left: elementScrollMode ? 0 : initialRect.left + window.scrollX,
            top: elementScrollMode ? 0 : initialRect.top + window.scrollY,
            right: elementScrollMode ? initialRect.width : initialRect.right + window.scrollX,
            bottom: elementScrollMode ? initialRect.height : initialRect.bottom + window.scrollY,
            width: initialRect.width,
            height: initialRect.height
          };
      const localClip = getLocalFrameClip(frameContext);
      if (elementScrollMode) {
        if (
          scrollSurfaceRect.left < localClip.left - 1 ||
          scrollSurfaceRect.top < localClip.top - 1 ||
          scrollSurfaceRect.right > localClip.right + 1 ||
          scrollSurfaceRect.bottom > localClip.bottom + 1
        ) {
          throw new Error("滚动容器需要完整显示在当前 iframe 中。 ");
        }
      }

      const captureWidth = elementScrollMode
        ? Math.min(scrollSurface.clientWidth, targetRect.width)
        : localClip.right - localClip.left;
      const captureHeight = elementScrollMode
        ? Math.min(scrollSurface.clientHeight, targetRect.height)
        : localClip.bottom - localClip.top;
      if (captureWidth <= 0 || captureHeight <= 0) {
        throw new Error("iframe 当前没有可截图的可见区域。 ");
      }

      const columns = Math.ceil(targetRect.width / captureWidth);
      const rows = Math.ceil(targetRect.height / captureHeight);
      const totalTiles = columns * rows;

      notice.set(`准备截图，共 ${totalTiles} 个分片`);

      let canvas = null;
      let context = null;
      let outputScale = null;
      let completedTiles = 0;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const segment = {
            left: targetRect.left + column * captureWidth,
            top: targetRect.top + row * captureHeight,
            right: Math.min(targetRect.right, targetRect.left + (column + 1) * captureWidth),
            bottom: Math.min(targetRect.bottom, targetRect.top + (row + 1) * captureHeight)
          };

          if (elementScrollMode) {
            scrollSurface.scrollTo(
              segment.left + (targetOriginInSurface?.left || 0),
              segment.top + (targetOriginInSurface?.top || 0)
            );
          } else {
            window.scrollTo(segment.left - localClip.left, segment.top - localClip.top);
          }
          await waitForPageToSettle();
          notice.hide();
          await nextFrame();

          const screenshot = await requestScreenshot();
          const image = await loadImage(screenshot);
          const currentFrameContext = await getFrameContext(sessionId, false);
          notice.show();

          if (outputScale == null) {
            const nativeScale = Math.min(
              image.naturalWidth / currentFrameContext.topWidth,
              image.naturalHeight / currentFrameContext.topHeight
            );
            outputScale = calculateOutputScale(targetRect, nativeScale);
            canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(targetRect.width * outputScale));
            canvas.height = Math.max(1, Math.round(targetRect.height * outputScale));
            context = canvas.getContext("2d", { alpha: false });
            if (!context) {
              throw new Error("浏览器无法创建图片画布。 ");
            }
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
          }

          const currentLocalClip = getLocalFrameClip(currentFrameContext);
          const actualViewport = elementScrollMode
            ? ownScrollContent
              ? {
                  left: scrollSurface.scrollLeft,
                  top: scrollSurface.scrollTop,
                  right: scrollSurface.scrollLeft + scrollSurface.clientWidth,
                  bottom: scrollSurface.scrollTop + scrollSurface.clientHeight
                }
              : {
                  left: scrollSurface.scrollLeft - targetOriginInSurface.left,
                  top: scrollSurface.scrollTop - targetOriginInSurface.top,
                  right:
                    scrollSurface.scrollLeft - targetOriginInSurface.left + scrollSurface.clientWidth,
                  bottom:
                    scrollSurface.scrollTop - targetOriginInSurface.top + scrollSurface.clientHeight
                }
            : {
                left: window.scrollX + currentLocalClip.left,
                top: window.scrollY + currentLocalClip.top,
                right: window.scrollX + currentLocalClip.right,
                bottom: window.scrollY + currentLocalClip.bottom
              };
          const visible = intersectRects(segment, actualViewport);
          if (visible) {
            const sourceScaleX = image.naturalWidth / currentFrameContext.topWidth;
            const sourceScaleY = image.naturalHeight / currentFrameContext.topHeight;
            const currentClientRect = ownScrollContent
              ? getElementClientRect(scrollSurface)
              : null;
            const currentTargetRect = elementScrollMode && !ownScrollContent
              ? target.getBoundingClientRect()
              : null;
            const sourceLeft = elementScrollMode
              ? ownScrollContent
                ? currentFrameContext.offsetX + currentClientRect.left + visible.left - scrollSurface.scrollLeft
                : currentFrameContext.offsetX + currentTargetRect.left + visible.left
              : currentFrameContext.offsetX + visible.left - window.scrollX;
            const sourceTop = elementScrollMode
              ? ownScrollContent
                ? currentFrameContext.offsetY + currentClientRect.top + visible.top - scrollSurface.scrollTop
                : currentFrameContext.offsetY + currentTargetRect.top + visible.top
              : currentFrameContext.offsetY + visible.top - window.scrollY;
            context.drawImage(
              image,
              sourceLeft * sourceScaleX,
              sourceTop * sourceScaleY,
              (visible.right - visible.left) * sourceScaleX,
              (visible.bottom - visible.top) * sourceScaleY,
              (visible.left - targetRect.left) * outputScale,
              (visible.top - targetRect.top) * outputScale,
              (visible.right - visible.left) * outputScale,
              (visible.bottom - visible.top) * outputScale
            );
          }

          completedTiles += 1;
          notice.set(`正在生成长图 ${completedTiles}/${totalTiles}`);
        }
      }

      notice.set("正在导出 PNG");
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, createFilename(target));
      try {
        await copyBlobToClipboard(blob);
        notice.success("长图已下载并复制到剪贴板");
      } catch (clipboardError) {
        console.warn("DOM Longshot clipboard write failed", clipboardError);
        notice.warning("PNG 已下载，但无法复制到剪贴板");
      }
    } catch (error) {
      console.error("DOM Longshot capture failed", error);
      notice.error(error.message || "截图失败，请重试。 ");
    } finally {
      if (elementScrollMode) {
        scrollSurface.scrollTo(initialElementScroll.left, initialElementScroll.top);
        for (const entry of outerScrollPositions) {
          entry.element.scrollTo(entry.left, entry.top);
        }
        await waitForFrameLayout();
        for (const entry of outerScrollPositions) {
          entry.element.style.scrollBehavior = entry.scrollBehavior;
        }
        scrollSurface.style.scrollBehavior = previousElementScrollBehavior;
        scrollSurface.style.scrollSnapType = previousScrollSnapType;
      }
      window.scrollTo(initialScrollX, initialScrollY);
      await waitForFrameLayout();
      await restoreFrameChain(sessionId);
      rootStyle.scrollBehavior = previousScrollBehavior;
      window.setTimeout(() => notice.remove(), 2400);
    }
  }

  function isElementScrollSurface(element) {
    if (
      element === document.body ||
      element === document.documentElement ||
      element === document.scrollingElement
    ) {
      return false;
    }

    const style = getComputedStyle(element);
    const canScrollX =
      element.scrollWidth > element.clientWidth + 1 &&
      style.overflowX !== "visible" &&
      style.overflowX !== "clip";
    const canScrollY =
      element.scrollHeight > element.clientHeight + 1 &&
      style.overflowY !== "visible" &&
      style.overflowY !== "clip";
    return canScrollX || canScrollY;
  }

  function findElementScrollSurface(target) {
    if (isElementScrollSurface(target)) {
      return target;
    }

    const targetRect = target.getBoundingClientRect();
    let ancestor = target.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      if (isElementScrollSurface(ancestor)) {
        const clientRect = getElementClientRect(ancestor);
        const clipsTarget =
          targetRect.left < clientRect.left - 1 ||
          targetRect.top < clientRect.top - 1 ||
          targetRect.right > clientRect.right + 1 ||
          targetRect.bottom > clientRect.bottom + 1;
        if (clipsTarget) {
          return ancestor;
        }
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function getElementClientRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + element.clientLeft,
      top: rect.top + element.clientTop,
      right: rect.left + element.clientLeft + element.clientWidth,
      bottom: rect.top + element.clientTop + element.clientHeight
    };
  }

  function captureOuterScrollPositions(element) {
    const positions = [];
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      if (
        ancestor.scrollHeight > ancestor.clientHeight ||
        ancestor.scrollWidth > ancestor.clientWidth
      ) {
        positions.push({
          element: ancestor,
          left: ancestor.scrollLeft,
          top: ancestor.scrollTop,
          scrollBehavior: ancestor.style.scrollBehavior
        });
        ancestor.style.scrollBehavior = "auto";
      }
      ancestor = ancestor.parentElement;
    }
    return positions;
  }

  function getLocalFrameClip(context) {
    return {
      left: context.clipLeft - context.offsetX,
      top: context.clipTop - context.offsetY,
      right: context.clipRight - context.offsetX,
      bottom: context.clipBottom - context.offsetY
    };
  }

  function getFrameContext(sessionId, ensureVisible) {
    if (window === window.top) {
      return Promise.resolve({
        offsetX: 0,
        offsetY: 0,
        clipLeft: 0,
        clipTop: 0,
        clipRight: window.innerWidth,
        clipBottom: window.innerHeight,
        topWidth: window.innerWidth,
        topHeight: window.innerHeight
      });
    }

    return requestParent("DOM_LONGSHOT_FRAME_CONTEXT", { sessionId, ensureVisible });
  }

  async function restoreFrameChain(sessionId) {
    if (window === window.top) {
      return;
    }
    try {
      await requestParent("DOM_LONGSHOT_FRAME_RESTORE", { sessionId });
    } catch (error) {
      console.warn("DOM Longshot could not restore a parent frame", error);
    }
  }

  function requestParent(type, payload) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        parentRequests.delete(requestId);
        reject(new Error("iframe 与父页面通信超时。"));
      }, 10_000);

      parentRequests.set(requestId, { resolve, reject, timeout });
      window.parent.postMessage(
        { channel: FRAME_CHANNEL, type, requestId, ...payload },
        "*"
      );
    });
  }

  function onFrameMessage(event) {
    const message = event.data;
    if (!message || message.channel !== FRAME_CHANNEL) {
      return;
    }

    if (message.type === "DOM_LONGSHOT_FRAME_RESPONSE" && event.source === window.parent) {
      const pending = parentRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timeout);
      parentRequests.delete(message.requestId);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      message.type !== "DOM_LONGSHOT_FRAME_CONTEXT" &&
      message.type !== "DOM_LONGSHOT_FRAME_RESTORE"
    ) {
      return;
    }

    const frameElement = findChildFrame(event.source);
    if (!frameElement) {
      return;
    }

    void respondToFrameRequest(event.source, message, frameElement);
  }

  async function respondToFrameRequest(source, message, frameElement) {
    try {
      let result;
      if (message.type === "DOM_LONGSHOT_FRAME_CONTEXT") {
        result = await createChildFrameContext(
          frameElement,
          message.sessionId,
          message.ensureVisible
        );
      } else {
        const savedPosition = frameRestorePositions.get(message.sessionId);
        if (savedPosition) {
          for (const entry of savedPosition.elements) {
            entry.element.scrollTo(entry.left, entry.top);
          }
          window.scrollTo(savedPosition.windowX, savedPosition.windowY);
          frameRestorePositions.delete(message.sessionId);
          await waitForFrameLayout();
          for (const entry of savedPosition.elements) {
            entry.element.style.scrollBehavior = entry.scrollBehavior;
          }
          document.documentElement.style.scrollBehavior = savedPosition.rootScrollBehavior;
        }
        await restoreFrameChain(message.sessionId);
        result = true;
      }

      source.postMessage(
        {
          channel: FRAME_CHANNEL,
          type: "DOM_LONGSHOT_FRAME_RESPONSE",
          requestId: message.requestId,
          result
        },
        "*"
      );
    } catch (error) {
      source.postMessage(
        {
          channel: FRAME_CHANNEL,
          type: "DOM_LONGSHOT_FRAME_RESPONSE",
          requestId: message.requestId,
          error: error.message || "无法计算 iframe 位置。"
        },
        "*"
      );
    }
  }

  async function createChildFrameContext(frameElement, sessionId, ensureVisible) {
    const frameStyle = getComputedStyle(frameElement);
    if (frameStyle.transform !== "none" || Number.parseFloat(frameStyle.zoom || "1") !== 1) {
      throw new Error("暂不支持经过 CSS transform 或 zoom 变换的 iframe。 ");
    }

    const parentContext = await getFrameContext(sessionId, ensureVisible);
    if (ensureVisible) {
      if (!frameRestorePositions.has(sessionId)) {
        frameRestorePositions.set(sessionId, captureFrameScrollState(frameElement));
      }
      frameElement.scrollIntoView({ block: "start", inline: "start" });
      await waitForFrameLayout();
    }

    const rect = frameElement.getBoundingClientRect();
    const offsetX = parentContext.offsetX + rect.left + frameElement.clientLeft;
    const offsetY = parentContext.offsetY + rect.top + frameElement.clientTop;
    const frameRect = {
      left: offsetX,
      top: offsetY,
      right: offsetX + frameElement.clientWidth,
      bottom: offsetY + frameElement.clientHeight
    };
    const clip = intersectRects(
      frameRect,
      {
        left: parentContext.clipLeft,
        top: parentContext.clipTop,
        right: parentContext.clipRight,
        bottom: parentContext.clipBottom
      }
    );

    if (!clip) {
      throw new Error("iframe 被父页面完全遮挡或裁剪。 ");
    }

    return {
      offsetX,
      offsetY,
      clipLeft: clip.left,
      clipTop: clip.top,
      clipRight: clip.right,
      clipBottom: clip.bottom,
      topWidth: parentContext.topWidth,
      topHeight: parentContext.topHeight
    };
  }

  function findChildFrame(sourceWindow) {
    for (const frame of document.querySelectorAll("iframe, frame")) {
      if (frame.contentWindow === sourceWindow) {
        return frame;
      }
    }
    return null;
  }

  function captureFrameScrollState(frameElement) {
    const elements = [];
    const rootScrollBehavior = document.documentElement.style.scrollBehavior;
    let ancestor = frameElement.parentElement;
    while (ancestor) {
      if (
        ancestor.scrollHeight > ancestor.clientHeight ||
        ancestor.scrollWidth > ancestor.clientWidth
      ) {
        elements.push({
          element: ancestor,
          left: ancestor.scrollLeft,
          top: ancestor.scrollTop,
          scrollBehavior: ancestor.style.scrollBehavior
        });
        ancestor.style.scrollBehavior = "auto";
      }
      ancestor = ancestor.parentElement;
    }

    document.documentElement.style.scrollBehavior = "auto";
    return {
      windowX: window.scrollX,
      windowY: window.scrollY,
      rootScrollBehavior,
      elements
    };
  }

  function waitForFrameLayout() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function calculateOutputScale(rect, nativeScale) {
    const sideScale = Math.min(
      MAX_CANVAS_SIDE / rect.width,
      MAX_CANVAS_SIDE / rect.height
    );
    const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (rect.width * rect.height));
    return Math.min(nativeScale, sideScale, pixelScale);
  }

  function intersectRects(a, b) {
    const result = {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom)
    };
    return result.right > result.left && result.bottom > result.top ? result : null;
  }

  async function requestScreenshot() {
    const response = await chrome.runtime.sendMessage({ type: "DOM_LONGSHOT_CAPTURE" });
    if (!response?.ok) {
      throw new Error(response?.error || "浏览器截图失败。 ");
    }
    return response.dataUrl;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取浏览器截图。"));
      image.src = dataUrl;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("图片过大，浏览器无法完成 PNG 编码。"));
        }
      }, "image/png");
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.documentElement.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function copyBlobToClipboard(blob) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard API is unavailable");
    }
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob })
    ]);
  }

  function createFilename(target) {
    const identity = target.id || target.tagName.toLowerCase();
    const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `dom-longshot-${safeIdentity}-${timestamp}.png`;
  }

  function waitForPageToSettle() {
    return new Promise((resolve) => {
      window.setTimeout(resolve, CAPTURE_INTERVAL_MS);
    });
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function createNotice() {
    const element = document.createElement("div");
    const dot = document.createElement("span");
    const text = document.createElement("span");
    Object.assign(element.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "16px",
      left: "50%",
      display: "flex",
      alignItems: "center",
      gap: "9px",
      transform: "translateX(-50%)",
      padding: "10px 14px",
      border: "1px solid rgba(255,255,255,0.13)",
      borderRadius: "7px",
      color: "#fff",
      background: "rgba(23,26,24,0.96)",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.24)",
      backdropFilter: "blur(8px)",
      font: "600 12px/1.4 ui-sans-serif, system-ui, sans-serif",
      pointerEvents: "none"
    });
    Object.assign(dot.style, {
      width: "7px",
      height: "7px",
      flex: "0 0 auto",
      borderRadius: "50%",
      background: "#ff5a32",
      boxShadow: "0 0 0 3px rgba(255,90,50,0.18)"
    });
    element.append(dot, text);
    document.documentElement.append(element);

    return {
      set(value) {
        text.textContent = value;
        element.style.background = "rgba(23,26,24,0.96)";
        dot.style.background = "#ff5a32";
      },
      success(value) {
        text.textContent = value;
        element.style.background = "rgba(22,100,67,0.96)";
        dot.style.background = "#8ce0b7";
      },
      error(value) {
        text.textContent = value;
        element.style.background = "rgba(167,57,31,0.96)";
        dot.style.background = "#ffc0ae";
      },
      warning(value) {
        text.textContent = value;
        element.style.background = "rgba(126,83,18,0.96)";
        dot.style.background = "#ffd88a";
      },
      hide() {
        element.style.visibility = "hidden";
      },
      show() {
        element.style.visibility = "visible";
      },
      remove() {
        element.remove();
      }
    };
  }
})();
