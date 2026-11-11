document.addEventListener('DOMContentLoaded', async () => {
  const currentDomainEl = document.getElementById('currentDomain');
  const statusBadge = document.getElementById('statusBadge');
  const siteToggle = document.getElementById('siteToggle');
  const globalToggle = document.getElementById('globalToggle');
  const totalBlockedCount = document.getElementById('totalBlockedCount');
  const totalRulesCount = document.getElementById('totalRulesCount');
  const ruleVersionEl = document.getElementById('ruleVersion');
  const syncUrlInput = document.getElementById('syncUrlInput');
  const syncRemoteBtn = document.getElementById('syncRemoteBtn');
  const importFileBtn = document.getElementById('importFileBtn');
  const exportFileBtn = document.getElementById('exportFileBtn');
  const fileInput = document.getElementById('fileInput');
  const syncMsg = document.getElementById('syncMsg');
  const whitelistList = document.getElementById('whitelistList');

  // 1. 获取当前活跃标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = '';
  if (tab?.url?.startsWith('http')) {
    hostname = new URL(tab.url).hostname;
    currentDomainEl.textContent = hostname;
  } else {
    currentDomainEl.textContent = '系统页面 / 内置页';
    siteToggle.disabled = true;
  }

  // 2. 加载数据并渲染统计
  async function refreshUI() {
    const data = await chrome.storage.local.get(['ruleConfig', 'siteConfigs', 'stats', 'globalEnabled']);
    const config = data.ruleConfig || {};
    const configs = data.siteConfigs || {};
    const isWhitelisted = configs[hostname]?.whitelisted || false;
    const globalOn = data.globalEnabled !== false;

    if (globalToggle) globalToggle.checked = globalOn;
    siteToggle.checked = !isWhitelisted && globalOn;
    updateStatusBadge(!isWhitelisted && globalOn);

    if (config.version) ruleVersionEl.textContent = `v${config.version}`;
    if (config.remoteSyncUrl) syncUrlInput.value = config.remoteSyncUrl;

    // 规则总数 = 网络拦截规则 + 全局元素规则 + 站点专属元素规则
    const netCount = config.networkRules?.length || 0;
    const cosmetics = config.cosmetics || config.cosmeticRules || {};
    const globalCosmetic = cosmetics.global?.length || 0;
    const domainCosmetic = Object.values(cosmetics.domains || {})
      .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    totalRulesCount.textContent = `${netCount + globalCosmetic + domainCosmetic} 条`;

    if (data.stats?.totalBlocked) {
      totalBlockedCount.textContent = data.stats.totalBlocked.toLocaleString();
    }

    renderWhitelist(configs);
  }

  // 3. 渲染已关闭拦截的域名列表
  function renderWhitelist(configs) {
    if (!whitelistList) return;
    const domains = Object.keys(configs).filter(d => configs[d]?.whitelisted);

    whitelistList.innerHTML = '';
    if (!domains.length) {
      const empty = document.createElement('div');
      empty.className = 'whitelist-empty';
      empty.textContent = '暂无已关闭的域名';
      whitelistList.appendChild(empty);
      return;
    }

    domains.forEach(domain => {
      const row = document.createElement('div');
      row.className = 'whitelist-item';

      const name = document.createElement('span');
      name.className = 'whitelist-domain';
      name.textContent = domain;

      const restore = document.createElement('button');
      restore.className = 'whitelist-restore';
      restore.textContent = '恢复';
      restore.addEventListener('click', async () => {
        await sendToggle(domain, false);
        refreshUI();
      });

      row.appendChild(name);
      row.appendChild(restore);
      whitelistList.appendChild(row);
    });
  }

  // 4. 向后台发送域名开关指令
  function sendToggle(domain, whitelisted) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        action: 'SET_SITE_WHITELIST',
        hostname: domain,
        whitelisted
      }, (res) => {
        if (chrome.runtime.lastError) {
          showMsg(`操作失败: ${chrome.runtime.lastError.message}`, 'error');
          resolve(false);
          return;
        }
        if (!res?.success) {
          showMsg(`操作失败: ${res?.error || '未知错误'}`, 'error');
          resolve(false);
          return;
        }
        showMsg(whitelisted ? `已对 ${domain} 关闭拦截` : `已对 ${domain} 恢复拦截`, 'success');
        resolve(true);
      });
    });
  }

  // 向后台发送全局开关指令
  function sendGlobalToggle(enabled) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'SET_GLOBAL_ENABLED', enabled }, (res) => {
        if (chrome.runtime.lastError) {
          showMsg(`操作失败: ${chrome.runtime.lastError.message}`, 'error');
          resolve(false);
          return;
        }
        if (!res?.success) {
          showMsg(`操作失败: ${res?.error || '未知错误'}`, 'error');
          resolve(false);
          return;
        }
        showMsg(enabled ? '已开启全局拦截' : '已暂停全局拦截', 'success');
        resolve(true);
      });
    });
  }

  await refreshUI();

  // 5. 切换全局拦截总开关
  globalToggle?.addEventListener('change', async () => {
    const enabled = globalToggle.checked;
    const ok = await sendGlobalToggle(enabled);
    if (!ok) {
      if (globalToggle) globalToggle.checked = !enabled;
      return;
    }
    await refreshUI();
    if (tab?.id) chrome.tabs.reload(tab.id);
  });

  // 6. 切换当前站点过滤状态
  siteToggle.addEventListener('change', async () => {
    if (!hostname) return;
    const enabled = siteToggle.checked;
    updateStatusBadge(enabled);

    const ok = await sendToggle(hostname, !enabled);
    if (!ok) {
      siteToggle.checked = !enabled;
      updateStatusBadge(!enabled);
      return;
    }
    // 内容脚本按域名动态注册，需重载当前页生效
    if (tab?.id) chrome.tabs.reload(tab.id);
  });

  // 7. 点击导入唤起隐藏的文件选择框
  importFileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        // 发送给 Background 验证并生效
        chrome.runtime.sendMessage({ action: 'IMPORT_RULE_CONFIG', config: parsed }, (res) => {
          if (res?.success) {
            showMsg('导入成功，规则已热更新！', 'success');
            refreshUI();
            if (tab?.id) chrome.tabs.reload(tab.id);
          } else {
            showMsg(`导入失败: ${res?.error || '格式错误'}`, 'error');
          }
        });
      } catch (err) {
        showMsg('JSON 格式无效，解析失败', 'error');
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });

  // 8. 导出当前配置为本地 JSON
  exportFileBtn.addEventListener('click', async () => {
    const { ruleConfig } = await chrome.storage.local.get(['ruleConfig']);
    const blob = new Blob([JSON.stringify(ruleConfig, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shield-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showMsg('规则已导出到本地下载目录', 'success');
  });

  // 9. 远程拉取
  syncRemoteBtn.addEventListener('click', () => {
    const remoteUrl = syncUrlInput.value.trim();
    if (!remoteUrl) {
      showMsg('请先填写有效的 HTTP/HTTPS 地址', 'error');
      return;
    }
    showMsg('正在同步远程规则...', '');
    chrome.runtime.sendMessage({ action: 'SYNC_REMOTE_RULES', remoteUrl }, (res) => {
      if (res?.success) {
        showMsg(`同步成功！更新至 v${res.version}`, 'success');
        refreshUI();
        if (tab?.id) chrome.tabs.reload(tab.id);
      } else {
        showMsg(`拉取失败: ${res?.error}`, 'error');
      }
    });
  });

  function updateStatusBadge(isActive) {
    statusBadge.textContent = isActive ? 'Active' : 'Paused';
    statusBadge.style.color = isActive ? 'var(--success-color)' : 'var(--text-secondary)';
  }

  function showMsg(text, type) {
    syncMsg.textContent = text;
    syncMsg.className = `sync-msg ${type}`;
    setTimeout(() => {
      syncMsg.textContent = '';
      syncMsg.className = 'sync-msg';
    }, 4000);
  }
});
