# dsh-token-sql

将 DeepSeek Harness 会话中产生的 token usage 按 **turn 聚合**后持久化到 SQLite 的 DSH 宿主插件。

## 功能

- 只写入**真正产生过 token usage** 的会话/turn；没有 usage 的会话不会生成行。
- 数据层级：`workspace -> session_id -> turn`。
- 每个 turn 汇总该 turn 内所有 step 的 token usage，存为一行。
- 同一 step 的 `assistant/chunk` usage 和 `assistant/message` usage 不会重复累计：`assistant/message` 作为该 step 的最终值覆盖早期 chunk 样本。
- 支持启动时回填当前已加载会话的历史 usage。
- 支持全量扫描所有持久化历史会话，并在 Settings > Plugins 中提供“全量扫描所有历史会话”按钮。

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
pnpm dsh plugin --profile web add ./dsh-token-sql-0.0.1.tgz
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

如果是 tarball 安装，则依赖记录为 `file:/path/to/dsh-token-sql-0.0.1.tgz`。两种方式安装后，插件文件都会出现在 profile 的 `node_modules/dsh-token-sql` 下。

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

### 开发热装配（可选，需 dsh-super-injector）

如果当前 DSH 环境已装配 `dsh-super-injector`，也可以让 AI 调用以下工具进行免重启热装配：

- `dev_install_package`：热装配到 profile 并写入 `dsh.profile.bundles`，重启后仍由官方装配接管。
- `dev_inject_plugin`：仅运行时注入，不修改 profile manifest。
- 注意：super-injector 的热装配使用 `link:` / junction，插件文件不会复制到 `node_modules/dsh-token-sql`，属于开发态；正式安装请使用上面的 `dsh plugin add file:...` 或 tarball 方式。

普通用户建议使用上面的官方 `dsh plugin add` 流程。

## 存储位置

默认数据库文件：

```text
~/.dsh/storages/token-usage.sqlite
```

默认路径解析规则：

- 设置了 `DSH_HOME`：使用 `${DSH_HOME}/storages/token-usage.sqlite`
- 未设置 `DSH_HOME` 但设置了 `HOME`：使用 `${HOME}/.dsh/storages/token-usage.sqlite`
- `DSH_HOME` 和 `HOME` 都为空：**不自动选择路径**，插件会提示必须在配置中手动设置 `path`

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

其中：

- `workspace` 来自会话 `cwd` 的目录名，例如 `/root/DSHWorkFile/dsh-token-meter` → `dsh-token-meter`
- `session_id` 是会话唯一 id
- `turn` 是会话内的轮次
- `session_title` 是会话标题（来自 `session/title` 事件，last-wins）
- `session_created_at` 是会话创建时间（来自 `session.header.createdAt`）
- `session_updated_at` 是会话最后活动时间（处理到的最新事件时间）
- `request_count` 是该 turn 内上报过 usage 的 step 数量
- `reasoning_tokens` 已包含在 `output_tokens` 中，这里单独保存便于查看推理细分

## 配置

```yaml
- id: dsh-token-sql
  name: 'dsh-token-sql'
  config:
    path: ''              # 空字符串 = 默认 ~/.dsh/storages/token-usage.sqlite
    backfillOnStart: true # 启动时回填当前已加载会话
    exposeWebApi: true    # 是否在 Harness Web 服务上暴露 /api/usage
```

也可以在 **设置 → 插件 → Token SQL** 里通过“网页 API 映射”开关实时切换 `exposeWebApi`。

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

宿主 Web 服务（默认 `127.0.0.1:3080`）上暴露了一个只读接口：

```text
GET /api/usage
```

返回 SQLite 中 `turn_token_usage` 表的全部行，以及一个聚合汇总：

```json
{
  "ok": true,
  "value": {
    "rows": [
      {
        "workspace": "dsh-token-meter",
        "sessionId": "session-xxx",
        "turn": 1,
        "sessionTitle": null,
        "sessionCreatedAt": 1787397701893,
        "sessionUpdatedAt": 1787397701899,
        "provider": "deepseek",
        "model": "deepseek-chat",
        "uncachedInputTokens": 65,
        "outputTokens": 154,
        "cacheReadTokens": 1664,
        "cacheWriteTokens": 0,
        "reasoningTokens": 61,
        "requestCount": 1,
        "firstEventTime": 1787397701899,
        "lastEventTime": 1787397701899
      }
    ],
    "totals": {
      "uncachedInputTokens": 65,
      "outputTokens": 154,
      "cacheReadTokens": 1664,
      "cacheWriteTokens": 0,
      "reasoningTokens": 61,
      "requestCount": 1,
      "turnCount": 1,
      "sessionCount": 1,
      "workspaceCount": 1
    }
  }
}
```

该接口与全量扫描一样有 loopback fence，只接受来自本机（`127.0.0.1` / `localhost`）的 GET 请求。

### 查询参数

`turn_token_usage` 表里的字段基本都可以作为过滤参数。推荐使用 SQL 列名的 snake_case 形式，也兼容 camelCase 别名。

文本/可空字段精确匹配：

| 参数 | 对应列 |
| --- | --- |
| `workspace` | `workspace` |
| `session_id` / `sessionId` | `session_id` |
| `session_title` / `sessionTitle` | `session_title` |
| `provider` | `provider` |
| `model` | `model` |

数字字段精确匹配：

| 参数 | 对应列 |
| --- | --- |
| `id` | `id` |
| `turn` | `turn` |
| `session_created_at` / `sessionCreatedAt` | `session_created_at` |
| `session_updated_at` / `sessionUpdatedAt` | `session_updated_at` |
| `uncached_input_tokens` / `uncachedInputTokens` | `uncached_input_tokens` |
| `output_tokens` / `outputTokens` | `output_tokens` |
| `cache_read_tokens` / `cacheReadTokens` | `cache_read_tokens` |
| `cache_write_tokens` / `cacheWriteTokens` | `cache_write_tokens` |
| `reasoning_tokens` / `reasoningTokens` | `reasoning_tokens` |
| `request_count` / `requestCount` | `request_count` |
| `first_event_time` / `firstEventTime` | `first_event_time` |
| `last_event_time` / `lastEventTime` | `last_event_time` |
| `created_at` / `createdAt` | `created_at`（行创建时间） |
| `updated_at` / `updatedAt` | `updated_at`（行更新时间） |

数字字段还支持范围过滤，使用 `_min` / `_max` 后缀（含边界）：

```text
turn_min=1&turn_max=5
output_tokens_min=1000
cache_read_tokens_max=500000
```

对应的 camelCase 也兼容，例如 `turnMin` / `turnMax`、`outputTokensMin`。

### 时间段快捷筛选

除了直接写 `last_event_time_min` / `last_event_time_max`，还提供更友好的时间范围参数：

| 参数 | 说明 |
| --- | --- |
| `since` / `from` | 起始时间；支持毫秒时间戳、ISO 日期、`now`、相对时长如 `7d` / `24h` / `1w` |
| `until` / `to` | 结束时间；支持毫秒时间戳、ISO 日期、`now` |
| `time_field` / `timeField` | 选择按哪个时间字段过滤，默认 `last_event_time`；可选 `first_event_time`、`session_created_at`、`session_updated_at`、`created_at`、`updated_at` |

示例：

```text
# 过去一周（默认按 last_event_time）
GET /api/usage?since=7d

# 指定起止时间
GET /api/usage?since=2025-01-01&until=2025-01-08

# 按会话创建时间筛选过去一周
GET /api/usage?since=7d&time_field=session_created_at

# 过去 24 小时且只取原始数组
GET /api/usage?since=24h&raw=1
```

分页与输出：

| 参数 | 说明 |
| --- | --- |
| `limit` | 返回行数上限（非负整数） |
| `offset` | 跳过前面的行数（非负整数，常与 `limit` 一起分页） |
| `raw=1` / `raw=true` | 直接返回裸 JSON 行数组，不包 `{ ok, value }`，也没有 `totals` |

示例：

```text
GET /api/usage?workspace=dsh-token-meter&limit=10&offset=20
GET /api/usage?session_id=session-xxx&raw=1
GET /api/usage?provider=deepseek-official&output_tokens_min=1000&limit=50
GET /api/usage?turn_min=1&turn_max=3&cache_read_tokens_max=100000
```

`totals` 会跟随所有过滤条件一起汇总（`limit` / `offset` 除外，它们只影响 `rows`）。

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
- 当前只处理 `assistant/chunk` 和 `assistant/message` 中的 usage；`compaction/summary` 等其它 usage 暂未纳入。
- 写入时机：turn 结束时写入该 turn 的汇总行；如果会话在 turn 未结束时被销毁，也会 flush 已累积的 turn。
