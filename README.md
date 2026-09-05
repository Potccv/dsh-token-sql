# dsh-token-sql

将 DeepSeek Harness 会话中产生的 token usage 持久化到 SQLite 的 DSH 宿主插件。主对话、compaction、session-title 和 web-search 统一保存在一张请求级表中。

## 功能

- 主对话每个 `session_id + turn + step` 保存一条请求，模型切换不会混入同一条数据。
- 没有 usage 的 step 仍保存请求记录，状态记为 `missing`，tokens 使用 `NULL` 表示未知。
- 支持启动时回填当前已加载会话的历史 usage。
- 支持全量扫描所有持久化历史会话，并在 Settings > Plugins 中提供“全量扫描所有历史会话”按钮。
- 支持统计 `compaction/summary`、`session-title`、`web-search` 等额外请求。
- 支持通过设置开关“捕获 Web 搜索 tokens”，运行时解析 DeepSeek 搜索响应 usage，不修改 DSH 源码。
- `/api/usage` 返回统一的请求级 `records` + `totals`。

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
pnpm dsh plugin --profile web add ./dsh-token-sql-0.1.3-alpha.1.tgz
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

如果是 tarball 安装，则依赖记录为 `file:/path/to/dsh-token-sql-0.1.3-alpha.1.tgz`。两种方式安装后，插件文件都会出现在 profile 的 `node_modules/dsh-token-sql` 下。

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

或在 DSH 的 super-injector 管理界面中卸载，确保 `~/.dsh/super-injector/registry.json` 中不再有 `dsh-token-sql`，然后再用官方 `dsh plugin add` 安装。否则同一插件会同时存在官方 bundle 和运行时注入两份实例，重启时可能因重复注册导致无法启动。

## 存储位置

默认数据库文件：

```text
~/.dsh/storages/token-usage.sqlite
```

默认路径解析规则：

- 设置了 `DSH_HOME`：使用 `${DSH_HOME}/storages/token-usage.sqlite`
- 未设置 `DSH_HOME` 但设置了 `HOME`：使用 `${HOME}/.dsh/storages/token-usage.sqlite`
- `DSH_HOME` 和 `HOME` 都为空：回退到 `os.homedir()/.dsh/storages/token-usage.sqlite`（与 DSH 自身的 home 解析一致）

可通过配置 `path` 覆盖。数据库使用 WAL 模式，仅包含一张用户表 `token_usage`。字段按主键、会话、请求、模型、Token、时间的顺序排列：

| 字段 | 含义 |
| --- | --- |
| `id` | 自增整数主键；表示记录写入数据库的先后顺序 |
| `workspace` | 会话 `cwd` 的目录名 |
| `session_id` | DSH 会话 ID |
| `session_title` | 会话最新标题 |
| `kind` | `session` / `compaction` / `session-title` / `web-search` |
| `turn` | 主对话轮次；额外请求为 `NULL` |
| `step` | turn 内模型请求序号；额外请求为 `NULL` |
| `source_seq` | 对应的 DSH session 事件序号 |
| `provider` | 模型供应商 |
| `model` | 模型名称 |
| `usage_status` | `pending` / `captured` / `missing` / `failed` |
| `uncached_input_tokens` | 未缓存输入 Token |
| `cache_read_tokens` | 缓存读取 Token |
| `cache_write_tokens` | 缓存写入 Token |
| `output_tokens` | 输出 Token |
| `reasoning_tokens` | 输出中的推理 Token |
| `session_created_at` | 会话创建时间 |
| `session_updated_at` | 会话最后活动时间 |
| `event_time` | 请求对应的 DSH 事件时间 |
| `usage_captured_at` | 实际取得 usage 的时间 |
| `created_at` | 记录首次写入时间 |
| `updated_at` | 记录最后更新时间 |

Token 和时间均使用整数，时间单位为 Unix 毫秒。`usage_status = captured` 时 Token 字段保存实际值，包括真实的 0；其他状态使用 `NULL` 表示未知。`reasoning_tokens` 已包含在 `output_tokens` 中。

`id` 是自增主键。记录默认按业务时间 `event_time` 升序读取，同一毫秒内再按 `id` 升序排列；`created_at` 表示实际入库时间。表不保存 `record_key` 和 `request_count`。主对话通过 `(session_id, turn, step)` 保证业务唯一；compaction 和 web-search 通过 `(session_id, kind, source_seq)` 保证业务唯一。workspace 不参与唯一判断。session-title 没有可重放事件序号，每次实时生成直接插入独立记录。

旧版数据库会自动升级到 schema v3。已有统一表数据先按 `event_time` 重排并生成自增 `id`；更早的 `turn_token_usage` 和 `extra_usage` 数据会先迁移额外请求，再自动全量扫描 DSH 历史会话重建请求级主对话数据。扫描成功后删除旧表并把 `PRAGMA user_version` 更新为 3。若 DSH 格式转换器拒绝结构不完整的 v0 会话，插件只读取其中稳定的请求和 usage 字段完成 Token 统计，不修改原会话文件。

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

- 该路由使用 `ctx.sessionPersistence.list()` + `open()` / `read()` / `close()` 遍历 `~/.dsh/sessions/` 下所有持久化会话，并按请求写入。
- 当前 59 个会话全量扫描实测约 5 秒。

### 如果数据库里已有数据

全量扫描是 **upsert** 语义：

- 主对话唯一键是 `(session_id, turn, step)`
- compaction 和 web-search 唯一键是 `(session_id, kind, source_seq)`
- 已存在的请求会更新，尚未写入的请求会插入
- 不会产生重复行，也不会删除历史行

所以可以放心重复点击“全量扫描”，结果保持幂等。

## 读取 API

宿主 Web 服务（默认 `127.0.0.1:3080`）暴露了一个只读接口：

```text
GET /api/usage
```

默认返回统一表中的请求级 `records` 和汇总 `totals`。

数据源结构描述接口：

```text
GET /api/usage/schema
```

该接口返回 schema 版本、表名、22 个字段的数据库名称与 JSON 名称、SQLite 类型、是否允许 `NULL`、字段说明、主键、业务唯一键、枚举值、时间单位以及默认排序规则。结构描述与数据接口受同一个“网页 API 映射”开关和安全栅栏控制。

### 默认响应示例

```json
{
  "ok": true,
  "value": {
    "records": [
      {
        "id": 1,
        "workspace": "dsh-token-meter",
        "sessionId": "session-xxx",
        "sessionTitle": "分析项目构建失败",
        "kind": "session",
        "turn": 1,
        "step": 2,
        "sourceSeq": 15,
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "usageStatus": "captured",
        "uncachedInputTokens": 65,
        "cacheReadTokens": 1664,
        "cacheWriteTokens": 0,
        "outputTokens": 154,
        "reasoningTokens": 61,
        "sessionCreatedAt": 1787397701893,
        "sessionUpdatedAt": 1787397800000,
        "eventTime": 1787397701899,
        "usageCapturedAt": 1787397701899,
        "createdAt": 1787397701905,
        "updatedAt": 1787397701905
      },
      {
        "id": 2,
        "workspace": "dsh-token-meter",
        "sessionId": "session-xxx",
        "sessionTitle": "分析项目构建失败",
        "kind": "web-search",
        "turn": null,
        "step": null,
        "sourceSeq": 63,
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "usageStatus": "missing",
        "uncachedInputTokens": null,
        "cacheReadTokens": null,
        "cacheWriteTokens": null,
        "outputTokens": null,
        "reasoningTokens": null,
        "sessionCreatedAt": 1787397701893,
        "sessionUpdatedAt": 1787397800000,
        "eventTime": 1787774182605,
        "usageCapturedAt": null,
        "createdAt": 1787774182610,
        "updatedAt": 1787774182610
      }
    ],
    "totals": {
      "uncachedInputTokens": 10960511,
      "cacheReadTokens": 2877045888,
      "cacheWriteTokens": 0,
      "outputTokens": 5792598,
      "reasoningTokens": 2740565,
      "requestCount": 11373,
      "turnCount": 437,
      "sessionCount": 83,
      "workspaceCount": 12
    }
  }
}
```

`kind` 取值：

- `session`：主对话中的一次模型请求
- `compaction`：压缩摘要请求
- `session-title`：标题生成请求
- `web-search`：DeepSeek 搜索请求

该接口与全量扫描路由共用同一安全栅栏：只接受来自本机（`127.0.0.1` / `localhost`）或 Harness Web 运行时 `trustedHosts` 中声明的可信 Host（`dsh web --trusted-host ...` / 部署派生 LAN 地址），并拒绝 `sec-fetch-site: cross-site` 请求。

### 统一记录过滤

| 参数 | 说明 |
| --- | --- |
| `id` | 按自增主键过滤；也支持 `id_min` / `id_max` 范围 |
| `kind` | 按记录类型过滤：`session` / `compaction` / `session-title` / `web-search` |
| `workspace` | 按 workspace 过滤 |
| `session_id` / `sessionId` | 按 session 过滤 |
| `provider` | 按 provider 过滤 |
| `model` | 按 model 过滤 |
| `usage_status` / `usageStatus` | 按 usage 状态过滤 |
| `turn` | 按 turn 过滤（主对话） |
| `step` | 按 step 过滤（主对话） |
| `source_seq` / `sourceSeq` | 按 DSH 事件序号过滤 |
| `since` / `until` | 按时间范围过滤 |
| `time_field` / `timeField` | 选择时间字段，默认 `event_time` |

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
        "cacheReadTokens": 8000000,
        "cacheWriteTokens": 0,
        "outputTokens": 500000,
        "reasoningTokens": 200000,
        "requestCount": 5000,
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

`totals` 会跟随所有过滤条件一起汇总；`limit` / `offset` 只影响返回的记录列表。

## 构建

```bash
npm run build       # 编译 src/ → lib/，并打包 src/client → lib/client.js
npm run typecheck   # 仅类型检查
```

构建脚本会自动探测 DeepSeek Harness checkout；也可显式设置：

```bash
DSH_CHECKOUT=/path/to/deepseek-harness npm run build
```

## 说明

- 本项目包含 host 端（SQLite 写入/全量扫描路由）和 client 端（Settings > Plugins 按钮）。
- 主对话 usage 来自 `assistant/chunk` / `assistant/message`；额外请求来自 `compaction/summary`、`session-title`、`web-search`。
- `captureWebSearchUsage` 开启时，插件会运行时拦截 DeepSeek 搜索响应并解析 usage；这是 monkey-patch 方案，不修改 DSH 源码。
- 历史 `session-title` 请求没有持久化 usage，无法回补；新产生的标题请求会通过 `llm/stream` 捕获。
- 写入时机：turn 结束时写入该 turn 的汇总行；未结束 turn 也会在 `step/end` / 全量扫描时落库。
