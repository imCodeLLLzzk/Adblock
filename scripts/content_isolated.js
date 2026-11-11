/**
 * scripts/content_isolated.js
 * 隔离世界：元素级广告隐藏 + 反检测蒙版清除 + 透明点击劫持层清除
 *
 * 设计要点：
 *  1. 隐藏样式走 CSSStyleSheet（构造样式表），不往 DOM 里塞 <style> 标签，
 *     避免页面脚本通过 document.querySelectorAll('style') 察觉到「被注入了脚本」。
 *  2. 对抗「检测到插件 / 请使用隐身模式」这类主动防御，采用三条互不依赖的通道：
 *       a) 文案特征匹配 —— 命中即移除（特征词表可由用户在配置中扩展）
 *       b) 结构特征识别 —— 全屏深色遮罩 + 居中信息框 + 无表单控件 => 视为敌意蒙版
 *       c) 透明点击劫持层 —— 全屏高 z-index 且完全透明 => 移除
 *  3. 全文检索走 TreeWalker 逐个文本节点匹配，避免对每个元素调用 textContent
 *     造成的 O(n²) 开销。
 */
(function () {
  'use strict';

  // 内置通用选择器（始终生效，作为用户配置的兜底补充）
  const BUILTIN_SELECTORS = [
    '.adsbygoogle',
    '[id^="google_ads_"]',
    'div[class*="ad-placement"]',
    'div[class*="sponsored-post"]',
    'iframe[src*="doubleclick.net"]',
    'div[data-ad-slot]',
    '.wwads-cn',
    '.wwads-vertical',
    '.wwads-horizontal',
    '[class*="wwads"]',
    'div[class*="sponsor-card"]',
    'div[class*="footer-sponsor"]',
    'div[class*="wwads-content"]',
    'aside[class*="ads"]'
  ];

  const HIDE_STYLE = 'display:none!important;visibility:hidden!important;height:0!important;opacity:0!important;pointer-events:none!important;';

  // 内置文案特征（用户可在 ruleConfig.antiOverlay.signatures 中追加）
  const DEFAULT_SIGNATURES = [
    '检测到您的浏览器插件',
    '浏览器插件正在注入异常脚本',
    '正在注入异常脚本',
    '请使用隐身模式打开页面',
    '请使用无痕模式打开页面',
    '请关闭广告拦截',
    '检测到广告拦截',
    '广告拦截插件',
    '你的广告拦截器',
    'adblockdetected',
    'adblocker',
    'disableyouradblock',
    'disableadblock',
    'turnoffadblock',
    'incognitomode'
  ];

  function uniqueStrings(list) {
    return [...new Set((Array.isArray(list) ? list : [])
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim()))];
  }

  // 归一化文本：去掉所有空白与大小写差异
  function normalizeText(text) {
    return (text || '').replace(/\s+/g, '').toLowerCase();
  }

  function getStyle(node) {
    try {
      return getComputedStyle(node);
    } catch (e) {
      return null;
    }
  }

  function parseAlpha(color) {
    const m = /rgba?\([^)]*\)/.exec(color || '');
    if (!m) return 0;
    const parts = m[0].replace(/[a-z()]/g, '').split(',');
    if (parts.length < 4) return 1;
    return parseFloat(parts[3]) || 0;
  }

  function isDarkScrim(color) {
    return parseAlpha(color) >= 0.45;
  }

  function coversViewport(rect) {
    return rect.width >= window.innerWidth * 0.85
      && rect.height >= window.innerHeight * 0.85;
  }

  // ---------- 1. 隐藏广告元素 ----------

  function injectHiddenStyles(selectors) {
    if (!selectors.length) return;
    const css = selectors.map(s => `${s}{${HIDE_STYLE}}`).join('\n');

    // 首选构造样式表：不会在 DOM 中留下任何节点
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    } catch (e) {
      // 回退：<style> 兜底
    }

    try {
      const styleEl = document.createElement('style');
      styleEl.textContent = css;
      (document.head || document.documentElement).appendChild(styleEl);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 2. 蒙版移除 ----------

  // 找到遮罩根节点：向上找到层级最高的固定/绝对定位元素，
  // 或覆盖视口的深色遮罩（部分站点不设 z-index，靠 DOM 顺序盖住页面）
  function findOverlayRoot(el) {
    let node = el;
    let best = null;
    while (node && node.nodeType === 1
      && node !== document.body && node !== document.documentElement) {
      const style = getStyle(node);
      if (style) {
        const z = parseInt(style.zIndex || '0', 10) || 0;
        const positioned = style.position === 'fixed' || style.position === 'absolute';
        let scrim = false;
        try {
          scrim = positioned && isDarkScrim(style.backgroundColor)
            && coversViewport(node.getBoundingClientRect());
        } catch (e) { scrim = false; }

        if (positioned && (z >= 9000 || scrim)) {
          best = node;
        }
      }
      node = node.parentElement;
    }
    return best || el;
  }

  function restoreScroll() {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      node.style.removeProperty('overflow');
      node.style.removeProperty('pointer-events');
      const style = getStyle(node);
      if (style && style.overflow === 'hidden') {
        node.style.setProperty('overflow', 'auto', 'important');
      }
    }
  }

  // 收集根节点及其所有 open shadow root
  function collectRoots(root) {
    const roots = [root];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.nodeType !== 1) continue;
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        stack.push(node.shadowRoot);
      }
      const children = node.children;
      for (let i = 0; i < children.length; i++) stack.push(children[i]);
    }
    return roots;
  }

  // 在文本节点中检索特征词（单次遍历，命中即返回）
  function findSignatureTextNode(root, signatures) {
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    } catch (e) {
      return null;
    }
    let node;
    while ((node = walker.nextNode())) {
      const text = normalizeText(node.nodeValue);
      if (!text || text.length > 160) continue;
      for (const sig of signatures) {
        if (text.includes(sig)) return node;
      }
    }
    return null;
  }

  function removeOverlayByTextNode(textNode) {
    const el = textNode.parentElement;
    if (!el) return false;
    const root = findOverlayRoot(el);
    if (root && root.parentNode) {
      root.remove();
      console.debug('[Shield] 已移除反检测蒙版');
    }
    if (el && el.parentNode) el.remove();
    restoreScroll();
    return true;
  }

  // ---------- 3. 结构性识别：全屏深色遮罩 + 居中信息框 ----------

  function findCenteredBox(container) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;

    const stack = [container];
    while (stack.length) {
      const node = stack.pop();
      const children = node.children || [];
      for (const child of children) {
        stack.push(child);
        let rect = null;
        try {
          rect = child.getBoundingClientRect();
        } catch (e) { rect = null; }
        if (!rect) continue;

        const area = (rect.width * rect.height) / (vw * vh);
        if (area < 0.01 || area > 0.6) continue;

        const centerOffset = Math.abs((rect.left + rect.width / 2) - vw / 2);
        if (centerOffset > vw * 0.2) continue;

        if (!best || area < best.area) best = { el: child, area };
      }
    }
    return best ? best.el : null;
  }

  function hasFormControls(el) {
    try {
      if (typeof el.querySelector === 'function') {
        return !!el.querySelector('input,textarea,select,form,iframe');
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 敌意蒙版 = 全屏深色遮罩 + 居中信息框 + 框内没有任何表单/输入控件
  // 登录、注册等正常弹窗含输入控件，会被放行
  function findStructuralOverlay() {
    const roots = collectRoots(document.body);
    for (const root of roots) {
      const children = root.children || [];
      for (const el of children) {
        const style = getStyle(el);
        if (!style) continue;
        if (style.position !== 'fixed' && style.position !== 'absolute') continue;

        let rect = null;
        try {
          rect = el.getBoundingClientRect();
        } catch (e) { rect = null; }
        if (!rect || !coversViewport(rect)) continue;
        if (!isDarkScrim(style.backgroundColor)) continue;

        const box = findCenteredBox(el);
        if (!box) continue;
        if (hasFormControls(box)) continue;

        return el;
      }
    }
    return null;
  }

  // ---------- 4. 透明全屏点击劫持层 ----------

  function isClickHijacker(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getStyle(el);
    if (!style) return false;

    const z = parseInt(style.zIndex || '0', 10) || 0;
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    if (z < 9000) return false;

    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) { return false; }
    if (!coversViewport(rect)) return false;

    // 透明 + 不可见 = 典型的「点击任意处跳转」劫持层
    const opacity = parseFloat(style.opacity);
    if (Number.isNaN(opacity) || opacity > 0.05) return false;

    const bg = (style.backgroundColor || '').replace(/\s+/g, '');
    return bg === '' || bg === 'transparent' || bg === 'rgba(0,0,0,0)';
  }

  // ---------- 5. 扫描入口 ----------

  function scanAndClean(signatures, structuralEnabled) {
    let removed = false;

    // 5.1 文案特征
    for (const root of collectRoots(document.body)) {
      const textNode = findSignatureTextNode(root, signatures);
      if (!textNode) continue;
      removed = removeOverlayByTextNode(textNode) || removed;
      break;   // 一次只处理一处，避免过度删除
    }

    // 5.2 结构性识别（不依赖文案）
    if (!removed && structuralEnabled) {
      const scrim = findStructuralOverlay();
      if (scrim) {
        scrim.remove();
        restoreScroll();
        console.debug('[Shield] 已移除敌意蒙版');
        removed = true;
      }
    }

    return removed;
  }

  function handleAddedNode(node, signatures, structuralEnabled) {
    if (!node || node.nodeType !== 1) return;

    // 5.3 透明点击劫持层
    try {
      if (isClickHijacker(node)) {
        node.remove();
        console.debug('[Shield] 已移除透明点击劫持层');
      }
    } catch (e) { /* 忽略 */ }

    // 5.4 反检测蒙版
    try {
      scanAndClean(signatures, structuralEnabled);
    } catch (e) { /* 忽略 */ }
  }

  function startObserver(signatures, structuralEnabled) {
    if (!window.MutationObserver) return;
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          handleAddedNode(added, signatures, structuralEnabled);
        }
      }
    });
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }

    // 站点可能在若干延迟后才弹窗，做几轮兜底扫描
    let attempts = 0;
    const timer = setInterval(() => {
      try {
        scanAndClean(signatures, structuralEnabled);
      } catch (e) { /* 忽略 */ }
      attempts++;
      if (attempts >= 6) clearInterval(timer);
    }, 700);
  }

  // ---------- 启动 ----------

  chrome.storage.local.get(['ruleConfig', 'siteConfigs', 'globalEnabled'], (res) => {
    if (res.globalEnabled === false) return;

    const hostname = window.location.hostname;
    const configs = res.siteConfigs || {};

    // 域名级白名单：关闭该域名的全部拦截
    if (configs[hostname] && configs[hostname].whitelisted) {
      return;
    }

    const config = res.ruleConfig || {};
    const cosmetics = config.cosmetics || config.cosmeticRules || {};
    const globalSelectors = cosmetics.global || [];
    const domainSelectors = cosmetics.domains?.[hostname] || [];

    // 反检测蒙版配置：signatures 追加特征词，selectors 强制隐藏指定遮罩
    const anti = config.antiOverlay || {};
    const signatures = uniqueStrings([
      ...DEFAULT_SIGNATURES,
      ...(Array.isArray(anti.signatures) ? anti.signatures : [])
    ]).map(normalizeText);
    const antiSelectors = Array.isArray(anti.selectors) ? anti.selectors : [];
    const structuralEnabled = anti.structural !== false;

    injectHiddenStyles(uniqueStrings([
      ...BUILTIN_SELECTORS,
      ...globalSelectors,
      ...domainSelectors,
      ...antiSelectors
    ]));

    // 蒙版清除始终开启：即使元素拦截被关掉，也不该让页面被遮罩挡住
    startObserver(signatures, structuralEnabled);
  });
})();
