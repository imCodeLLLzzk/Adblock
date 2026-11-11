/**
 * scripts/content_isolated.js
 * 隔离世界：元素级广告隐藏。规则来源为内置列表 + 用户配置的 cosmetics 段。
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

  const HIDE_STYLE = 'display: none !important; visibility: hidden !important; height: 0 !important; opacity: 0 !important; pointer-events: none !important;';

  // 合并内置选择器与用户配置（全局 + 当前域名专属），并去重
  function mergeSelectors(builtin, configSelectors) {
    const all = [...builtin, ...(Array.isArray(configSelectors) ? configSelectors : [])];
    return Array.from(new Set(all.filter(s => typeof s === 'string' && s.trim())));
  }

  // 注入隐藏样式
  function inject(selectors) {
    if (!selectors.length) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'shield-cosmetic-styles';
    styleEl.textContent = `${selectors.join(', ')} { ${HIDE_STYLE} }`;

    if (document.head) {
      document.head.appendChild(styleEl);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(styleEl);
      }, { once: true });
    }
  }

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

    inject(mergeSelectors(BUILTIN_SELECTORS, [...globalSelectors, ...domainSelectors]));
  });
})();
