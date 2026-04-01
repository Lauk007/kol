# KOL Signal Monitor

一个零依赖的 Node.js 监控平台，用来定时请求 `signals/list` 接口、记录抓取结果、展示监控面板，并把异常或新增变化推送到飞书。

https://open.feishu.cn/open-apis/bot/v2/hook/36f964f0-0042-414f-bc9f-5aef7b85c369

## 功能

- 每小时自动请求一次目标接口，也支持页面上手动触发。
- 使用 SQLite 持久化抓取历史、信号快照和飞书推送日志。
- 自动识别新增信号和内容变更。
- 失败时记录错误，并可推送到飞书。
- 自带网页看板，查看最近状态、变化条目、推送日志。

## 启动

1. 复制配置文件：

```powershell
Copy-Item config.example.json config.json
```

2. 按需编辑 `config.json`：

- `signalApiUrl`: 目标接口地址
- `pollIntervalMinutes`: 拉取间隔，默认 `60`
- `pushMode`: `changes_only`、`all_success`、`errors_only`
- `feishu.enabled`: 是否启用飞书推送
- `feishu.webhookUrl`: 飞书机器人 webhook
- `feishu.secret`: 如果机器人开启了签名校验，就填 secret

3. 启动服务：

```powershell
npm start
```

4. 打开面板：

[http://localhost:3000](http://localhost:3000)

## 数据目录

- SQLite 数据库：`data/monitor.db`

## 说明

- 代码会尽量兼容不同接口返回格式，会自动从返回 JSON 里识别数组列表。
- 单条信号会优先用 `id/signalId/postId/url/title` 等字段生成唯一键；如果没有，就用对象内容生成哈希。
- 飞书默认发送文本消息，包含抓取时间、状态、变化数量和前几条变化摘要。
