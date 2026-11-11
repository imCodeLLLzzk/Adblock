/**
 * background/service_worker.js
 * 统一管理：规则存储、DNR 拦截规则、内容脚本动态注册、消息路由
 */

const RULE_ID_BASE = 2000;        // 拦截规则 ID 段
const CONTENT_SCRIPT_IDS = ['shield-main-world', 'shield-isolated-world'];
const TOP_DOMAIN_PROBE_ID = 9000;  // 能力探测用的临时规则 ID
const BLOCK_RESOURCE_TYPES = ['script', 'xmlhttprequest', 'sub_frame', 'image', 'media', 'font', 'stylesheet', 'ping'];

const DEFAULT_CONFIG = {
  version: "1.1.0",
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

// 宽松且健壮的格式容错校验器，自动补齐缺失字段并兼容历史命名
function validateSchema(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  // 1. 自动兼容并补齐 networkRules
  if (!Array.isArray(config.networkRules)) {
    config.networkRules = [];
  }
  config.networkRules = config.networkRules.filter(r => typeof r === 'string' && r.trim());

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
  config.cosmetics.global = config.cosmetics.global.filter(s => typeof s === 'string' && s.trim());

  if (!config.cosmetics.domains || typeof config.cosmetics.domains !== 'object') {
    config.cosmetics.domains = {};
  }
  // 清理 domains 内部结构，保证每个值都是选择器数组
  for (const [domain, selectors] of Object.entries(config.cosmetics.domains)) {
    if (!Array.isArray(selectors)) {
      config.cosmetics.domains[domain] = [];
    } else {
      config.cosmetics.domains[domain] = selectors.filter(s => typeof s === 'string' && s.trim());
    }
  }

  if (typeof config.version !== 'string') {
    config.version = DEFAULT_CONFIG.version;
  }

  return true;
}

// 读取当前被白名单放行的域名列表
async function getWhitelistedDomains() {
  const { siteConfigs = {} } = await chrome.storage.local.get(['siteConfigs']);
  return Object.keys(siteConfigs).filter(domain => siteConfigs[domain]?.whitelisted);
}

// 同步底层 declarativeNetRequest 拦截规则
//
// 关键点：DNR 的 urlFilter 匹配的是「请求的目标 URL」，而白名单域名是「发起请求的页面」。
// 两者不是同一个域名，因此不能用 allow 规则去覆盖 —— 必须让拦截规则在白名单页面
// 上直接不生效：
//   excludedTopDomains       匹配顶层页面域名，跨域 iframe 内的广告同样被放行（Chrome 145+）
//   excludedInitiatorDomains 匹配请求发起方域名，兼容 Chrome 101~144
// 两条同时写入，保证在所有 Chrome 版本上都能放行。
async function applyNetworkRules(networkRules, whitelistedDomains) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map(r => r.id);

  const excluded = (whitelistedDomains || []).map(domain => domain.toLowerCase());

  // Chrome 145+ 才认识 excludedTopDomains，写到旧版本上会导致整批规则被拒绝，
  // 因此按版本能力裁剪条件字段
  const supportsTopDomains = supportsExcludedTopDomains();

  const blockRules = (networkRules || []).map((pattern, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: pattern,
      resourceTypes: BLOCK_RESOURCE_TYPES,
      // 白名单放行：
      // excludedTopDomains       匹配顶层页面域名，跨域 iframe 内的广告同样被放行
      // excludedInitiatorDomains 匹配请求发起方域名
      ...(excluded.length ? {
        ...(supportsTopDomains ? { excludedTopDomains: excluded } : {}),
        excludedInitiatorDomains: excluded
      } : {})
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: blockRules
  });
}

// 探测当前 Chrome 是否支持 excludedTopDomains（Chrome 145+）
// 用一条永远不可能被真实请求命中的探针规则提交，失败即视为不支持。
// 探测结果在本次 Service Worker 生命周期内缓存。
let _supportsTopDomains = null;
async function supportsExcludedTopDomains() {
  if (_supportsTopDomains !== null) return _supportsTopDomains;

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [TOP_DOMAIN_PROBE_ID],
      addRules: [{
        id: TOP_DOMAIN_PROBE_ID,
        priority: 1,
        action: { type: "block" },
        condition: {
          // .invalid 是 RFC 2606 保留顶级域，现实中不存在
          urlFilter: "||shield-probe.invalid^",
          excludedTopDomains: ["probe.invalid"]
        }
      }]
    });
    _supportsTopDomains = true;
  } catch (e) {
    _supportsTopDomains = false;
  }

  // 无论成功与否都清理探针规则，避免污染实际规则集
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [TOP_DOMAIN_PROBE_ID]
    });
  } catch (e) { /* 忽略清理失败 */ }

  return _supportsTopDomains;
}

// 动态注册内容脚本：白名单域名直接通过 excludeMatches 排除，
// 主世界脚本与隔离世界脚本同时生效/同时失效，无需等待异步读取
async function applyContentScripts(whitelistedDomains) {
  const excludeMatches = (whitelistedDomains || []).map(domain => `*://*.${domain}/*`);

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const staleIds = existing.map(s => s.id).filter(id => CONTENT_SCRIPT_IDS.includes(id));
  if (staleIds.length) {
    await chrome.scripting.unregisterContentScripts({ ids: staleIds });
  }

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_IDS[0],
      js: ['scripts/main_world_hook.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true
    },
    {
      id: CONTENT_SCRIPT_IDS[1],
      js: ['scripts/content_isolated.js'],
      matches: ['<all_urls>'],
      excludeMatches,
      runAt: 'document_start',
      world: 'ISOLATED',
      persistAcrossSessions: true
    }
  ]);
}

// 全量同步：配置 → 拦截规则 → 内容脚本注册
async function syncAll() {
  const { ruleConfig, siteConfigs = {} } = await chrome.storage.local.get(['ruleConfig', 'siteConfigs']);
  const config = ruleConfig || DEFAULT_CONFIG;
  const whitelistedDomains = Object.keys(siteConfigs).filter(d => siteConfigs[d]?.whitelisted);

  await applyNetworkRules(config.networkRules, whitelistedDomains);
  await applyContentScripts(whitelistedDomains);
}

// 设置单个域名的拦截开关
async function setSiteWhitelist(hostname, whitelisted) {
  if (!hostname) throw new Error('缺少域名');
  const { siteConfigs = {} } = await chrome.storage.local.get(['siteConfigs']);
  siteConfigs[hostname] = { whitelisted: !!whitelisted };
  await chrome.storage.local.set({ siteConfigs });
  await syncAll();
  return { hostname, whitelisted: !!whitelisted };
}

// 远程拉取规则并热更新
async function syncRemoteRules(remoteUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(remoteUrl, { signal: controller.signal, cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const parsed = JSON.parse(await resp.text());
    if (!validateSchema(parsed)) throw new Error('远程配置结构无效');
    await chrome.storage.local.set({ ruleConfig: parsed, remoteSyncUrl: remoteUrl });
    await syncAll();
    return parsed.version || '未知';
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['ruleConfig']);
  if (!current.ruleConfig) {
    await chrome.storage.local.set({ ruleConfig: DEFAULT_CONFIG });
  }
  await syncAll();
});

chrome.runtime.onStartup.addListener(() => {
  syncAll();
});

// 处理 Popup 与 Content 的交互
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 导入本地 JSON 规则
  if (request.action === 'IMPORT_RULE_CONFIG') {
    const config = request.config;

    if (!validateSchema(config)) {
      sendResponse({ success: false, error: 'JSON 内容必须是一个有效的对象' });
      return true;
    }

    chrome.storage.local.set({ ruleConfig: config })
      .then(syncAll)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持异步消息通道
  }

  // 切换单个域名的拦截开关
  if (request.action === 'SET_SITE_WHITELIST') {
    setSiteWhitelist(request.hostname, request.whitelisted)
      .then(data => sendResponse({ success: true, ...data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 远程拉取规则
  if (request.action === 'SYNC_REMOTE_RULES') {
    syncRemoteRules(request.remoteUrl)
      .then(version => sendResponse({ success: true, version }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 内容脚本索取特定站点选择器
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
