/**
 * background/service_worker.js
 * 统一管理：规则存储、DNR 拦截规则、内容脚本动态注册、消息路由
 */

const RULE_ID_BASE = 2000;         // 拦截规则 ID 段
const CONTENT_SCRIPT_IDS = ['shield-main-world', 'shield-isolated-world'];
const TOP_DOMAIN_PROBE_ID = 9000;  // 能力探测用的临时规则 ID
const BLOCK_RESOURCE_TYPES = [
  'script', 'xmlhttprequest', 'sub_frame', 'image', 'media',
  'font', 'stylesheet', 'ping', 'object'
];

const DEFAULT_CONFIG = {
  version: "1.1.1",
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
  remoteSyncUrl: "",
  antiOverlay: {
    signatures: [],
    selectors: [],
    structural: true
  }
};

// ---------- 通用工具 ----------

function uniqueStrings(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => s.trim()))];
}

// 域名归一化：兼容 "https://*.Example.com:443/path" 这类脏输入。
// DNR 的 excludedInitiatorDomains / excludedTopDomains 不接受通配符，
// 一条非法域名会导致整批规则被拒绝（全盘失效），因此必须严格清洗。
function normalizeDomain(domain) {
  if (typeof domain !== 'string') return '';
  let d = domain.trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.split(':')[0];
  d = d.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(d)) return '';
  if (!d.includes('.')) return '';   // 单段主机名（localhost 等）不做域名级规则
  return d;
}

function normalizeDomains(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(normalizeDomain).filter(Boolean))];
}

// ---------- 配置校验与迁移 ----------

// 宽松且健壮的格式容错校验器，自动补齐缺失字段并兼容历史命名
function validateSchema(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  // 1. networkRules
  if (!Array.isArray(config.networkRules)) {
    config.networkRules = [];
  }
  config.networkRules = uniqueStrings(config.networkRules);

  // 2. 兼容 cosmetics 字段命名差异（兼容 cosmeticRules 或 cosmetics）
  if (!config.cosmetics && config.cosmeticRules) {
    config.cosmetics = config.cosmeticRules;
  }
  if (!config.cosmetics || typeof config.cosmetics !== 'object' || Array.isArray(config.cosmetics)) {
    config.cosmetics = { global: [], domains: {} };
  }
  if (!Array.isArray(config.cosmetics.global)) {
    config.cosmetics.global = [];
  }
  config.cosmetics.global = uniqueStrings(config.cosmetics.global);

  if (!config.cosmetics.domains || typeof config.cosmetics.domains !== 'object'
    || Array.isArray(config.cosmetics.domains)) {
    config.cosmetics.domains = {};
  }
  // 域名键统一归一化，选择器去重
  const domains = {};
  for (const [rawDomain, selectors] of Object.entries(config.cosmetics.domains)) {
    const d = normalizeDomain(rawDomain);
    if (!d) continue;
    const list = uniqueStrings(Array.isArray(selectors) ? selectors : []);
    domains[d] = uniqueStrings([...(domains[d] || []), ...list]);
  }
  config.cosmetics.domains = domains;

  if (typeof config.version !== 'string' || !config.version.trim()) {
    config.version = DEFAULT_CONFIG.version;
  }
  if (typeof config.remoteSyncUrl !== 'string') {
    config.remoteSyncUrl = '';
  }

  // 3. 反检测蒙版配置（signatures 追加特征词，selectors 强制隐藏遮罩）
  if (!config.antiOverlay || typeof config.antiOverlay !== 'object' || Array.isArray(config.antiOverlay)) {
    config.antiOverlay = {};
  }
  if (!Array.isArray(config.antiOverlay.signatures)) {
    config.antiOverlay.signatures = [];
  }
  config.antiOverlay.signatures = uniqueStrings(config.antiOverlay.signatures);
  if (!Array.isArray(config.antiOverlay.selectors)) {
    config.antiOverlay.selectors = [];
  }
  config.antiOverlay.selectors = uniqueStrings(config.antiOverlay.selectors);
  if (typeof config.antiOverlay.structural !== 'boolean') {
    config.antiOverlay.structural = true;
  }

  return true;
}

// ---------- DNR 拦截规则 ----------

// 探测当前 Chrome 是否支持 excludedTopDomains（较新版本才有）。
// 未支持时写入该字段会让整批规则校验失败，必须提前探测。
// 探测结果在本次 Service Worker 生命周期内缓存。
let _topDomainsProbe = null;
function supportsExcludedTopDomains() {
  if (_topDomainsProbe) return _topDomainsProbe;
  _topDomainsProbe = (async () => {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [TOP_DOMAIN_PROBE_ID],
        addRules: [{
          id: TOP_DOMAIN_PROBE_ID,
          priority: 1,
          action: { type: 'block' },
          condition: {
            // .invalid 是 RFC 2606 保留顶级域，现实中不存在，不会误伤真实请求
            urlFilter: '||shield-probe.invalid^',
            excludedTopDomains: ['probe.invalid']
          }
        }]
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      // 无论成功与否都清理探针规则，避免污染实际规则集
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [TOP_DOMAIN_PROBE_ID]
        });
      } catch (e) { /* 忽略清理失败 */ }
    }
  })();
  return _topDomainsProbe;
}

// 下发规则：整批失败时退化为逐条下发，跳过非法规则而不是全军覆没
async function commitRules(removeRuleIds, addRules) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return;
  } catch (err) {
    console.warn('[Shield] 批量下发规则失败，转逐条下发:', err && err.message);
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  for (const rule of addRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
    } catch (err) {
      console.warn('[Shield] 已跳过非法规则', rule.id, err && err.message);
    }
  }
}

// 同步底层 declarativeNetRequest 拦截规则
//
// 关键点：DNR 的 urlFilter 匹配的是「请求的目标 URL」，而白名单域名是「发起请求的页面」。
// 两者不是同一个域名，因此不能用 allow 规则去覆盖 —— 必须让拦截规则在白名单页面
// 上直接不生效：
//   excludedTopDomains       匹配顶层页面域名，跨域 iframe 内的广告同样被放行（较新 Chrome）
//   excludedInitiatorDomains 匹配请求发起方域名，兼容旧版本 Chrome
// 两条同时写入，保证在所有 Chrome 版本上都能放行。
async function applyNetworkRules(networkRules, whitelistedDomains, enabled = true) {
  // 先做能力探测，再读取动态规则列表，避免探针规则残留进待删除集合
  const supportsTopDomains = await supportsExcludedTopDomains();

  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map(r => r.id);
  if (!removeRuleIds.includes(TOP_DOMAIN_PROBE_ID)) {
    removeRuleIds.push(TOP_DOMAIN_PROBE_ID);
  }

  const excluded = normalizeDomains(whitelistedDomains);
  const patterns = enabled ? uniqueStrings(networkRules) : [];

  const blockRules = patterns.map((pattern, index) => {
    const condition = {
      urlFilter: pattern,
      resourceTypes: BLOCK_RESOURCE_TYPES
    };
    if (excluded.length) {
      if (supportsTopDomains) condition.excludedTopDomains = excluded;
      condition.excludedInitiatorDomains = excluded;
    }
    return {
      id: RULE_ID_BASE + index,
      priority: 1,
      action: { type: 'block' },
      condition
    };
  });

  await commitRules(removeRuleIds, blockRules);
}

// ---------- 内容脚本动态注册 ----------

// 生成 excludeMatches：同时覆盖裸域名与子域名
// Chrome 的 match pattern 中 `*.example.com` 只匹配子域，不匹配 example.com 本身，
// 与 DNR 的 excluded*Domains（含子域）语义保持一致。
function buildExcludeMatches(domains) {
  const out = [];
  for (const d of normalizeDomains(domains)) {
    out.push(`*://${d}/*`, `*://*.${d}/*`);
  }
  return [...new Set(out)];
}

async function applyContentScripts(whitelistedDomains, disabled = false) {
  // 全局关闭时排除所有页面，等价于不注入任何脚本
  const excludeMatches = disabled ? ['*://*/*'] : buildExcludeMatches(whitelistedDomains);

  const definitions = [
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
  ];

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map(s => s.id));
  const missing = definitions.filter(d => !existingIds.has(d.id));

  if (missing.length) {
    await chrome.scripting.registerContentScripts(missing);
  }

  // 用 update 原地改写，避免 unregister + register 的异步竞态
  // （旧实现会出现 "Cannot register script with duplicate id"）
  try {
    await chrome.scripting.updateContentScripts(definitions);
  } catch (err) {
    console.warn('[Shield] 更新内容脚本失败，改为重新注册:', err && err.message);
    await chrome.scripting.unregisterContentScripts({ ids: CONTENT_SCRIPT_IDS });
    await chrome.scripting.registerContentScripts(definitions);
  }
}

// ---------- 全量同步 ----------

async function syncAll() {
  const { ruleConfig, siteConfigs = {}, globalEnabled = true } =
    await chrome.storage.local.get(['ruleConfig', 'siteConfigs', 'globalEnabled']);

  const config = ruleConfig && validateSchema(ruleConfig) ? ruleConfig : DEFAULT_CONFIG;
  const whitelistedDomains = normalizeDomains(
    Object.keys(siteConfigs).filter(d => siteConfigs[d]?.whitelisted)
  );
  const enabled = globalEnabled !== false;

  await applyNetworkRules(config.networkRules, whitelistedDomains, enabled);
  await applyContentScripts(whitelistedDomains, !enabled);
}

// 设置单个域名的拦截开关
async function setSiteWhitelist(hostname, whitelisted) {
  const domain = normalizeDomain(hostname);
  if (!domain) throw new Error('域名格式无效');

  const { siteConfigs = {} } = await chrome.storage.local.get(['siteConfigs']);
  if (whitelisted) {
    siteConfigs[domain] = { whitelisted: true };
  } else {
    delete siteConfigs[domain];
  }
  await chrome.storage.local.set({ siteConfigs });
  await syncAll();
  return { hostname: domain, whitelisted: !!whitelisted };
}

// 全局总开关
async function setGlobalEnabled(enabled) {
  await chrome.storage.local.set({ globalEnabled: !!enabled });
  await syncAll();
  return { enabled: !!enabled };
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

// ---------- 生命周期 ----------

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['ruleConfig', 'globalEnabled']);
  const config = current.ruleConfig && validateSchema(current.ruleConfig)
    ? current.ruleConfig
    : DEFAULT_CONFIG;
  await chrome.storage.local.set({
    ruleConfig: config,
    globalEnabled: current.globalEnabled !== false
  });
  await syncAll();
});

chrome.runtime.onStartup.addListener(() => {
  syncAll().catch(err => console.warn('[Shield] 启动同步失败:', err && err.message));
});

// ---------- 消息路由 ----------

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

  // 全局总开关
  if (request.action === 'SET_GLOBAL_ENABLED') {
    setGlobalEnabled(request.enabled)
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
      const hostname = normalizeDomain(request.hostname);
      const cosmetics = ruleConfig?.cosmetics || ruleConfig?.cosmeticRules || {};
      const globalSelectors = cosmetics.global || [];
      const domainSelectors = cosmetics.domains?.[hostname] || [];
      sendResponse({ selectors: uniqueStrings([...globalSelectors, ...domainSelectors]) });
    });
    return true;
  }
});
