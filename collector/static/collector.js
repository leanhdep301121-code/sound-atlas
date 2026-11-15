'use strict';

const themeButton = document.getElementById('collector-theme');
themeButton?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('sound-atlas-theme', theme); } catch { /* In-memory theme remains usable. */ }
});

const syncPanel = document.getElementById('collector-sync');
const syncLabel = document.getElementById('sync-status');
const syncDetail = document.getElementById('sync-detail');
let syncPending = false;
async function updateSyncStatus() {
  if (!syncPanel || syncPending || document.hidden) return;
  syncPending = true;
  try {
    const response = await fetch('/api/sync-status', {cache: 'no-store'});
    if (!response.ok) throw new Error('status unavailable');
    const status = await response.json();
    const labels = {live: '实时同步', syncing: '正在同步', offline: '同步已离线', unconfigured: '尚未连接展示站', error: '同步暂时中断'};
    const state = Object.hasOwn(labels, status.state) ? status.state : 'offline';
    syncPanel.dataset.state = state;
    syncLabel.textContent = labels[state];
    syncDetail.textContent = status.message || (state === 'live' ? '公桌与 D1 工位的数据自动更新到展示站。' : '本地采集与数据管理仍可继续使用。');
    const stamp = status.last_success;
    if (stamp && state === 'live') {
      const date = new Date(typeof stamp === 'number' && stamp < 1e12 ? stamp * 1000 : stamp);
      if (Number.isFinite(+date)) syncDetail.textContent += ' 上次同步 ' + date.toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});
    }
  } catch {
    syncPanel.dataset.state = 'offline';
    syncLabel.textContent = '同步状态暂不可用';
    syncDetail.textContent = '本地采集与数据管理仍可继续使用。';
  } finally { syncPending = false; }
}
updateSyncStatus();
setInterval(updateSyncStatus, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateSyncStatus(); });
