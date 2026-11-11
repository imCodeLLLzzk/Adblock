document.addEventListener('DOMContentLoaded', async () => {
  const currentDomainEl = document.getElementById('currentDomain');
  const statusBadge = document.getElementById('statusBadge');
  const siteToggle = document.getElementById('siteToggle');
  const totalBlockedCount = document.getElementById('totalBlockedCount');
  const totalRulesCount = document.getElementById('totalRulesCount');
  const ruleVersionEl = document.getElementById('ruleVersion');
  const syncUrlInput = document.getElementById('syncUrlInput');
  const syncRemoteBtn = document.getElementById('syncRemoteBtn');
  const importFileBtn = document.getElementById('importFileBtn');
  const exportFileBtn = document.getElementById('exportFileBtn');
  const fileInput = document.getElementById('fileInput');
  const syncMsg = document.getElementById('syncMsg');

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
    const data = await chrome.storage.local.get(['ruleConfig', 'siteConfigs', 'stats']);
    const config = data.ruleConfig || {};
    const configs = data.siteConfigs || {};
    const isWhitelisted = configs[hostname]?.whitelisted || false;

    siteToggle.checked = !isWhitelisted;
    updateStatusBadge(!isWhitelisted);

    if (config.version) ruleVersionEl.textContent = `v${config.version}`;
    if (config.remoteSyncUrl) syncUrlInput.value = config.remoteSyncUrl;

    const netCount = config.networkRules?.length || 0;
    const globalCosmetic = config.cosmeticRules?.global?.length || 0;
    totalRulesCount.textContent = `${netCount + globalCosmetic} 条`;

    if (data.stats?.totalBlocked) {
      totalBlockedCount.textContent = data.stats.totalBlocked.toLocaleString();
    }
  }

  await refreshUI();

  // 3. 切换当前站点过滤状态
  siteToggle.addEventListener('change', async () => {
    const enabled = siteToggle.checked;
    updateStatusBadge(enabled);
    const { siteConfigs = {} } = await chrome.storage.local.get(['siteConfigs']);
    siteConfigs[hostname] = { whitelisted: !enabled };
    await chrome.storage.local.set({ siteConfigs });
    if (tab?.id) chrome.tabs.reload(tab.id);
  });

  // 4. 点击导入唤起隐藏的文件选择框
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

  // 5. 导出当前配置为本地 JSON
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

  // 6. 远程拉取
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