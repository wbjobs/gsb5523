'use strict';

/*
 * Sync：跨标签页同步与在线状态（presence）管理。
 *
 * 设计要点：
 * - BroadcastChannel 消息只作为"有变化"的提示，真正的状态永远从 IndexedDB 重读，
 *   因此消息乱序、丢失都不会导致状态错误（不丢任务）。
 * - 每个标签页持有 Web Lock `tab-alive-{id}`，页面关闭时浏览器自动释放；
 *   其他标签页通过 locks.query() + 心跳超时双重检测发现死标签页并释放其任务。
 * - 定时兜底全量同步（2s）+ focus/online/visibilitychange 触发同步，
 *   离线期间的认领在恢复后自然合并（IndexedDB 本就是共享事实来源）。
 */
const Sync = (() => {
  const CHANNEL = 'collab-tasks';
  const HEARTBEAT_MS = 1000;
  const SWEEP_MS = 1500;
  const DEAD_AFTER_MS = 4000;   // 心跳超时判定死亡
  const RESYNC_MS = 2000;       // 兜底全量同步
  const GC_GRACE_MS = 10000;    // 对"从未见过的属主"释放前的宽限（避开刷新窗口）

  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks;

  // sessionStorage：刷新页面保持同一标签页身份，任务归属不变
  const tabId = sessionStorage.getItem('collab-tab-id') ||
    (crypto.randomUUID ? crypto.randomUUID() : 'tab-' + Math.random().toString(36).slice(2));
  sessionStorage.setItem('collab-tab-id', tabId);
  const tabName = '标签页-' + tabId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();

  const channel = new BroadcastChannel(CHANNEL);
  const presence = new Map(); // tabId -> { name, lastSeen, deadAt }

  let onRemoteChange = () => {};
  let onPresenceChange = () => {};
  let refreshTimer = null;
  let started = false;

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      onRemoteChange();
    }, 40);
  }

  function broadcast(msg) {
    try { channel.postMessage({ ...msg, sender: tabId }); } catch (_) { /* 页面卸载中 */ }
  }

  function notifyChanged() {
    broadcast({ type: 'changed' });
    scheduleRefresh();
  }

  function notifyDeleted() {
    broadcast({ type: 'deleted' });
    scheduleRefresh();
  }

  function sendHeartbeat() {
    broadcast({ type: 'heartbeat', name: tabName });
  }

  function notePresence(id, name) {
    const isNew = !presence.has(id);
    presence.set(id, { name, lastSeen: Date.now(), deadAt: 0 });
    if (isNew) onPresenceChange();
  }

  channel.onmessage = (e) => {
    const msg = e.data || {};
    if (!msg.sender || msg.sender === tabId) return;
    switch (msg.type) {
      case 'heartbeat':
        notePresence(msg.sender, msg.name);
        break;
      case 'hello':
        notePresence(msg.sender, msg.name);
        sendHeartbeat(); // 回应新标签页，让其尽快看到自己
        break;
      case 'bye': {
        // 页面关闭/刷新都会发 bye：给一段宽限期，刷新的心跳会及时"复活"它
        const p = presence.get(msg.sender);
        if (p) p.deadAt = Date.now() + DEAD_AFTER_MS;
        break;
      }
      case 'changed':
      case 'deleted':
        // 不依赖消息内容/顺序，只当作重读提示
        scheduleRefresh();
        break;
    }
  };

  async function heldTabLocks() {
    if (!hasLocks) return new Set();
    try {
      const snapshot = await navigator.locks.query();
      return new Set((snapshot.held || []).map(l => l.name));
    } catch (_) {
      return new Set();
    }
  }

  async function sweep() {
    const now = Date.now();
    let presenceChanged = false;

    // 1) 心跳超时 / bye 宽限期到期的标签页 -> 释放其任务
    for (const [id, p] of [...presence]) {
      const expired = p.deadAt ? now >= p.deadAt : (now - p.lastSeen > DEAD_AFTER_MS);
      if (expired) {
        presence.delete(id);
        presenceChanged = true;
        const n = await TaskDB.releaseOwner(id);
        if (n > 0) notifyChanged();
      }
    }

    // 2) 任务的属主从未出现在心跳里（如崩溃前认领了任务）：
    //    用 Web Locks 查询确认其存活锁已消失，且任务超过宽限期后才释放。
    if (hasLocks) {
      const tasks = await TaskDB.getAll();
      const held = await heldTabLocks();
      const deadOwners = new Set();
      for (const t of tasks) {
        if (t.status !== 'claimed' || !t.owner) continue;
        if (t.owner === tabId || presence.has(t.owner)) continue;
        if (held.has('tab-alive-' + t.owner)) continue;
        if (now - t.updatedAt < GC_GRACE_MS) continue; // 避开刷新/启动窗口
        deadOwners.add(t.owner);
      }
      for (const owner of deadOwners) {
        const n = await TaskDB.releaseOwner(owner);
        if (n > 0) notifyChanged();
      }
    }

    if (presenceChanged) onPresenceChange();
  }

  function start() {
    if (started) return;
    started = true;

    // 持有本标签页存活锁，直到页面被浏览器销毁时自动释放
    if (hasLocks) {
      navigator.locks.request('tab-alive-' + tabId, () => new Promise(() => {})).catch(() => {});
    }

    sendHeartbeat();
    broadcast({ type: 'hello', name: tabName });

    setInterval(sendHeartbeat, HEARTBEAT_MS);
    setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
    setInterval(scheduleRefresh, RESYNC_MS); // 兜底：消息丢失也能最终一致

    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
    window.addEventListener('focus', scheduleRefresh);
    window.addEventListener('online', scheduleRefresh); // 离线恢复后立即合并
    window.addEventListener('pagehide', () => broadcast({ type: 'bye' }));
  }

  function getPresence() {
    const list = [{ tabId, name: tabName, self: true }];
    for (const [id, p] of presence) {
      list.push({ tabId: id, name: p.name, self: false });
    }
    return list;
  }

  return {
    tabId,
    tabName,
    start,
    notifyChanged,
    notifyDeleted,
    getPresence,
    set onRemoteChange(fn) { onRemoteChange = fn; },
    set onPresenceChange(fn) { onPresenceChange = fn; },
  };
})();
