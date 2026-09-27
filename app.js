(() => {
  "use strict";

  const DB_NAME = "shared-task-board";
  const DB_VERSION = 1;
  const CHANNEL_NAME = "shared-task-board-v1";
  const WRITE_LOCK = "shared-task-board:write";
  const HEARTBEAT_MS = 1000;
  const RECONCILE_MS = 1000;
  const STALE_SESSION_MS = 3500;

  const TAB_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#d97706",
    "#7c3aed", "#0891b2", "#db2777", "#4d7c0f"
  ];
  const STATUS_TEXT = {
    unclaimed: "待认领",
    claimed: "已认领",
    completed: "已完成"
  };
  const PRIORITY_TEXT = { high: "高", normal: "普通", low: "低" };
  const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  const state = {
    db: null,
    channel: null,
    identity: null,
    label: null,
    color: TAB_COLORS[0],
    online: true,
    processingQueue: false,
    tasks: [],
    sessions: [],
    queue: []
  };

  const els = {};
  const renderScheduled = new Set();

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function formatTime(ms) {
    if (!ms) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(ms));
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
        if (!db.objectStoreNames.contains("events")) {
          const store = db.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
          store.createIndex("kind", "kind");
        }
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("另一个标签页正在更新数据库，请关闭后重试"));
    });
  }

  function transaction(storeNames, mode, callback) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeNames, mode);
      const stores = Object.fromEntries(
        storeNames.map((name) => [name, tx.objectStore(name)])
      );
      let result;

      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("数据库事务已中止"));
      tx.onerror = () => reject(tx.error || new Error("数据库操作失败"));

      Promise.resolve()
        .then(() => callback(stores, tx))
        .then((value) => { result = value; })
        .catch((error) => {
          tx.abort();
          reject(error);
        });
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(storeName) {
    return transaction([storeName], "readonly", async (stores) =>
      requestValue(stores[storeName].getAll())
    );
  }

  function getRecord(storeName, id) {
    return transaction([storeName], "readonly", async (stores) =>
      requestValue(stores[storeName].get(id))
    );
  }

  function withWriteLock(callback) {
    return navigator.locks.request(WRITE_LOCK, async () => callback());
  }

  function addTaskEvent(stores, event) {
    return new Promise((resolve, reject) => {
      const request = stores.events.add({ ...event, kind: "task", at: Date.now() });
      request.onsuccess = () => resolve(Number(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  function addSessionEvent(stores, event) {
    return new Promise((resolve, reject) => {
      const request = stores.events.add({ ...event, kind: "session", at: Date.now() });
      request.onsuccess = () => resolve(Number(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  async function mutateTask(id, mutate, eventType) {
    return withWriteLock(() =>
      transaction(["tasks", "events"], "readwrite", async (stores) => {
        const task = await requestValue(stores.tasks.get(id));
        if (!task || task.deleted) throw new Error("任务不存在");

        const now = Date.now();
        const updated = mutate(task, now);
        if (!updated) return null;

        updated.revision = task.revision + 1;
        updated.updatedAt = now;
        stores.tasks.put(updated);

        const seq = await addTaskEvent(stores, {
          type: eventType,
          taskId: task.id,
          revision: updated.revision,
          actorId: state.identity,
          actorLabel: state.label
        });
        return seq;
      })
    );
  }

  function assertOnline() {
    if (!state.online) throw new Error("当前处于模拟离线状态");
  }

  async function createTask(input) {
    const now = Date.now();
    const task = {
      id: uuid(),
      title: input.title,
      description: input.description || "",
      priority: input.priority,
      status: "unclaimed",
      ownerId: null,
      ownerLabel: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deleted: false
    };

    return withWriteLock(() =>
      transaction(["tasks", "events"], "readwrite", async (stores) => {
        stores.tasks.add(task);
        const seq = await addTaskEvent(stores, {
          type: "create",
          taskId: task.id,
          revision: 1,
          actorId: state.identity,
          actorLabel: state.label
        });
        return seq;
      })
    );
  }

  function claimTask(id) {
    return mutateTask(id, (task) => {
      if (task.status === "claimed" || task.status === "completed") {
        if (task.ownerId === state.identity) return null;
        throw new Error("任务已被其他标签页认领");
      }
      return {
        ...task,
        status: "claimed",
        ownerId: state.identity,
        ownerLabel: state.label
      };
    }, "claim");
  }

  function releaseTask(id) {
    return mutateTask(id, (task) => {
      if (task.status !== "claimed") return null;
      if (task.ownerId !== state.identity) throw new Error("只能释放自己认领的任务");
      return { ...task, status: "unclaimed", ownerId: null, ownerLabel: null };
    }, "release");
  }

  function completeTask(id) {
    return mutateTask(id, (task) => {
      if (task.status === "completed") return null;
      if (task.status !== "claimed" || task.ownerId !== state.identity) {
        throw new Error("只能完成自己认领的任务");
      }
      return { ...task, status: "completed" };
    }, "complete");
  }

  function editTask(id, patch) {
    return mutateTask(id, (task) => ({
      ...task,
      title: patch.title,
      description: patch.description,
      priority: patch.priority
    }), "edit");
  }

  function deleteTask(id) {
    return mutateTask(id, (task) => ({ ...task, deleted: true }), "delete");
  }

  function isLockHeld(query, lockName) {
    return [...(query.held || [])].some((lock) => lock.name === lockName);
  }

  function getStoredIdentity() {
    try {
      return sessionStorage.getItem("task-board-identity");
    } catch {
      return null;
    }
  }

  function storeIdentity(id) {
    try {
      sessionStorage.setItem("task-board-identity", id);
    } catch {
      // Session storage may be unavailable; the session lock still prevents duplicates.
    }
  }

  async function acquireSessionIdentity() {
    const stored = getStoredIdentity();
    const attempt = async (id) =>
      new Promise((resolve) => {
        navigator.locks.request(`shared-task-board:session:${id}`, { mode: "exclusive" }, () =>
          new Promise(() => {})
        ).catch(() => resolve(null));
        setTimeout(() => {
          navigator.locks.query().then((query) => {
            resolve(isLockHeld(query, `shared-task-board:session:${id}`) ? id : null);
          }).catch(() => resolve(null));
        }, 40);
      });

    if (stored) {
      for (let index = 0; index < 8; index += 1) {
        const acquired = await attempt(stored);
        if (acquired) return acquired;
        await wait(250);
      }
    }

    let id = uuid();
    while (!(await attempt(id))) id = uuid();
    storeIdentity(id);
    return id;
  }

  function sessionLockName(id = state.identity) {
    return `shared-task-board:session:${id}`;
  }

  async function registerSession() {
    return withWriteLock(async () => {
      const [sessions, query] = await Promise.all([
        getAll("sessions"),
        navigator.locks.query().catch(() => ({ held: [] }))
      ]);
      const activeSessions = sessions.filter((session) =>
        isLockHeld(query, sessionLockName(session.id)) &&
        (session.id === state.identity || !session.closing)
      );
      const ownSession = sessions.find((session) => session.id === state.identity);
      const usedLabels = new Set(
        activeSessions
          .filter((session) => session.id !== state.identity)
          .map((session) => session.label)
      );
      const label = ownSession?.label || [...Array(TAB_COLORS.length).keys()]
        .map((index) => index + 1)
        .find((candidate) => !usedLabels.has(candidate)) || activeSessions.length + 1;
      const now = Date.now();
      const session = {
        id: state.identity,
        label,
        color: TAB_COLORS[(label - 1) % TAB_COLORS.length],
        startedAt: now,
        heartbeatAt: now,
        closing: false
      };

      await transaction(["sessions"], "readwrite", (stores) => {
        stores.sessions.put(session);
      });
      return session;
    });
  }

  async function writeHeartbeat() {
    const session = await getRecord("sessions", state.identity);
    if (!session) return;
    await transaction(["sessions"], "readwrite", (stores) => {
      stores.sessions.put({ ...session, heartbeatAt: Date.now(), closing: false });
    });
  }

  async function reconcileSessions() {
    const query = await navigator.locks.query().catch(() => ({ held: [] }));
    const heldIds = new Set((query.held || [])
      .map((lock) => lock.name)
      .filter((name) => name.startsWith("shared-task-board:session:"))
      .map((name) => name.split(":").pop()));

    return withWriteLock(() =>
      transaction(["tasks", "sessions", "queue", "events"], "readwrite", async (stores) => {
        const [sessions, tasks, queue] = await Promise.all([
          requestValue(stores.sessions.getAll()),
          requestValue(stores.tasks.getAll()),
          requestValue(stores.queue.getAll())
        ]);
        const now = Date.now();
        const aliveIds = new Set();
        const staleSessions = [];

        sessions.forEach((session) => {
          const hasLock = heldIds.has(session.id);
          if (session.id === state.identity || hasLock) {
            aliveIds.add(session.id);
            return;
          }
          if (session.closing || now - session.heartbeatAt >= STALE_SESSION_MS) {
            staleSessions.push(session);
          }
        });

        if (!staleSessions.length && queue.length === 0) return null;

        let released = 0;
        let taskChanged = false;
        staleSessions.forEach((session) => stores.sessions.delete(session.id));

        const knownOwners = new Set(sessions.map((session) => session.id));
        const staleOwners = new Set(staleSessions.map((session) => session.id));
        const events = [];

        tasks.forEach((task) => {
          const ownerMissing = task.ownerId && !knownOwners.has(task.ownerId);
          if (
            task.status === "claimed" &&
            task.ownerId &&
            (staleOwners.has(task.ownerId) || ownerMissing)
          ) {
            const updated = {
              ...task,
              status: "unclaimed",
              ownerId: null,
              ownerLabel: null,
              revision: task.revision + 1,
              updatedAt: now
            };
            stores.tasks.put(updated);
            released += 1;
            taskChanged = true;
            events.push({
              type: "release",
              taskId: task.id,
              revision: updated.revision,
              actorId: null,
              actorLabel: "自动回收"
            });
          }
        });

        queue.forEach((item) => {
          if (item.sessionId === state.identity) return;
          const active = heldIds.has(item.sessionId);
          const owner = sessions.find((session) => session.id === item.sessionId);
          const refreshing = owner && !owner.closing && now - owner.heartbeatAt < STALE_SESSION_MS;
          if (!active && !refreshing) {
            stores.queue.delete(item.id);
          }
        });

        for (const event of events) {
          await addTaskEvent(stores, event);
        }
        await addSessionEvent(stores, {
          type: staleSessions.length ? "session-reclaimed" : "session-heartbeat",
          released,
          sessionCount: aliveIds.size
        });

        return { staleCount: staleSessions.length, released, taskChanged };
      })
    );
  }

  async function readSnapshot() {
    const [tasks, sessions, queue] = await Promise.all([
      getAll("tasks"),
      getAll("sessions"),
      getAll("queue")
    ]);
    const visibleTasks = tasks.filter((task) => !task.deleted);
    const now = Date.now();
    const visibleSessions = sessions.filter((session) =>
      !session.closing && now - session.heartbeatAt < STALE_SESSION_MS
    );

    return {
      tasks: visibleTasks,
      sessions: visibleSessions,
      queue: queue.filter((item) => item.sessionId === state.identity)
    };
  }

  function scheduleRender(kind = "all", delay = 30) {
    renderScheduled.add(kind);
    clearTimeout(scheduleRender.timer);
    scheduleRender.timer = setTimeout(async () => {
      renderScheduled.clear();
      await refreshSnapshot();
    }, delay);
  }

  async function refreshSnapshot() {
    const snapshot = await readSnapshot();
    state.tasks = snapshot.tasks;
    state.sessions = snapshot.sessions;
    state.queue = snapshot.queue;
    render();
  }

  function postMessage(message) {
    if (!state.channel || !state.online) return;
    state.channel.postMessage({
      ...message,
      senderId: state.identity,
      at: Date.now()
    });
  }

  async function handleChannelMessage(event) {
    const message = event.data;
    if (!message || message.senderId === state.identity || !state.online) return;
    scheduleRender(message.kind === "session" ? "sessions" : "tasks", message.kind === "session" ? 120 : 30);
  }

  async function broadcastTask(seq) {
    postMessage({ kind: "task", seq: typeof seq === "number" ? seq : 0 });
    scheduleRender("tasks", 0);
  }

  async function enqueueClaim(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("任务不存在");
    const duplicate = state.queue.find((item) =>
      item.taskId === taskId && item.status === "pending"
    );
    if (duplicate) throw new Error("该任务已在离线认领队列中");

    const item = {
      id: uuid(),
      taskId,
      taskTitle: task.title,
      sessionId: state.identity,
      sessionLabel: state.label,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      message: "恢复连接后尝试认领"
    };
    await transaction(["queue"], "readwrite", (stores) => stores.queue.put(item));
    scheduleRender("queue", 0);
  }

  async function processQueue() {
    if (!state.online || state.processingQueue) return;
    state.processingQueue = true;
    try {
      const pending = [...state.queue]
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt);

      for (const item of pending) {
        try {
          const seq = await claimTask(item.taskId);
          await transaction(["queue"], "readwrite", (stores) => {
            stores.queue.put({
              ...item,
              status: "done",
              message: "恢复后认领成功",
              updatedAt: Date.now()
            });
          });
          await broadcastTask(seq);
        } catch (error) {
          await transaction(["queue"], "readwrite", (stores) => {
            stores.queue.put({
              ...item,
              status: "conflict",
              message: error.message || "认领失败",
              updatedAt: Date.now()
            });
          });
        }
      }
    } finally {
      state.processingQueue = false;
      scheduleRender("tasks", 0);
    }
  }

  async function removeQueueItem(id) {
    await transaction(["queue"], "readwrite", (stores) => stores.queue.delete(id));
    scheduleRender("queue", 0);
  }

  async function clearFinishedQueue() {
    await transaction(["queue"], "readwrite", (stores) => {
      state.queue
        .filter((item) => item.status !== "pending")
        .forEach((item) => stores.queue.delete(item.id));
    });
    scheduleRender("queue", 0);
  }

  async function setOnline(nextOnline) {
    state.online = nextOnline;
    renderConnection();
    if (state.online) {
      await writeHeartbeat();
      await refreshSnapshot();
      await processQueue();
      postMessage({ kind: "session", reason: "returned" });
    }
  }

  async function runReconcileLoop() {
    while (true) {
      await wait(RECONCILE_MS);
      try {
        const result = await reconcileSessions();
        if (result && (result.staleCount || result.taskChanged)) {
          scheduleRender("all", 0);
          postMessage({ kind: "all", reason: "reconcile" });
        }
      } catch (error) {
        console.warn("reconcile failed", error);
      }
    }
  }

  async function runHeartbeatLoop() {
    while (true) {
      await wait(HEARTBEAT_MS);
      try {
        await writeHeartbeat();
      } catch (error) {
        console.warn("heartbeat failed", error);
      }
    }
  }

  function cacheElements() {
    [
      "loading", "sessionBadge", "connectionPill", "offlineToggle", "canvasSummary",
      "statusCanvas", "createForm", "taskTitle", "taskPriority", "searchInput",
      "statusFilter", "ownerFilter", "sortSelect", "taskList", "tabCount", "tabList",
      "queueList", "editModal", "editForm", "editTaskId", "editTitle",
      "editDescription", "editPriority", "editCancel", "toast"
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function toast(message, type = "info") {
    els.toast.textContent = message;
    els.toast.className = `toast ${type}`;
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  function sessionLabel(id) {
    const session = state.sessions.find((item) => item.id === id);
    return session ? `标签页 ${session.label}` : "未知标签页";
  }

  function sessionColor(id) {
    const session = state.sessions.find((item) => item.id === id);
    return session?.color || "#64748b";
  }

  function getFilteredTasks() {
    const search = els.searchInput.value.trim().toLowerCase();
    const status = els.statusFilter.value;
    const owner = els.ownerFilter.value;

    const tasks = state.tasks.filter((task) => {
      if (status !== "all" && task.status !== status) return false;
      if (owner === "mine" && task.ownerId !== state.identity) return false;
      if (owner === "unclaimed" && task.status !== "unclaimed") return false;
      if (search) {
        const haystack = `${task.title} ${task.description}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const sorters = {
      newest: (a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title, "zh-CN"),
      oldest: (a, b) => a.createdAt - b.createdAt || a.title.localeCompare(b.title, "zh-CN"),
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title, "zh-CN")
    };
    return tasks.sort(sorters[els.sortSelect.value]);
  }

  function canAct(task) {
    const mine = task.ownerId === state.identity;
    return {
      claim: state.online && task.status === "unclaimed",
      offlineClaim: !state.online && task.status === "unclaimed",
      release: state.online && task.status === "claimed" && mine,
      complete: state.online && task.status === "claimed" && mine,
      edit: state.online,
      delete: state.online
    };
  }

  function renderTasks() {
    const tasks = getFilteredTasks();
    if (!tasks.length) {
      els.taskList.innerHTML = '<p class="empty">没有符合条件的任务</p>';
      return;
    }

    els.taskList.innerHTML = tasks.map((task) => {
      const permission = canAct(task);
      const owner = task.status === "unclaimed"
        ? '<span class="badge unclaimed">待认领</span>'
        : `<span class="badge ${task.status}" style="color:${sessionColor(task.ownerId)}"><span class="dot"></span>${escapeHtml(sessionLabel(task.ownerId))} · ${STATUS_TEXT[task.status]}</span>`;
      return `
        <article class="task-card" data-id="${escapeHtml(task.id)}" data-status="${task.status}" data-priority="${task.priority}">
          <div class="task-main">
            <div>
              <h3 class="task-title">${escapeHtml(task.title)}</h3>
              ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ""}
            </div>
          </div>
          <div class="badges">
            ${owner}
            <span class="badge">优先级：${PRIORITY_TEXT[task.priority]}</span>
            <span class="badge">v${task.revision}</span>
          </div>
          <div class="task-meta muted">创建于 ${formatTime(task.createdAt)} · 更新于 ${formatTime(task.updatedAt)}</div>
          <div class="task-actions">
            <button class="btn small primary" data-action="claim" ${permission.claim ? "" : "hidden"}>认领</button>
            <button class="btn small" data-action="offline-claim" ${permission.offlineClaim ? "" : "hidden"}>离线认领</button>
            <button class="btn small success" data-action="complete" ${permission.complete ? "" : "hidden"}>完成</button>
            <button class="btn small secondary" data-action="release" ${permission.release ? "" : "hidden"}>释放</button>
            <button class="btn small secondary" data-action="edit" ${permission.edit ? "" : ""}>编辑</button>
            <button class="btn small danger" data-action="delete" ${permission.delete ? "" : ""}>删除</button>
          </div>
        </article>`;
    }).join("");
  }

  function renderOwnerOptions() {
    const current = els.ownerFilter.value;
    const dynamic = state.sessions
      .slice()
      .sort((a, b) => a.label - b.label)
      .map((session) => {
        const selected = current === session.id ? "selected" : "";
        return `<option value="${escapeHtml(session.id)}" ${selected}>标签页 ${session.label}</option>`;
      })
      .join("");
    els.ownerFilter.innerHTML = `
      <option value="all">全部标签页</option>
      <option value="unclaimed">仅待认领</option>
      <option value="mine">本标签页</option>
      ${dynamic}
    `;
  }

  function renderTabs() {
    els.tabCount.textContent = `${state.sessions.length} 个在线`;
    const sessions = state.sessions.slice().sort((a, b) => a.label - b.label);
    if (!sessions.length) {
      els.tabList.innerHTML = '<p class="empty">暂无在线标签页</p>';
      return;
    }

    els.tabList.innerHTML = sessions.map((session) => {
      const claimed = state.tasks.filter((task) => task.status === "claimed" && task.ownerId === session.id);
      const completed = state.tasks.filter((task) => task.status === "completed" && task.ownerId === session.id);
      const self = session.id === state.identity ? "（当前）" : "";
      const taskRows = claimed.length
        ? claimed.map((task) => `<div class="tab-task"><span>● ${escapeHtml(task.title)}</span><span>认领中</span></div>`).join("")
        : '<div class="muted">暂未认领任务</div>';
      const completedRows = completed.length
        ? completed.map((task) => `<div class="tab-task"><span>✓ ${escapeHtml(task.title)}</span><span>已完成</span></div>`).join("")
        : "";
      return `
        <div class="tab-item">
          <div class="tab-title">
            <span style="color:${session.color}">● 标签页 ${session.label} ${self}</span>
            <span class="muted">${claimed.length} 个认领</span>
          </div>
          ${taskRows}
          ${completedRows}
        </div>`;
    }).join("");
  }

  function renderQueue() {
    const items = state.queue.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (!items.length) {
      els.queueList.innerHTML = '<p class="empty">无离线认领请求</p>';
      return;
    }
    const hasFinished = items.some((item) => item.status !== "pending");
    els.queueList.innerHTML = `
      <div class="task-actions">
        <button class="btn small secondary" data-action="clear-queue" ${hasFinished ? "" : "disabled"}>清除已结束</button>
      </div>
      ${items.map((item) => `
        <div class="queue-item ${item.status}">
          <div class="queue-title">
            <span>${escapeHtml(item.taskTitle)}</span>
            <span class="badge">${item.status === "pending" ? "等待中" : item.status === "done" ? "成功" : "冲突"}</span>
          </div>
          <div class="muted">${escapeHtml(item.message)}</div>
          <div class="task-actions">
            ${item.status === "pending" ? '<span class="muted">恢复连接后自动处理</span>' : ""}
            <button class="btn small secondary" data-action="remove-queue" data-queue-id="${escapeHtml(item.id)}">移除</button>
          </div>
        </div>`).join("")}
    `;
  }

  function renderConnection() {
    const onlineText = state.online ? "实时同步中" : "模拟离线";
    els.connectionPill.textContent = onlineText;
    els.connectionPill.className = `pill ${state.online ? "online" : "offline"}`;
    els.offlineToggle.textContent = state.online ? "模拟离线" : "恢复连接";
    els.sessionBadge.innerHTML = `<span class="dot"></span>标签页 ${state.label}`;
    els.sessionBadge.style.color = state.color;
  }

  function drawCanvas() {
    const canvas = els.statusCanvas;
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(wrap.clientWidth - 2, 760);
    const rowCount = Math.max(...["unclaimed", "claimed", "completed"].map((status) =>
      state.tasks.filter((task) => task.status === status).length
    ), 1);
    const contentHeight = Math.ceil(rowCount / 3) * 76;
    const height = Math.max(250, 78 + contentHeight);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const columns = ["unclaimed", "claimed", "completed"];
    const columnWidth = (width - 28) / 3;
    const counts = Object.fromEntries(columns.map((status) => [status, 0]));
    state.tasks.forEach((task) => { counts[task.status] += 1; });

    ctx.font = "700 15px sans-serif";
    ctx.fillStyle = "#172033";
      columns.forEach((status, index) => {
      const x = 14 + index * columnWidth;
      ctx.fillText(`${STATUS_TEXT[status]}（${counts[status]}）`, x, 28);
      ctx.strokeStyle = "#e2e8f0";
      ctx.strokeRect(x, 42, columnWidth - 12, height - 70);
    });

    state.sessions.slice().sort((a, b) => a.label - b.label).forEach((session, index) => {
      const x = 14 + index * 118;
      ctx.fillStyle = session.color;
      ctx.beginPath();
      ctx.arc(x, height - 22, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#475569";
      ctx.fillText(`标签页 ${session.label}`, x + 9, height - 22);
    });

    columns.forEach((status, columnIndex) => {
      const x = 26 + columnIndex * columnWidth;
      state.tasks
        .filter((task) => task.status === status)
        .forEach((task, index) => {
          const columnIndexLocal = Math.floor(index / 3);
          const rowIndex = index % 3;
          const y = 54 + columnIndexLocal * 76 + rowIndex * 23;
          ctx.fillStyle = status === "claimed"
            ? sessionColor(task.ownerId)
            : status === "completed" ? "#16a34a" : "#64748b";
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x, y, 150, 17);
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#fff";
          ctx.font = "11px sans-serif";
          const title = task.title.length > 12 ? `${task.title.slice(0, 12)}…` : task.title;
          ctx.fillText(title, x + 7, y + 12);
        });
    });

    els.canvasSummary.textContent = `共 ${state.tasks.length} 项，${state.sessions.length} 个标签页在线`;
    canvas.setAttribute("aria-label", `待认领 ${counts.unclaimed}，已认领 ${counts.claimed}，已完成 ${counts.completed}`);
  }

  function render() {
    renderConnection();
    renderOwnerOptions();
    renderTasks();
    renderTabs();
    renderQueue();
    requestAnimationFrame(drawCanvas);
  }

  function openEditModal(task) {
    els.editTaskId.value = task.id;
    els.editTitle.value = task.title;
    els.editDescription.value = task.description || "";
    els.editPriority.value = task.priority;
    els.editModal.hidden = false;
    els.editTitle.focus();
  }

  function closeEditModal() {
    els.editModal.hidden = true;
    els.editForm.reset();
  }

  async function handleTaskAction(action, taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;

    try {
      if (action === "claim") {
        assertOnline();
        const seq = await claimTask(taskId);
        await broadcastTask(seq);
        toast("认领成功", "success");
      } else if (action === "offline-claim") {
        if (state.online) throw new Error("当前在线，可直接认领");
        await enqueueClaim(taskId);
        toast("已加入离线认领队列", "success");
      } else if (action === "complete") {
        const seq = await completeTask(taskId);
        await broadcastTask(seq);
        toast("任务已完成", "success");
      } else if (action === "release") {
        const seq = await releaseTask(taskId);
        await broadcastTask(seq);
        toast("任务已释放", "success");
      } else if (action === "edit") {
        openEditModal(task);
      } else if (action === "delete") {
        if (!window.confirm(`删除任务“${task.title}”？`)) return;
        const seq = await deleteTask(taskId);
        await broadcastTask(seq);
        toast("任务已删除", "success");
      }
    } catch (error) {
      toast(error.message || "操作失败", "error");
      scheduleRender("tasks", 0);
    }
  }

  function bindEvents() {
    els.createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = els.taskTitle.value.trim();
      if (!title) return;
      try {
        assertOnline();
        const seq = await createTask({
          title,
          description: "",
          priority: els.taskPriority.value
        });
        els.taskTitle.value = "";
        await broadcastTask(seq);
        toast("任务已创建", "success");
      } catch (error) {
        toast(error.message || "创建失败", "error");
      }
    });

    els.taskList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const card = button.closest(".task-card");
      handleTaskAction(button.dataset.action, card.dataset.id);
    });

    els.queueList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "remove-queue") removeQueueItem(button.dataset.queueId);
      if (button.dataset.action === "clear-queue") clearFinishedQueue();
    });

    els.editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = els.editTaskId.value;
      try {
        assertOnline();
        const seq = await editTask(id, {
          title: els.editTitle.value.trim(),
          description: els.editDescription.value.trim(),
          priority: els.editPriority.value
        });
        closeEditModal();
        await broadcastTask(seq);
        toast("任务已更新", "success");
      } catch (error) {
        toast(error.message || "保存失败", "error");
      }
    });

    els.editCancel.addEventListener("click", closeEditModal);
    els.editModal.addEventListener("click", (event) => {
      if (event.target === els.editModal) closeEditModal();
    });

    els.offlineToggle.addEventListener("click", () => {
      setOnline(!state.online);
    });

    ["searchInput", "statusFilter", "ownerFilter", "sortSelect"].forEach((id) => {
      els[id].addEventListener("input", () => renderTasks());
      els[id].addEventListener("change", () => renderTasks());
    });

    window.addEventListener("resize", () => {
      clearTimeout(render.resizeTimer);
      render.resizeTimer = setTimeout(drawCanvas, 100);
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) window.location.reload();
    });
  }

  function checkApis() {
    const missing = [];
    if (!("indexedDB" in window)) missing.push("IndexedDB");
    if (!("locks" in navigator)) missing.push("Web Locks API");
    if (!("BroadcastChannel" in window)) missing.push("BroadcastChannel");
    if (missing.length) {
      throw new Error(`当前浏览器缺少所需能力：${missing.join("、")}`);
    }
  }

  async function init() {
    try {
      checkApis();
      cacheElements();
      state.db = await openDatabase();
      state.identity = await acquireSessionIdentity();
      const session = await registerSession();
      state.label = session.label;
      state.color = session.color;

      state.channel = new BroadcastChannel(CHANNEL_NAME);
      state.channel.addEventListener("message", handleChannelMessage);

      await refreshSnapshot();
      await processQueue();
      bindEvents();
      els.loading.hidden = true;

      postMessage({ kind: "session", reason: "joined" });
      runHeartbeatLoop();
      runReconcileLoop();
    } catch (error) {
      cacheElements();
      els.loading.innerHTML = `<div style="padding:24px;text-align:center"><h2>初始化失败</h2><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
