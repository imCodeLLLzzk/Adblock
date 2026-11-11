/**
 * background/service_worker.js
 */

const RULE_ID_BASE = 2000;

const DEFAULT_CONFIG = {
  version: "1.0.0",
  networkRules: [
    "*://*.doubleclick.net/*",
    "*://*.googlesyndication.com/*",
    "*://*.wwads.cn/*",
    "*://*.popads.net/*"
  ],
  cosmetics: {
    global: [
      ".adsbygoogle",
      "[id^=\"google_ads_\"]",
      "[class*=\"wwads\"]",
      ".wwads-cn"
    ],
    domains: {
      "fumadocs.nodejs.cn": [
        "div[class*=\"sponsor\"]",
        "div[class*=\"banner\"]",
        "aside[class*=\"ads\"]"
      ]
    }
  },
  remoteSyncUrl: ""
};

// 基础 Schema 校验器，避免脏数据导致底层引擎崩溃
// 宽松且健壮的格式容错校验器
function validateSchema(config) {
  if (!config || typeof config !== 'object') return false;

  // 1. 自动兼容并补齐 networkRules
  if (!Array.isArray(config.networkRules)) {
    config.networkRules = [];
  }

  // 2. 兼容 cosmetics 字段命名差异（兼容 cosmeticRules 或 cosmetics）
  if (!config.cosmetics && config.cosmeticRules) {
    config.cosmetics = config.cosmeticRules;
  }
  if (!config.cosmetics || typeof config.cosmetics !== 'object') {
    config.cosmetics = { global: [], domains: {} };
  }

  if (!Array.isArray(config.cosmetics.global)) {
    config.cosmetics.global = [];
  }

  if (!config.cosmetics.domains || typeof config.cosmetics.domains !== 'object') {
    config.cosmetics.domains = {};
  }

  return true;
}

// 刷新底层 C++ declarativeNetRequest 规则
async function applyNetworkRules(rulesArray) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map(r => r.id);

  const addRules = (rulesArray || []).map((pattern, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: pattern,
      resourceTypes: ["script", "xmlhttprequest", "sub_frame", "image", "media"]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['ruleConfig']);
  if (!current.ruleConfig) {
    await chrome.storage.local.set({ ruleConfig: DEFAULT_CONFIG });
    await applyNetworkRules(DEFAULT_CONFIG.networkRules);
  } else {
    await applyNetworkRules(current.ruleConfig.networkRules);
  }
});

// 处理 Popup 与 Content 的交互
// 处理来自 Popup 的导入消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'IMPORT_RULE_CONFIG') {
    const config = request.config;
    
    // 执行加固校验与字段清洗
    if (!validateSchema(config)) {
      sendResponse({ success: false, error: 'JSON 内容必须是一个有效的对象' });
      return true;
    }

    chrome.storage.local.set({ ruleConfig: config }).then(async () => {
      await applyNetworkRules(config.networkRules);
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 保持异步消息通道
  }

  // 拦截 Content 脚本索取特定站点选择器的请求
  if (request.action === 'GET_SELECTORS_FOR_DOMAIN') {
    chrome.storage.local.get(['ruleConfig'], ({ ruleConfig }) => {
      const hostname = request.hostname;
      const cosmetics = ruleConfig?.cosmetics || ruleConfig?.cosmeticRules || {};
      const globalSelectors = cosmetics.global || [];
      const domainSelectors = cosmetics.domains?.[hostname] || [];
      sendResponse({ selectors: [...globalSelectors, ...domainSelectors] });
    });
    return true;
  }
});