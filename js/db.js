'use strict';

/*
 * TaskDB：IndexedDB 是所有标签页共享的唯一事实来源（single source of truth）。
 * 所有"读-改-写"操作都通过 Web Locks API 的全局互斥锁串行化，
 * 保证多标签页并发认领时只有一个能成功。
 */
const TaskDB = (() => {
  const DB_NAME = 'collab-tasks-db';
  const STORE = 'tasks';
  const MUTEX = 'collab-tasks-mutex';
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks;

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function reqp(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(mode) {
    const db = await open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  // 全局互斥锁：跨标签页串行化临界区。浏览器不支持 Web Locks 时退化为直接执行
  // （此时依赖单事务内的 get->put 链保证原子性）。
  function withMutex(fn) {
    if (hasLocks) {
      return navigator.locks.request(MUTEX, () => fn());
    }
    return fn();
  }

  async function getAll() {
    return reqp((await store('readonly')).getAll());
  }

  async function get(id) {
    return reqp((await store('readonly')).get(id));
  }

  async function put(task) {
    task.version = (task.version || 0) + 1;
    task.updatedAt = Date.now();
    await reqp((await store('readwrite')).put(task));
    return task;
  }

  async function add(data) {
    const now = Date.now();
    const task = {
      id: (crypto.randomUUID ? crypto.randomUUID() : 't-' + now + '-' + Math.random().toString(36).slice(2)),
      title: data.title,
      desc: data.desc || '',
      status: 'pending', // pending | claimed | done
      owner: null,
      ownerName: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await reqp((await store('readwrite')).put(task));
    return task;
  }

  async function remove(id) {
    await reqp((await store('readwrite')).delete(id));
  }

  /*
   * 原子认领：Web Lock 保证同一时刻全浏览器只有一个标签页进入临界区；
   * 临界区内 get->put 在同一个 IndexedDB 事务中完成（onsuccess 链式，无 await 间隙），
   * 因此"检查 pending -> 置为 claimed"不可被并发打断。
   */
  function claim(id, tabId, tabName) {
    return withMutex(async () => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        const getReq = os.get(id);
        getReq.onsuccess = () => {
          const task = getReq.result;
          if (!task) {
            resolve({ ok: false, reason: '任务不存在（可能已被删除）' });
            return;
          }
          if (task.status !== 'pending') {
            resolve({ ok: false, reason: `手慢了，已被 ${task.ownerName || '其他标签页'} 认领`, task });
            return;
          }
          const updated = {
            ...task,
            status: 'claimed',
            owner: tabId,
            ownerName: tabName,
            version: task.version + 1,
            updatedAt: Date.now(),
          };
          os.put(updated);
          resolve({ ok: true, task: updated });
        };
        getReq.onerror = () => reject(getReq.error);
      });
    });
  }

  // 释放某个标签页认领的全部任务（标签页关闭/崩溃时由其他标签页代为执行）。
  async function releaseOwner(ownerTabId) {
    return withMutex(async () => {
      const all = await getAll();
      const owned = all.filter(t => t.status === 'claimed' && t.owner === ownerTabId);
      for (const t of owned) {
        await put({ ...t, status: 'pending', owner: null, ownerName: null });
      }
      return owned.length;
    });
  }

  return { getAll, get, put, add, remove, claim, releaseOwner, withMutex };
})();
