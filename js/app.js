'use strict';

(async () => {
  const $ = (s) => document.querySelector(s);
  const selfNameEl = $('#selfName');
  const form = $('#taskForm');
  const formTitle = $('#formTitle');
  const titleInput = $('#title');
  const descInput = $('#desc');
  const submitBtn = $('#submitBtn');
  const cancelEditBtn = $('#cancelEdit');
  const testBtn = $('#concurrencyTest');
  const filterSel = $('#filterStatus');
  const sortSel = $('#sortKey');
  const sortDirBtn = $('#sortDir');
  const listEl = $('#taskList');
  const emptyHint = $('#emptyHint');
  const tabListEl = $('#tabList');
  const canvas = $('#viz');
  const toasts = $('#toasts');

  const STATUS_LABEL = { pending: '待认领', claimed: '已认领', done: '已完成' };
  const STATUS_COLOR = { pending: '#4f8ef7', claimed: '#f5a623', done: '#2fbf71' };
  const STATUS_RANK = { pending: 0, claimed: 1, done: 2 };

  let tasks = [];
  let editingId = null;
  let sortDir = -1; // -1 降序, 1 升序
  let lastSig = '';

  selfNameEl.textContent = Sync.tabName;

  // ---------- 工具 ----------

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  }

  // ---------- 数据 ----------

  async function refresh() {
    tasks = await TaskDB.getAll();
    // 任务未变化时跳过重渲染（兜底轮询不会打断用户操作）
    const sig = tasks.map(t => t.id + ':' + t.version).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      renderList();
      renderTabs();
      drawViz();
    }
  }

  function visibleTasks() {
    const filter = filterSel.value;
    let list = tasks;
    if (filter === 'mine') {
      list = list.filter(t => t.status === 'claimed' && t.owner === Sync.tabId);
    } else if (filter !== 'all') {
      list = list.filter(t => t.status === filter);
    }
    const key = sortSel.value;
    const dir = sortDir;
    return [...list].sort((a, b) => {
      let cmp;
      if (key === 'title') cmp = a.title.localeCompare(b.title, 'zh-CN');
      else if (key === 'status') cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      else cmp = a[key] - b[key];
      return cmp * dir;
    });
  }

  // ---------- 渲染 ----------

  function actionButtons(t) {
    const mine = t.owner === Sync.tabId;
    const btns = [];
    if (t.status === 'pending') {
      btns.push('<button class="small" data-action="claim">认领</button>');
    } else if (t.status === 'claimed' && mine) {
      btns.push('<button class="small success" data-action="complete">完成</button>');
      btns.push('<button class="small warn" data-action="release">释放</button>');
    }
    if (t.status !== 'done') {
      btns.push('<button class="small ghost" data-action="edit">编辑</button>');
    }
    btns.push('<button class="small danger" data-action="delete">删除</button>');
    return btns.join('');
  }

  function renderList() {
    const list = visibleTasks();
    emptyHint.hidden = list.length > 0;
    listEl.innerHTML = list.map(t => {
      const meta = [];
      if (t.status === 'claimed') meta.push('认领者：' + escapeHtml(t.ownerName || '未知'));
      if (t.status === 'done' && t.ownerName) meta.push('由 ' + escapeHtml(t.ownerName) + ' 完成');
      meta.push('更新于 ' + fmtTime(t.updatedAt));
      return `
        <li class="task status-${t.status}" data-id="${t.id}">
          <div class="task-main">
            <div class="task-head">
              <span class="badge">${STATUS_LABEL[t.status]}</span>
              <strong>${escapeHtml(t.title)}</strong>
            </div>
            ${t.desc ? `<div class="desc">${escapeHtml(t.desc)}</div>` : ''}
            <div class="meta">${meta.join(' · ')}</div>
          </div>
          <div class="actions">${actionButtons(t)}</div>
        </li>`;
    }).join('');
  }

  function renderTabs() {
    const presence = Sync.getPresence();
    tabListEl.innerHTML = presence.map(p => {
      const count = tasks.filter(t => t.status === 'claimed' && t.owner === p.tabId).length;
      return `<li>
        <span class="dot"></span>
        <span>${escapeHtml(p.name)}</span>
        ${p.self ? '<span class="me">(我)</span>' : ''}
        <span class="count">${count} 个任务</span>
      </li>`;
    }).join('');
  }

  // ---------- Canvas 可视化 ----------

  function drawViz() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 300;
    const H = 240;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const counts = { pending: 0, claimed: 0, done: 0 };
    for (const t of tasks) counts[t.status]++;
    const total = tasks.length;

    // 左侧：状态环形图
    const cx = 78, cy = 100, r = 58, thick = 22;
    let angle = -Math.PI / 2;
    for (const status of ['pending', 'claimed', 'done']) {
      const frac = total ? counts[status] / total : 0;
      const sweep = frac * Math.PI * 2;
      if (sweep > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, angle, angle + sweep);
        ctx.strokeStyle = STATUS_COLOR[status];
        ctx.lineWidth = thick;
        ctx.stroke();
        angle += sweep;
      }
    }
    if (total === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#2a3550';
      ctx.lineWidth = thick;
      ctx.stroke();
    }
    ctx.fillStyle = '#e6ebf5';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), cx, cy - 8);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8b96ad';
    ctx.fillText('总任务', cx, cy + 12);

    // 图例
    let ly = 190;
    ctx.textAlign = 'left';
    for (const status of ['pending', 'claimed', 'done']) {
      ctx.fillStyle = STATUS_COLOR[status];
      ctx.fillRect(20, ly - 5, 10, 10);
      ctx.fillStyle = '#8b96ad';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${STATUS_LABEL[status]} ${counts[status]}`, 36, ly + 1);
      ly += 18;
    }

    // 右侧：各标签页认领数横向条形图
    const presence = Sync.getPresence();
    const owners = new Map();
    for (const t of tasks) {
      if (t.status === 'claimed' && t.owner) {
        owners.set(t.owner, (owners.get(t.owner) || 0) + 1);
      }
    }
    const rows = presence.map(p => ({
      name: p.name + (p.self ? ' (我)' : ''),
      count: owners.get(p.tabId) || 0,
      self: p.self,
    }));
    const maxCount = Math.max(1, ...rows.map(r => r.count));
    const bx = 170, bw = W - bx - 16;
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8b96ad';
    ctx.fillText('各标签页认领数', bx, 18);
    let by = 34;
    const rowH = Math.min(34, (H - by - 10) / Math.max(1, rows.length));
    for (const row of rows) {
      ctx.fillStyle = '#8b96ad';
      ctx.textAlign = 'left';
      ctx.fillText(row.name, bx, by + 4, bw);
      const barW = (row.count / maxCount) * (bw - 60);
      ctx.fillStyle = row.self ? '#2fbf71' : '#f5a623';
      if (row.count > 0) {
        ctx.fillRect(bx, by + 8, Math.max(3, barW), 12);
      } else {
        ctx.fillStyle = '#2a3550';
        ctx.fillRect(bx, by + 8, 3, 12);
      }
      ctx.fillStyle = '#e6ebf5';
      ctx.fillText(String(row.count), bx + Math.max(3, barW) + 6, by + 14);
      by += rowH;
    }
  }

  // ---------- 操作 ----------

  async function doClaim(id) {
    const r = await TaskDB.claim(id, Sync.tabId, Sync.tabName);
    if (r.ok) {
      toast('认领成功', 'ok');
    } else {
      toast(r.reason, 'warn');
    }
    Sync.notifyChanged();
    await refresh();
  }

  async function doComplete(id) {
    await TaskDB.withMutex(async () => {
      const t = await TaskDB.get(id);
      if (!t) return;
      if (t.owner !== Sync.tabId || t.status !== 'claimed') {
        toast('只能完成自己认领的任务', 'warn');
        return;
      }
      await TaskDB.put({ ...t, status: 'done' });
      toast('任务已完成', 'ok');
    });
    Sync.notifyChanged();
    await refresh();
  }

  async function doRelease(id) {
    await TaskDB.withMutex(async () => {
      const t = await TaskDB.get(id);
      if (!t) return;
      if (t.owner !== Sync.tabId) {
        toast('只能释放自己认领的任务', 'warn');
        return;
      }
      await TaskDB.put({ ...t, status: 'pending', owner: null, ownerName: null });
      toast('已释放，任务回到待认领');
    });
    Sync.notifyChanged();
    await refresh();
  }

  async function doDelete(id) {
    if (!confirm('确定删除该任务？')) return;
    await TaskDB.withMutex(() => TaskDB.remove(id));
    if (editingId === id) resetForm();
    Sync.notifyDeleted();
    await refresh();
  }

  function startEdit(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    editingId = id;
    formTitle.textContent = '编辑任务';
    submitBtn.textContent = '保存修改';
    cancelEditBtn.hidden = false;
    titleInput.value = t.title;
    descInput.value = t.desc;
    titleInput.focus();
  }

  function resetForm() {
    editingId = null;
    formTitle.textContent = '创建任务';
    submitBtn.textContent = '创建任务';
    cancelEditBtn.hidden = true;
    form.reset();
  }

  // ---------- 事件 ----------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const desc = descInput.value.trim();
    if (!title) return;
    if (editingId) {
      const id = editingId;
      await TaskDB.withMutex(async () => {
        const t = await TaskDB.get(id);
        if (!t) return;
        await TaskDB.put({ ...t, title, desc });
      });
      toast('已保存修改', 'ok');
      resetForm();
    } else {
      await TaskDB.add({ title, desc });
      toast('任务已创建', 'ok');
      form.reset();
    }
    Sync.notifyChanged();
    await refresh();
  });

  cancelEditBtn.addEventListener('click', resetForm);

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('li.task').dataset.id;
    const action = btn.dataset.action;
    if (action === 'claim') doClaim(id);
    else if (action === 'complete') doComplete(id);
    else if (action === 'release') doRelease(id);
    else if (action === 'edit') startEdit(id);
    else if (action === 'delete') doDelete(id);
  });

  filterSel.addEventListener('change', renderList);
  sortSel.addEventListener('change', renderList);
  sortDirBtn.addEventListener('click', () => {
    sortDir = -sortDir;
    sortDirBtn.textContent = sortDir === -1 ? '降序 ↓' : '升序 ↑';
    renderList();
  });

  // 并发认领自测：同一时刻发起 8 路认领，验证 Web Locks 下只有一个成功
  testBtn.addEventListener('click', async () => {
    const t = await TaskDB.add({
      title: '并发测试任务 ' + fmtTime(Date.now()),
      desc: '验证同时认领只有一个成功',
    });
    Sync.notifyChanged();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => TaskDB.claim(t.id, Sync.tabId, Sync.tabName))
    );
    const ok = results.filter(r => r.ok).length;
    toast(`8 路并发认领：${ok} 个成功，${results.length - ok} 个被拒绝`, ok === 1 ? 'ok' : 'warn');
    await refresh();
  });

  window.addEventListener('resize', drawViz);

  // ---------- 启动 ----------

  Sync.onRemoteChange = refresh;
  Sync.onPresenceChange = () => { renderTabs(); drawViz(); };
  Sync.start();
  await refresh();
})();
