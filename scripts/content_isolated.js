/**
 * scripts/content_isolated.js
 */
(function () {
  'use strict';

  chrome.storage.local.get(['siteConfigs', 'globalEnabled'], (res) => {
    if (res.globalEnabled === false) return;

    const hostname = window.location.hostname;
    const configs = res.siteConfigs || {};
    
    if (configs[hostname] && configs[hostname].whitelisted) {
      return;
    }

    // 扩充技术文档站点常见的广告类名与万维广告容器
    const commonSelectors = [
      '.adsbygoogle',
      '[id^="google_ads_"]',
      'div[class*="ad-placement"]',
      'div[class*="sponsored-post"]',
      'iframe[src*="doubleclick.net"]',
      'div[data-ad-slot]',
      // 针对文档镜像站、技术社区常见广告容器
      '.wwads-cn',
      '.wwads-vertical',
      '.wwads-horizontal',
      '[class*="wwads"]',
      'div[class*="sponsor-card"]',
      'div[class*="footer-sponsor"]',
      'div[class*="wwads-content"]',
      'aside[class*="ads"]'
    ];

    const styleEl = document.createElement('style');
    styleEl.id = 'shield-cosmetic-styles';
    styleEl.textContent = `
      ${commonSelectors.join(', ')} {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;

    if (document.head) {
      document.head.appendChild(styleEl);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(styleEl);
      }, { once: true });
    }
  });
})();