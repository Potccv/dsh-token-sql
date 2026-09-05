# dsh-token-sql

将 DeepSeek Harness 会话中产生的 token usage 持久化到 SQLite 的 DSH 宿主插件。主对话按 **turn 聚合**，compaction / session-title / web-search 等额外请求按独立记录保存。

## 功能

- 主对话按 `workspace -> session_id -> turn` 聚合，每个 turn 汇总该 turn 内所有 step 的 token usage。
- 同一 step 的 `assistant/chunk` usage 和 `assistant/message` usage 不会重复累计：`assistant/message` 作为该 step 的最终值覆盖早期 chunk 样本。
- 没有 usage 的 step 也会按 `step/end` 计为一次请求，tokens 记为 0。
- 支持启动时回填当前已加载会话的历史 usage。
- 支持全量扫描所有持久化历史会话，并在 Settings > Plugins 中提供“全量扫描所有历史会话”按钮。
- 支持统计 `compaction/summary`、`session-title`、`web-search` 等额外请求。
- 支持通过设置开关“捕获 Web 搜索 tokens”，运行时解析 DeepSeek 搜索响应 usage，不修改 DSH 源码。
- `/api/usage` 默认返回统一的 `records` + `totals`，同时包含主对话和额外请求。

## 安装

### 前置要求

- 已安装 `dsh` CLI；如果从 DeepSeek Harness 源码运行时使用 `pnpm dsh`，把下面命令中的 `dsh` 换成 `pnpm dsh`。
- 目标 profile 需要包含 `webServer`（例如 `web`）。本插件 `inject` 了 `settings`、`webServer`、`sessions`、`sessionPersistence`，仅含 base 的 profile 无法满足加载条件。
- 如果从源码安装，需要先构建出 `lib/`。

### 方式一：从源码 checkout 安装

在 `dsh-token-sql` 项目目录中先构建，再安装到目标 profile：

```bash
cd dsh-token-sql
npm run build
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add file:/path/to/dsh-token-sql
```

- 如果 `dsh` 已在 PATH，也可以直接在项目目录执行 `dsh plugin --profile web add file:.`，效果与绝对路径 `file:` 相同。
- 使用 `file:` 形式安装时，pnpm 会把包内容安装到 profile 的 `node_modules/dsh-token-sql` 目录下（实际路径随 DSH 安装位置/profile 变化），并追加到 `dsh.profile.bundles`。
- 注意：不要用裸路径 `add .` / `add /path/to/dsh-token-sql`，那会变成 `link:` 符号链接，源码文件不会复制到 `node_modules`。
- 由于 `cordis.patch.yml` 声明了 `dsh.bundle`，安装后会自动激活配置层，无需手改 profile 的 `package.json` 或 `cordis.yml`。
- 如果 `dsh` 不在 PATH，在 DeepSeek Harness 仓库根目录执行 `pnpm dsh plugin --profile web add file:/absolute/path/to/dsh-token-sql`。

### 方式二：从 tarball 安装

```bash
cd /path/to/deepseek-harness
# 下载dsh-token-sql.tgz
pnpm dsh plugin --profile web add ./dsh-token-sql-0.1.2-alpha.2.tgz
```

### 验证安装

安装成功后，profile 的 `package.json` 应包含类似内容：

```json
{
  "dependencies": {
    "dsh-token-sql": "file:/path/to/dsh-token-sql"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-token-sql"
      ]
    }
  }
}
```

如果是 tarball 安装，则依赖记录为 `file:/path/to/dsh-token-sql-0.1.2-alpha.2.tgz`。两种方式安装后，插件文件都会出现在 profile 的 `node_modules/dsh-token-sql` 下。

也可以不启动直接检查组合配置：

```bash
dsh --profile web --dump-config
```

输出中应出现 `# == dsh-token-sql` 层以及插件行：

```yaml
- id: dsh-token-sql
  name: dsh-token-sql
  config:
    path: ''
    backfillOnStart: true
    exposeWebApi: true
    captureWebSearchUsage: false
```

确认后重启对应 profile（如 `dsh web`），即可在宿主 Web 服务上访问：

```text
GET /api/usage
```

### 卸载

```bash
dsh plugin --profile web remove dsh-token-sql
```

该命令会同时移除依赖和对应的 bundle 层。

### 注意：只使用官方 `dsh plugin add` 安装

本项目**只支持官方 `dsh plugin add` 安装流程**，不要同时使用 `dsh-super-injector` 的 `dev_install_package` / `dev_inject_plugin` 热装配。

如果之前用 super-injector 注入过本插件，请先执行：

```bash
dev_uninject_plugin dsh-token-sql
```

或在 DSH 的 super-injector 管理界面中卸载，确保 `/root/.dsh/super-injector/registry.json` 中不再有 `dsh-token-sql`，然后再用官方 `dsh plugin add` 安装。否则同一插件会同时存在官方 bundle 和运行时注入两份实例，重启时可能因重复注册导致无法启动。

## 存储位置

默认数据库文件：

```text
~/.dsh/storages/token-usage.sqlite
```

默认路径解析规则：

- 设置了 `DSH_HOME`：使用 `${DSH_HOME}/storages/token-usage.sqlite`
- 未设置 `DSH_HOME` 但设置了 `HOME`：使用 `${HOME}/.dsh/storages/token-usage.sqlite`
- `DSH_HOME` 和 `HOME` 都为空：回退到 `os.homedir()/.dsh/storages/token-usage.sqlite`（与 DSH 自身的 home 解析一致）

可通过配置 `path` 覆盖。数据库使用 WAL 模式，表结构：

```sql
CREATE TABLE turn_token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  session_title TEXT,
  session_created_at INTEGER NOT NULL,
  session_updated_at INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  first_event_time INTEGER NOT NULL,
  last_event_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, session_id, turn)
);
```

额外请求（compaction / session-title / web-search）保存在 `extra_usage` 表：

```sql
CREATE TABLE extra_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  turn INTEGER,
  provider TEXT,
  model TEXT,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 1,
  event_time INTEGER NOT NULL,
  source_seq INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, session_id, kind, source_seq)
);
```

其中：

- `workspace` 来自会话 `cwd` 的目录名，例如 `/root/DSHWorkFile/dsh-token-meter` → `dsh-token-meter`
- `session_id` 是会话唯一 id
- `turn` 是会话内的轮次
- `session_title` 是会话标题（来自 `session/title` 事件，last-wins）
- `session_created_at` 是会话创建时间（来自 `session.header.createdAt`）
- `session_updated_at` 是会话最后活动时间（处理到的最新事件时间）
- `request_count` 是该 turn 内的 step 数量；没有 usage 的 step 也会计为 1 次请求，tokens 为 0
- `reasoning_tokens` 已包含在 `output_tokens` 中，这里单独保存便于查看推理细分
- `extra_usage.kind` 取值：`compaction` / `session-title` / `web-search`
- `extra_usage.source_seq` 用于关联 session 事件 seq，避免全量扫描重复写入

## 配置

```yaml
- id: dsh-token-sql
  name: 'dsh-token-sql'
  config:
    path: ''                    # 空字符串 = 默认 ~/.dsh/storages/token-usage.sqlite
    backfillOnStart: true       # 启动时回填当前已加载会话
    exposeWebApi: true          # 是否在 Harness Web 服务上暴露 /api/usage
    captureWebSearchUsage: false # 是否运行时注入 fetch 拦截，解析 Web 搜索响应 usage
```

也可以在 **设置 → 插件 → Token SQL** 里实时切换：

- “网页 API 映射”开关：`exposeWebApi`
- “捕获 Web 搜索 tokens”开关：`captureWebSearchUsage`

## 全量扫描

- 启动时默认只回填**当前已加载**的 live 会话。
- 通过 Settings > Plugins 中的“全量扫描所有历史会话”按钮，会调用宿主路由：

  ```text
  POST /dsh-token-sql/api/scan
  ```

- 该路由使用 `ctx.sessionPersistence.list()` + `inspect()` 遍历 `~/.dsh/sessions/` 下所有持久化会话，并按 `turn` 聚合写入。
- 当前 59 个会话全量扫描实测约 5 秒。

### 如果数据库里已有数据

全量扫描是 **upsert** 语义：

- 唯一键是 `(workspace, session_id, turn)`
- 已存在的 turn 行会被**更新覆盖**为最新扫描结果
- 不存在的 turn 行会被**插入**
- 不会产生重复行，也不会删除历史行

所以可以放心重复点击“全量扫描”，结果保持幂等。

## 读取 API

宿主 Web 服务（默认 `127.0.0.1:3080`）暴露了一个只读接口：

```text
GET /api/usage
```

默认返回**统一记录 `records` + 汇总 `totals`**，同时包含 `turn_token_usage` 和 `extra_usage` 两张表的数据。

### 默认响应示例

```json
{
  "ok": true,
  "value": {
    "records": [
      {
        "kind": "session",
        "workspace": "dsh-token-meter",
        "sessionId": "session-xxx",
        "turn": 1,
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "uncachedInputTokens": 65,
        "outputTokens": 154,
        "cacheReadTokens": 1664,
        "cacheWriteTokens": 0,
        "reasoningTokens": 61,
        "requestCount": 1,
        "eventTime": 1787397701899,
        "sourceSeq": null,
        "sessionTitle": null,
        "sessionCreatedAt": 1787397701893,
        "sessionUpdatedAt": 1787397701899,
        "firstEventTime": 1787397701899,
        "lastEventTime": 1787397701899
      },
      {
        "kind": "web-search",
        "workspace": "dsh-token-meter",
        "sessionId": "session-xxx",
        "turn": null,
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "uncachedInputTokens": 8434,
        "outputTokens": 801,
        "cacheReadTokens": 640,
        "cacheWriteTokens": 0,
        "reasoningTokens": 0,
        "requestCount": 1,
        "eventTime": 1787774182605,
        "sourceSeq": 63738,
        "sessionTitle": null,
        "sessionCreatedAt": null,
        "sessionUpdatedAt": null,
        "firstEventTime": null,
        "lastEventTime": null
      }
    ],
    "totals": {
      "uncachedInputTokens": 10960511,
      "outputTokens": 5792598,
      "cacheReadTokens": 2877045888,
      "cacheWriteTokens": 0,
      "reasoningTokens": 2740565,
      "requestCount": 11373,
      "recordCount": 1114,
      "turnCount": 437,
      "sessionCount": 83,
      "workspaceCount": 12
    }
  }
}
```

`kind` 取值：

- `session`：主对话 turn 聚合
- `compaction`：压缩摘要请求
- `session-title`：标题生成请求
- `web-search`：DeepSeek 搜索请求

该接口与全量扫描路由共用同一安全栅栏：只接受来自本机（`127.0.0.1` / `localhost`）或 Harness Web 运行时 `trustedHosts` 中声明的可信 Host（`dsh web --trusted-host ...` / 部署派生 LAN 地址），并拒绝 `sec-fetch-site: cross-site` 请求。

### 兼容旧结构

如果你仍然需要旧的 `rows` / `extraRows` 结构，可以加 `legacy=1`：

```text
GET /api/usage?legacy=1&include_extra=1
```

### 统一记录过滤

| 参数 | 说明 |
| --- | --- |
| `kind` | 按记录类型过滤：`session` / `compaction` / `session-title` / `web-search` |
| `workspace` | 按 workspace 过滤 |
| `session_id` / `sessionId` | 按 session 过滤 |
| `provider` | 按 provider 过滤 |
| `model` | 按 model 过滤 |
| `turn` | 按 turn 过滤（主对话） |
| `since` / `until` | 按时间范围过滤 |
| `time_field` / `timeField` | 选择时间字段，默认 `last_event_time` |

示例：

```text
# 只看主对话
GET /api/usage?kind=session

# 只看 web-search
GET /api/usage?kind=web-search

# 只看某个模型
GET /api/usage?model=deepseek-v4-flash

# 过去 7 天
GET /api/usage?since=7d
```

### 服务端分组

支持 `group_by`，让工具直接拿分组汇总：

```text
GET /api/usage?group_by=model
GET /api/usage?group_by=session
GET /api/usage?group_by=day
GET /api/usage?group_by=kind
GET /api/usage?group_by=workspace
```

示例响应：

```json
{
  "ok": true,
  "value": {
    "groups": [
      {
        "key": {
          "provider": "deepseek-official",
          "model": "deepseek-v4-flash"
        },
        "uncachedInputTokens": 1000000,
        "outputTokens": 500000,
        "cacheReadTokens": 8000000,
        "cacheWriteTokens": 0,
        "reasoningTokens": 200000,
        "requestCount": 5000,
        "recordCount": 5000,
        "sessionCount": 30
      }
    ],
    "totals": {
      "...": "..."
    }
  }
}
```

### 分页与输出

| 参数 | 说明 |
| --- | --- |
| `limit` | 返回记录数上限（非负整数） |
| `offset` | 跳过前面的记录数（非负整数） |
| `raw=1` / `raw=true` | 直接返回裸 `records` 数组，不包 `{ ok, value }` |
| `legacy=1` / `legacy=true` | 使用旧结构 `rows` / `extraRows` |

`totals` 会跟随所有过滤条件一起汇总；`limit` / `offset` 只影响返回的记录列表。

## 构建

```bash
npm run build       # 编译 src/ → lib/，并打包 src/client → lib/client.js
npm run typecheck   # 仅类型检查
```

构建脚本会自动探测 DeepSeek Harness checkout；也可显式设置：

```bash
DSH_CHECKOUT=/root/deepseek-harness npm run build
```

## 说明

- 本项目包含 host 端（SQLite 写入/全量扫描路由）和 client 端（Settings > Plugins 按钮）。
- 主对话 usage 来自 `assistant/chunk` / `assistant/message`；额外请求来自 `compaction/summary`、`session-title`、`web-search`。
- `captureWebSearchUsage` 开启时，插件会运行时拦截 DeepSeek 搜索响应并解析 usage；这是 monkey-patch 方案，不修改 DSH 源码。
- 历史 `session-title` 请求没有持久化 usage，无法回补；新产生的标题请求会通过 `llm/stream` 捕获。
- 写入时机：turn 结束时写入该 turn 的汇总行；未结束 turn 也会在 `step/end` / 全量扫描时落库。
