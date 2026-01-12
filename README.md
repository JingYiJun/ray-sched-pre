# presentation

一个纯前端（HTML/CSS/JS）的交互式演示页面，用来动态展示：

- 上方队列持续产出数据（小球），被调度到 Cluster Pool 的 worker
- worker 同时只处理 1 条数据，处理中显示圆形进度环（随机耗时 1~10s）
- 完成后进入 Saver（保存计数 + 小球条带）
- 新增 worker 需要 5s 创建时间；创建完成后即可参与调度
- 删除 worker 会中断其正在处理的任务，并把任务放入 Retry Queue（重试优先）

## 打开方式

直接用浏览器打开 `docs/presentation/index.html` 即可（无需后端）。

