# 多标签页任务协作板

纯原生 Web 技术（无框架）：BroadcastChannel + IndexedDB + Web Locks API + DOM + Canvas。

## 运行

需要通过 HTTP 访问（BroadcastChannel / Web Locks 在 `file://` 下行为不一致）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开多个标签页访问 http://localhost:8000
```

## 架构

- `js/db.js` — IndexedDB 是所有标签页共享的唯一事实来源；所有"读-改-写"经
  Web Locks 全局互斥锁串行化，`claim` 在锁内用单个事务完成"检查 pending → 置 claimed"。
- `js/sync.js` — BroadcastChannel 心跳 + 在线检测 + 变更通知。消息只作"重读提示"，
  状态永远从 IndexedDB 重读，因此消息乱序/丢失不影响正确性。
- `js/app.js` — UI、过滤/排序、Canvas 状态可视化（环形图 + 各标签页认领条形图）。

## 验收标准对照

| 验收项 | 实现方式 |
| --- | --- |
| 4 个标签页同时认领只有一个成功 | Web Locks 互斥锁 + 单事务原子 claim（页面内有"并发认领测试"按钮可自测） |
| 标签页关闭后任务自动释放 | 每页持有 `tab-alive-{id}` Web Lock，关闭即被浏览器释放；其他页通过心跳超时 + `locks.query()` 双重检测后释放其任务（约 4 秒内） |
| 离线认领恢复后合并正确 | 认领直接写共享 IndexedDB，离线期间不丢；`online`/`focus` 事件 + 2 秒兜底全量同步自动合并 |
| 消息乱序不丢任务 | 消息仅作重读提示，真实状态以 IndexedDB 为准，与消息顺序无关 |
| 任务状态实时同步 | BroadcastChannel 变更通知（40ms 防抖）+ 2s 兜底轮询 |
| 标签页数量动态变化 | hello/heartbeat/bye 协议动态维护在线列表；新页面加入即被发现 |
| 可视化准确 / 刷新后状态一致 | Canvas 每次状态变化重绘；标签页身份存 sessionStorage，刷新后归属不变、状态从 IndexedDB 恢复 |

## 手动验收步骤

1. 开 4 个标签页，创建 1 个任务，4 页同时点"认领" → 只有 1 个成功，其余提示"手慢了"。
2. 认领若干任务后关闭某标签页 → 约 4 秒内其任务自动回到"待认领"。
3. 断网（DevTools → Network → Offline）认领任务，再恢复联网 → 各页面状态自动合并一致。
4. 刷新页面 → 任务状态、认领归属保持不变。
