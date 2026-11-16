# Spec: 项目级 artifact root（`.feynman/`）

- 状态：待实施（决策已锁定，见 §1）
- 版本：目标 0.25.0
- 分析依据：`outputs/artifact-root-20261116.md`（本地分析稿，按仓库惯例不跟踪）
- 验证方案：[verification.md](verification.md)
- 最终审查：[review.md](review.md)（3 个阻塞问题与全部处置）

本 spec 是实现的唯一依据。要求编号 `R*` 供测试引用；未在本文出现的行为变化一律视为超出范围。

---

## 1. 已锁定的决策

| # | 决策 | 值 | 若改主意的开关点 |
|---|---|---|---|
| D1 | 缺省布局 | `.feynman/` | `lib/project-paths.js` 的 `DEFAULT_ARTIFACT_ROOT`；§4.1 的文档与 eval 缺省 |
| D2 | `experiments/` | **一并搬进 artifact root**（与其余三个目录同一规则） | `MOVED_DIRS` 常量与映射正则 |
| D3 | 可选布局 | 仅 `.`（上游）与 `.feynman` 两个值 | `SUPPORTED_ROOTS`；`--root` 校验 |
| D4 | 跟踪方式 | `.gitignore` managed block；缺省不跟踪 | §7 的 managed block 内容表 |
| D5 | 布局记录位置 | `.feynman/project.json` | §5 文件格式 |
| D6 | prompt 模板 | 保持上游原文，渲染期映射；唯一例外是 R4.12 的 autoresearch 路径锚定 | §6、R4.12 |
| D7 | 旧布局 | 只读兼容，不自动迁移 | §8 |
| D8 | Step 2（AGENTS.md / CHANGELOG 语义） | 不在本 spec 内 | 独立的后续 spec |

决策依据见分析文档；本 spec 不再重复论证。

---

## 2. 术语与不变量

- **artifact root**：`''`（上游布局，等价于项目根）或 `'.feynman'`。内部用小写字符串表示，`''` 不产生前缀。
- **moved dirs**：`outputs/`、`papers/`、`notes/`、`experiments/`。它们实际落在 `<root>/` 下。
- **项目根**：会话工作目录（`workingDirectory` 服务优先，回退 `session.header.cwd`，最后 `resolve()` 归一）。不做向上查找。

不变量（任何实现都必须满足）：

- **I1** 当 root 为 `''` 时，所有渲染出的 prompt 与 C0b fixture 逐字节一致；除 R4.12 的 autoresearch 路径锚定外，与 0.24.0 逐字节一致（verification T-REG-01/02）。
- **I2** 用户输入（`$@`、`<slug>` 之外的命令参数、summarize 的 source）永不参与路径映射。
- **I3** 插件不写工作目录以外的路径；root 只接受工作区相对路径，且写入前用 `realpath` 校验解析结果仍在工作区内（与 `document_*` 工具的既有策略一致）。
- **I4** brief 中的产物路径是具体路径，不含"请自行解析"的占位符。
- **I5** `.feynman/` 是插件唯一的隐藏目录；插件不再在项目根创建任何产物目录（`AGENTS.md` 因宿主约束例外）。
- **I6** `init` 幂等：同一参数重复执行，`created`/`changed` 为空。
- **I7** 迁移/兼容不破坏旧文件：不删除、不移动、不覆盖。

---

## 3. 目录模型

```
<cwd>/
  AGENTS.md                       # 存在则不覆盖（上游契约）
  .feynman/
    project.json                  # 布局记录（§5.1）
    .gitignore                    # 固定含 fetch/
    outputs/
      <slug>.md
      <slug>.provenance.md
      .plans/<slug>.md
      .drafts/
      .notes/
    papers/<slug>.md
    notes/session-logs/README.md
    experiments/                  # 实验代码、autoresearch 会话状态、日志
    fetch/                        # 既有运行时缓存，语义不变
```

`--root .` 时，`outputs/`、`papers/`、`notes/`、`experiments/` 位于项目根；`.feynman/` 仍存在（marker + fetch 缓存 + `.gitignore`）。

---

## 4. 要求

### R1 布局模型

- R1.1 内部 root 取值为 `''` 或 `'.feynman'`；不得出现其他值。
- R1.2 路径拼接只允许通过 `lib/project-paths.js`；`index.js`、`prompts.js`、`lib/source-check.js`、`lib/workflow-tool.js`、evals 不得手写 `'.feynman/...'` 字面量。
- R1.3 四个目录 `outputs/`、`papers/`、`notes/`、`experiments/` 是唯一被搬运的目录；插件不再在项目根创建产物目录。`AGENTS.md` 是唯一例外（DSH 只从项目根加载）。

### R2 布局解析（无副作用，同步）

优先级：**marker → 旧布局特征 → 缺省**。

```
resolveLayout(cwd):
  marker = readMarker(cwd)                       # .feynman/project.json
  if marker.status == 'present' and root valid:   return { root, source: 'marker' }
  if marker.status == 'invalid':                  note error（保留 detail）
  legacy = detectLegacyLayout(cwd)
  if legacy.legacy:                               return { root: '', source: 'legacy', detail: legacy.evidence }
  return { root: DEFAULT_ARTIFACT_ROOT, source: 'default' }
```

- R2.1 `detectLegacyLayout(cwd)` 返回命中的证据列表；命中任一项即视为旧布局：
  - `<cwd>/outputs/.plans` 是目录；
  - `<cwd>/outputs/.drafts` 是目录；
  - `<cwd>/papers/` 下存在 `*.provenance.md`；
  - `<cwd>/notes/session-logs/README.md` 是文件。
- R2.2 marker 的 `artifactRoot` 不在 `['.', '.feynman']`（归一后）→ 视为 invalid，回退到 R2 的后续步骤，并记录 `detail`。
- R2.3 解析结果结构：`{ root: '' | '.feynman', source: 'marker'|'legacy'|'default', marker: 'present'|'missing'|'invalid', detail?: string }`。
- R2.4 读不到 cwd（无工作区）→ `{ root: '', source: 'default', marker: 'missing', detail: 'no workspace' }`；命令照常排队（与现状一致），不报错。
- R2.5 `.feynman`（以及写入的 `outputs`/`papers`/`notes`/`experiments`）是符号链接：**读取可用**（`readMarker` 照常），但写入前必须 `realpath` 校验解析后的目录仍在工作区内。跑出工作区 → `init` 以错误停止、`source-check` 拒写；在工作区内 → 允许，`detail`/`warnings` 记一条提示供 `doctor` 展示。理由：链接可能是显式选择，但 I3 不能被绕过。

### R3 路径映射（纯函数）

`mapArtifactPaths(text, root)`：

```js
if (root === '') return text
return String(text)
  .replace(/(?<![\w./-])(outputs|papers|notes|experiments)\//g, `${root}/$1/`)
  .replace(/(?<![\w./-])(outputs|papers|notes|experiments)(?=`)/g, `${root}/$1`)
```

- R3.1 只匹配四个 moved dir：`dir/` 前缀，或模板中反引号包裹的裸目录名（`` `outputs` ``）；普通 prose 单词不匹配。
- R3.2 前一个字符是 `\w`、`.`、`/`、`-` 时不匹配（防止二次前缀、`myoutputs/`、`foo.output/`）。
- R3.3 `experiments/` 与其余三个目录同等处理，不再有例外。
- R3.4 幂等：`mapArtifactPaths(mapArtifactPaths(t, r), r) === mapArtifactPaths(t, r)`。
- R3.5 示例（断言用）：

| 输入 | root `'.feynman'` | root `''` |
|---|---|---|
| `outputs/<slug>.md` | `.feynman/outputs/<slug>.md` | 原样 |
| `outputs/.plans/<slug>.md` | `.feynman/outputs/.plans/<slug>.md` | 原样 |
| `` `papers/<slug>.provenance.md` `` | `` `.feynman/papers/<slug>.provenance.md` `` | 原样 |
| `notes/session-logs/README.md` | `.feynman/notes/session-logs/README.md` | 原样 |
| `experiments/x.py` | `.feynman/experiments/x.py` | 原样 |
| `.feynman/outputs/x.md` | 原样（不二次前缀） | 原样 |
| `myoutputs/x.md` | 原样 | 原样 |
| `` `outputs` ``（裸代码名） | `` `.feynman/outputs` `` | 原样 |
| `papers/my study.pdf`（若直接调用函数） | `.feynman/papers/my study.pdf` | 原样 |

> `mapArtifactPaths` 不知道调用来源；§6 要求先映射模板、再插入 `$@`/`<slug>`，因此用户输入不会被它改写（T-PROMPT-04/05/06）。

### R4 模块划分与 API

#### R4.1 `lib/project-paths.js`（新增）

只依赖 `node:fs`、`node:path`；不做子进程、不写文件。

```js
export const DEFAULT_ARTIFACT_ROOT = '.feynman'
export const MARKER_DIR = '.feynman'            // 布局记录目录（与 root 无关，永远存在）
export const MARKER_FILE = 'project.json'
export const CACHE_IGNORE = 'fetch/'            // .feynman/.gitignore 的固定行
export const SUPPORTED_ROOTS = Object.freeze(['.', '.feynman'])
export const MOVED_DIRS = Object.freeze(['outputs', 'papers', 'notes', 'experiments'])

export function normalizeRoot(value)        // '.'|'./'|'' -> '' ; '.feynman'|'.feynman/' -> '.feynman'; 其他 -> null（不 trim）
export function readMarker(cwd)             // { status, root?, error?, path }
export function detectLegacyLayout(cwd)     // { legacy: boolean, evidence: string[] }
export function resolveLayout(cwd)          // 见 R2
export function layoutLabel(root)           // '.feynman/' | '.'（用于文案与 header）
export function artifactDir(root, ...parts) // 相对路径、POSIX 分隔符、无前导 './'
export function artifactPath(cwd, root, ...parts) // 绝对路径（resolve + join）
export function mapArtifactPaths(text, root)
export function legacyArtifacts(cwd)        // { dirs: { outputs: n, papers: n, notes: n }, present: string[] }
export function workspaceRoot(ctx, session) // workingDirectory 服务优先，回退 session.header.cwd；返回 resolve 后的绝对路径或 undefined
```

- `artifactDir('', 'outputs', '.plans')` → `'outputs/.plans'`；`artifactDir('.feynman', 'outputs')` → `'.feynman/outputs'`。
- `workspaceRoot` 不得抛错；`ctx.get` 不存在时静默回退。
- `legacyArtifacts` 的文件数按**递归**统计（含 `outputs/.plans`、`.drafts`、`.notes` 等隐藏子目录），只统计文件；`present` 只含存在的目录。
- **根目录 `experiments/` 不是旧布局信号**：代码库常自带该目录。它既不参与 `detectLegacyLayout`，也不进入 `legacyArtifacts` 展示。
- 所有函数必须接受相对 cwd 并自行 `resolve`（沿用 `outputs/alignment-fixes-20261028.md:149` 的教训）。

#### R4.2 `lib/project-git.js`（新增）

只依赖 `node:child_process`、`node:fs`、`node:path`。

```js
export function isWorkTree(cwd)                  // { ok: boolean, reason?: string }
export function checkIgnore(cwd, relPath, opts)  // { ignored: boolean, source?: string, raw?: string, reason?: string }
export function listTracked(cwd, relPath)        // string[]
export function readManagedBlock(text)           // 行号 0-based：{ startLine, endLine, lines } | { truncated: true, startLine } | null
export function writeManagedBlock(file, lines)   // { changed: boolean, action: 'created'|'updated'|'unchanged', error?: string }
export function removeManagedBlock(file)          // { changed: boolean, action: 'removed'|'unchanged', error?: string }
```

- 用 `execFileSync('git', [...], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })`；`ENOENT`（git 不存在）→ `{ ok: false, reason: 'git-not-found' }`。`rev-parse` 在非仓库时 exit 128，须捕获后返回 `{ ok: false }`，不得抛到调用方。
- `checkIgnore(cwd, relPath, { verbose } = {})` 用 `git check-ignore -v -- <relPath>`：exit 0 = ignored，exit 1 = not ignored，其他 = `reason`；`verbose` 时额外返回原始行 `raw`（供 `doctor`）。**注意 negation**：`git check-ignore -v` 对 "被 `!` 规则排除" 的路径也返回 exit 0（输出 pattern 以 `!` 开头），必须把这种结果判为 `ignored: false`。`execFileSync` 在 exit 1/128 也会抛错，必须捕获并读 `error.status`，把 0/1 当正常结果。`-v` 输出先按 `\t` 切出 pathname，再用 `^(.*?):(\d+):(.*)$` 非贪婪解析 `source:line:pattern`：源路径里可能含盘符冒号，pattern 里也可能含 `:digits:`，取第一个 `:digits:` 更稳。
- `listTracked` 用 `git ls-files -- <relPath>`；git 不可用或非仓库时返回 `[]`（不抛错）。
- managed block 标记（逐字）：

  ```
  # >>> dsh-feynman (managed by /feynman init)
  # <<< dsh-feynman
  ```

  `writeManagedBlock` 行为：
  1. 文件不存在 → 创建，内容 `START\n<lines>\nEND\n`，`action: 'created'`。
  2. 存在且已有完整 block → 只替换 block 内部；外部内容逐字节保留；内容相同则 `action: 'unchanged'`，否则 `'updated'`。
  3. 存在但只有 START 没有 END（截断）→ 不修改，返回 `error: 'truncated'`。
  4. 不存在 block → 追加：文件为空时只写 block（无前导空行）；文件非空且不以换行结尾时先补换行，与已有内容之间保留一个空行；`action: 'updated'`（或对空文件 `'created'`）。
  5. 换行风格：检测文件既有主 EOL（首行含 `\r\n` 则用 CRLF），插入行沿用；不混合。
  6. `lines` 为空时等价于 `removeManagedBlock`；移除只删我方 block，并清理因此产生的连续多余空行（最多保留一个分隔空行）。
  7. 行数上限保护：block 只允许 `lines` 参数生成，不接受手写内容。

#### R4.3 `lib/init-scaffold.js`（改造）

```js
export async function scaffoldProject(cwd, options = {})
// options: { root?: '.'|'.feynman', tracking?: 'track'|'no-track' }
// 返回：
{
  root,                    // '' | '.feynman'
  source,                  // 'flag'|'marker'|'legacy'|'default'
  markerPath,              // 绝对路径
  created: string[],       // 相对 cwd 的 POSIX 展示路径
  kept: string[],
  changed: string[],
  warnings: string[],
  git: { status: 'ok'|'not-a-repo'|'unavailable'|'error', action: 'created'|'updated'|'removed'|'unchanged'|'none', detail?: string },
  error?: string,            // 仅核心脚手架失败时
}
export function describeScaffold(result): string
```

- `git.action` 取值：`created`（新建 managed block）/`updated`（改写 block）/`removed`（track 模式移除）/`unchanged`（block 内容已正确）/`none`（track 模式且本就没有 block，或未参与 git）。
- R4.3.1 保留现有导出 `PROJECT_AGENTS_TEMPLATE`、`SESSION_LOGS_README`、`scaffoldProject`、`describeScaffold` 的名字；模板常量保持上游原文，**写盘时**才 `mapArtifactPaths`（四个 moved dir 均映射）。
- R4.3.2 执行顺序：校验参数与既有 marker（§7.4，失败即止）→ 解析 root → git 可用时**先**基于创建前状态做安全阀评估（§7.3）→ 创建 `<MARKER_DIR>/` → `<root>/outputs/{,.plans,.drafts,.notes}` → `<root>/papers` → `<root>/notes/session-logs` → `<MARKER_DIR>/<MARKER_FILE>` → `<MARKER_DIR>/.gitignore`（内容 `CACHE_IGNORE`）→ `notes/session-logs/README.md` → 根 `AGENTS.md`（仅在缺失时）→ `<MARKER_DIR>/AGENTS.template.md` → 按评估结果写/移除 managed block → `check-ignore` 复核。marker 路径一律由常量拼接，不写字面量。
- R4.3.3 已存在的文件/目录一律 `kept` 或静默跳过，不改写、不删除。
- R4.3.4 核心脚手架 fs 操作失败（EACCES、`.feynman` 是普通文件、模板写不进等）：收集错误，返回 `{ error }` 之外仍带回已完成项；`initHandler` 报 `kind: 'error'` 并附完成清单，不得静默成功。ignore 相关失败按 §7.3 处理为非致命 warning。
- R4.3.5 不预创建 `<root>/experiments/`；`autoresearch` 按 R4.12 锚定的路径在运行时自行创建。

#### R4.4 `prompts.js`（改造）

- R4.4.1 `buildPrompt(kind, args, refs = {...}, layout = { root: '', note: '' })`：新增第 4 参数（对象；`root` 为 `''|'.feynman'`，`note` 为可选告警文本）。默认值保持现有调用可用。
- R4.4.2 `WORKFLOWS[kind].prompt(args, root = '')`：所有条目统一签名。
- R4.4.3 `upstreamPrompt(kind)` 返回 `(rawInput, root = '')`；**先**对 `UPSTREAM_WORKFLOWS[kind]` 做 `mapArtifactPaths`，**再** `split(/(\$@|<slug>)/)` 并插值用户输入（I2）。
- R4.4.4 `TOOL_PRELUDE` 保持模块常量原文；渲染时对其单独 `mapArtifactPaths`。
- R4.4.5 `LOG_BRIEF` 删除模块级常量；`LOG_PROMPT(rawInput = '', root = '')` 每次由 `upstreamPrompt('log')('', root)` 生成。
- R4.4.6 `SUMMARIZE_PROMPT` 的 4 处产物路径改用 `artifactDir(root, 'outputs', '.notes', ...)` / `artifactDir(root, 'outputs', ...)` 构造；`source` 原样插值。
- R4.4.7 `buildPrompt` 在 `layout.root !== ''` 时于最前面插入 header（`<label>` = `layoutLabel(layout.root)`，`<root>` = `layout.root`；**不得在 prompts.js 写死 `.feynman` 字面量**）：

  ```
  Artifact root: <label> (project layout). Every artifact path in this brief is already resolved under it — write those paths exactly as given. `grep` from the workspace root does not search hidden directories; pass `path: "<root>"` when searching for artifacts.
  ```

  `layout.root === ''` 时不插入任何 header（I1）。
- R4.4.8 若 `layout.note` 非空（invalid marker / symlink warning 等），header 追加一行 `Note: <note>`；只在 `layout.root !== ''` 时。
- R4.4.9 `loopFollowupPrompt` 不含路径，保持不变。

#### R4.5 `lib/workflow-tool.js`（改造）

- R4.5.1 `createWorkflowTool(refs, resolveRoot)`；`resolveRoot(session)` 返回 `resolveLayout` 结果。
- R4.5.2 `execute` 中 `buildPrompt(workflow, args, refs(), { root: layout.root, note: layout.detail })`。
- R4.5.3 工具描述追加一句：产物写到项目 artifact root（缺省值取 `DEFAULT_ARTIFACT_ROOT`，不写字面量）。
- R4.5.4 缺少会话/工作区时 `layout.root = ''`，不得抛错。

#### R4.6 `lib/source-check.js`（改造）

- R4.6.1 `createSourceCheckTool(runtime, { store, resolveRoot })`：新增 `resolveRoot(session)` 注入；缺省实现回退 `session.header.cwd` + `resolveLayout`，且只在 `execute` 时解析（`/feynman tools` 的 schema-only 构造不得触发 fs/git 访问）。
- R4.6.2 写盘目录改为 `join(artifactPath(cwd, layout.root, 'outputs'))`；文件仍为 `<slug>-source-check.md` / `.json`。
- R4.6.3 返回值 `paths.artifact`/`paths.json` 仍是绝对路径，store 的 `savedPath` 不变。
- R4.6.4 工具描述改为：“…writes a reviewable artifact under the project artifact root (`<DEFAULT_ARTIFACT_ROOT>/outputs/<slug>-source-check.md` by default)…”，其中路径由 `lib/project-paths.js` 的常量拼接（不得写死字面量）。

#### R4.7 `index.js`（改造）

- R4.7.1 新增内部 helper `layoutFor(ctx, session)`：`workspaceRoot(ctx, session)` → `resolveLayout`；无工作区返回 `{ root: '', source: 'default', marker: 'missing', detail: 'no workspace' }`。
- R4.7.2 `workflowHandler` / summarize 分支 / review-loop 分支：解析一次 layout，`buildPrompt(..., { root: layout.root, note: layout.detail })`；回执文案用 `artifactDir(root, 'outputs') + '/'`。
- R4.7.3 `/outputs` 提示改成函数 `outputsPrompt(layout)`：先列 `<root>/{outputs,papers,notes,experiments}`；再列**另一布局**下已存在的 `outputs/`、`papers/`、`notes/`（布局转换后仍可发现旧产物）；根目录 `experiments/` 仅在含 `autoresearch.*` 时列（否则可能是用户自己的代码）；要求用 `ls -a` / 精确路径 / `glob`，并说明根目录 `grep` 会跳过隐藏的 artifact root（路径与提示文字由 `layoutLabel`/`artifactDir` 生成）。
- R4.7.4 `websearch` 的 followup 提示中 `outputs/.notes/` 改为 `artifactDir(root,'outputs','.notes')`。
- R4.7.5 `initHandler(invocation, ctx)`：用 `workspaceRoot(ctx, session)` 取 cwd（而不是直接用 `session.header.cwd`），解析参数（R7），调用 `scaffoldProject`，返回 `describeScaffold`。
- R4.7.6 `status`：追加三行（顺序固定）：
  - `- Artifact root: <label> (source: marker|legacy|default)`
  - `- Git: ignored|tracked|not a repository|git unavailable`（由 `checkIgnore` 对 artifact 路径探测；探测路径同 §7.3）
  - `- Legacy artifacts: <dirs>`（仅当 `legacyArtifacts().present` 非空）
- R4.7.7 `doctor`：追加 root/marker 状态、`check-ignore -v` 原始行、旧布局遗留、旧 `AGENTS.md` 模板告警（§5.4）；"已有产物"的判定是 `<root>/{outputs,papers,notes,experiments}` 下递归至少一个文件。若 artifact root 被忽略且已有产物，追加一行：`Artifact root is git-ignored; git clean -xdf deletes research artifacts. Use /feynman init --track to version them.`
- R4.7.8 `initHandler` 已经由 `researchHandler` 以 `session(subInvocation, ctx)` 透传 `ctx`，直接使用第二参数即可；不需要改 `sessionHandlers` 映射。
- R4.7.9 插件 systemPrompt 段（`index.js:454`）把 `outputs/<slug>-source-check.md` 改为“the project artifact root (`<DEFAULT_ARTIFACT_ROOT>/outputs/<slug>-source-check.md` by default)”，路径由常量拼接。
- R4.7.10 `prompts.js` 的 `SESSION_COMMANDS.init` 描述改为：`Create AGENTS.md, the artifact root, and session-log folders from templates, keeping existing files`；`SESSION_COMMANDS.outputs` 描述改为：`Browse research artifacts under the project artifact root`；`help` 输出随之更新。**同时**更新 `lib/client.js` 的 `SUBCOMMANDS` 静态副本（init 行提及 artifact root），否则裸命令 picker 与 `help` 不一致。

#### R4.8 `cordis.patch.yml` 与 skills（文案）

- R4.8.1 persona 的 `Artifacts:` 段落改为 root 无关（逐字见 §9.6）；`Locations:` 行删除。
- R4.8.2 `resources/skills/*.md` 中 9 个含目录路径的文件：prose 用“the project artifact root（缺省 `.feynman/`，由 `.feynman/project.json` 记录）”；可执行命令不能用 `<artifact-root>`（shell 会把 `<` 当重定向）——写成 `ARTIFACT_ROOT=...`，路径用 `"$ARTIFACT_ROOT/outputs/..."`。`feynman-autoresearch.md` 的会话文件行按 R4.12.3 处理。
- R4.8.3 skills 不得再出现裸 `outputs/`、`papers/`、`notes/`、`experiments/` 前缀（测试断言；`<artifact-root>/` 前缀不算裸路径）。

#### R4.9 evals

- R4.9.1 `run.mjs` 新增 `--layout <feynman|upstream>`（缺省 `feynman`）。导出 `buildTask(workflow, question, layout)` 接受字符串（历史对象形式也兼容）。在构建 prompt 前写 `<workdir>/.feynman/project.json`（`artifactRoot` 取 `DEFAULT_ARTIFACT_ROOT` 或 `"."`，不写字面量）；导出 `buildTask(workflow, question, layout)` 与 `writeLayoutMarker(workdir, root)`：前者把 root + prompt 组装成纯函数，后者在 headless 会话启动前写 marker；主循环调用两者。内部调用 `buildPrompt(workflow, question, undefined, { root, note: '' })`（第 3 参数显式占位，避免传参错位）。
- R4.9.2 结果行新增 `layout: 'feynman'|'upstream'`。
- R4.9.3 `score.mjs` 用 `resolveLayout(workdir)` 解析，路径全部经 `artifactDir`；旧结果目录（无 marker、有旧布局特征）自动按根布局评分。
- R4.9.4 `done` 判定只认解析出的 root 下的产物；不做无条件 read-both（防止写错 root 仍得分）。
- R4.9.5 `evals/README.md` 更新“Artifact naming”与列说明。

#### R4.10 文档与版本

- R4.10.1 `README.md`：新增 “Artifacts and layout” 小节（布局树、`init` 参数、跟踪开关、`--root .`、grep 注意事项、no-track 下 `git clean -xdf` 会删除研究产物的提醒）；修正表格中 `papers/`、`notes/`、`outputs/` 的绝对表述。
- R4.10.2 `RELEASES.md`：加 0.25.0 条目（行为变更、兼容读取、不迁移）。
- R4.10.3 `docs/upstream-20261013.md`：记录 artifact location 与 autoresearch 会话文件锚定的有意分歧及理由。
- R4.10.4 `package.json` 版本在发布时改 0.25.0（测试不依赖版本号）。

#### R4.11 `lib/fetch-content.js`（常量收敛）

- R4.11.1 `FETCH_DIR` 改为 `join(MARKER_DIR, 'fetch')`，取源提示里的 `.feynman/fetch/` 由 `MARKER_DIR` 拼接；**路径值与行为不变**。
- R4.11.2 `lib/content-store.js` 文件头注释里的 `.feynman/fetch/` 改为 "the fetch cache directory"，避免代码出现该字面量。
- R4.11.3 目的：`.feynman` 字面量只存在于 `lib/project-paths.js`（T-STATIC-02）。

#### R4.12 autoresearch 会话文件锚定（唯一允许的上游模板改写）

- R4.12.1 `resources/workflows.json` 的 `autoresearch` 模板：6 处裸文件名加 `experiments/` 前缀——resume 检查的 `autoresearch.md`、`autoresearch.jsonl`，初始化行的 `autoresearch.md`、`autoresearch.jsonl`、`autoresearch.sh`，以及报告行引用 `autoresearch.jsonl` 的一处。只做路径锚定，不改语义、不改其它文字。
- R4.12.2 渲染期 `experiments/` 随 root 映射：`.feynman/experiments/autoresearch.*` 或原样（根布局）。
- R4.12.3 `resources/skills/feynman-autoresearch.md` 的 “Session files” 行改为 `<artifact-root>/experiments/autoresearch.{md,sh,jsonl}`（prose）；若给命令，用 `"$ARTIFACT_ROOT/experiments/..."`。
- R4.12.4 兼容：旧版本留在项目根的 `autoresearch.md/.jsonl/.sh` 不会再被检测为续跑状态；不自动迁移，在 RELEASES 说明。
- R4.12.5 fixture 顺序：先记录 0.24.0 基线（`tests/fixtures/prompt-hashes-024.json`），再做 R4.12.1，再记录 `tests/fixtures/prompt-hashes.json`；回归同时校验“除 autoresearch 外与 0.24.0 一致”与“autoresearch 只多了 6 个 `experiments/` 前缀”。

---

## 5. 文件格式

### 5.1 `.feynman/project.json`

```json
{
  "version": 1,
  "artifactRoot": ".feynman"
}
```

- 可选字段 `ownedDirs`、`skippedDirs`（仅根布局，非空时写入）：`ownedDirs` 记录由 `init` 创建、之后可安全忽略的目录；`skippedDirs` 记录创建前已有内容、不忽略的用户目录。两者让重复 `init` 保持同一判断：否则第二次运行会把 `init` 自己创建的 `.plans/` 误判成用户内容而撤回忽略，或把用户文件误忽略。布局切换时清除。
- 2 空格缩进、UTF-8、末尾换行。
- 读取：仅接受对象 + `artifactRoot` 字符串；`version` 缺失按 1 处理；其他字段保留。
- 写入（`init`）：读现有合法 JSON → `{ ...existing, version: 1, artifactRoot: normalized, skippedDirs?, ownedDirs? }`；现有文件非法 JSON → **不覆盖**，`init` 返回错误并提示用户手工修复/删除。
- 允许的 `artifactRoot` 值：`"."`、`"./"` 归一为 `"."`；`".feynman"`、`".feynman/"` 归一为 `".feynman"`；其他值视为 invalid（不 trim）。

### 5.2 `.feynman/.gitignore`

固定内容（缺行则补，不覆盖其他行）：

```
fetch/
```

### 5.3 `.gitignore` managed block

见 R4.2 的标记与写入算法；内容见 §7.3。

### 5.4 `AGENTS.md`

- 已存在但不可读的 `AGENTS.md`：`kept`，不检查内容、不因读取失败让 `init` 失败。
- 从 `.feynman` 布局切到根布局时，若现有 `AGENTS.md` 仍命名 `<MARKER_DIR>/` 路径，追加一条提示（不重写文件）。
- 无论根 `AGENTS.md` 是否存在，都写 `<MARKER_DIR>/AGENTS.template.md`（**写入时**渲染 `PROJECT_AGENTS_TEMPLATE`；导出的常量保持上游原文不变，上游源文件在时 `experiments/check-init-templates.mjs` 仍按上游逐字比对；不在时由 `tests/static.test.js` 的 hash fixture 守住）。已存在则 kept——这样首次运行与重复运行都得到同一份可并入的模板，幂等。
- 根 `AGENTS.md` 仅在缺失时写入；已存在则不动（上游契约）。
- 旧模板检测（§5.4）：内容同时包含 `# Feynman Project Guide` 与（`` `notes/`, `outputs/`, `experiments/`, and `papers/` `` 或 `notes/session-logs/`）→ 视为旧模板。

---

## 6. 渲染期映射（强制流程）

```
buildPrompt(kind, args, refs, layout):
  body   = WORKFLOWS[kind].prompt(args, layout.root)   # TOOL_PRELUDE 已由各 prompt 内部包含并已映射
  header = layout.root === '' ? '' : HEADER(layout.root) + noteLine(layout.note)
  return header + body + '\n\n' + KEY_PRELUDE(refs...)
```

- 现有结构是 `TOOL_PRELUDE` 由每个 prompt（`upstreamPrompt` / `SUMMARIZE_PROMPT`）自己拼在最前，`buildPrompt` 只追加 `KEY_PRELUDE`；**不要**在 `buildPrompt` 里再拼一次，否则重复。
- `upstreamPrompt` 与 `SUMMARIZE_PROMPT` 内部对 `TOOL_PRELUDE` 调 `mapArtifactPaths(TOOL_PRELUDE, root)`。
- `HEADER(root)` 用 `root` 的展示值（`'.feynman/'`）。
- `WORKFLOWS[kind].prompt` 内部若再拼接静态文本（log/summarize），必须先 map 或直接用 `artifactDir`。
- 禁止对**已经拼好**的字符串再次调用 `mapArtifactPaths`（会把用户输入的路径改掉，违反 I2）。

---

## 7. `init` 行为

### 7.1 语法

```
/feynman init [--root <. | .feynman>] [--track | --no-track]
```

- 参数可任意顺序；不接受位置参数。
- 重复/冲突（两次 `--root`、同时 `--track` 与 `--no-track`、未知 flag）→ `kind: 'error'`，文本：

  ```
  Usage: /feynman init [--root <.|.feynman>] [--track | --no-track]
  ```

- `--root` 值非法 → 错误文本见 §9.3。
- 既有 `init extra` 报错行为保持（任何位置参数都报错）。

### 7.2 root 选择

1. 显式 `--root` → 使用（`source: 'flag'`）。
2. 无显式：marker 合法 → 用 marker（`'marker'`）。
3. 无 marker：旧布局特征命中 → `''`（`'legacy'`），并提示 `Pass --root .feynman to convert this project.`
4. 否则 → `.feynman`（`'default'`）。

### 7.3 跟踪选择

```
if 显式 --track / --no-track: tracking = 该值
else if readManagedBlock(<cwd>/.gitignore) != null: tracking = 'no-track'  # 我方 block 存在即保持
else if checkIgnore(probePath).ignored: tracking = 'no-track'              # 已有外部忽略规则
else if marker 存在: tracking = 'track'                                    # 保持现状
else: tracking = 'no-track'                                                # 新项目缺省
```

先看 managed block 再看 marker，避免「某个目录被安全阀跳过 → 探测不到忽略 → 回退成 track → 删掉 block」的翻转。

- `probePath`：root `.feynman` → `.feynman/outputs/.probing`；root `''` → `outputs/.probing`。
- 非 git 仓库/ git 不可用 → 不改 ignore，不报错，`git.status` 说明原因。
- `tracking === 'no-track'`：已有我方 block → 按需改写；没有 block 但 `probePath` 已被**外部规则**忽略 → 不新建 block（`git.action: 'none'`，`detail` 说明 `already ignored`）；否则新建 block。`'track'` → 移除我方 managed block（若存在），若移除后仍被外部规则忽略则 warning。
- managed block 内容：

  | root | tracking | block 行 |
  |---|---|---|
  | `.feynman` | no-track | `.feynman/` |
  | `.feynman` | track | （无 block） |
  | `''` | no-track | `outputs/`、`papers/`、`notes/`、`experiments/`、`.feynman/`（四个产物目录全被安全阀跳过时，连 `.feynman/` 也不写） |
  | `''` | track | （无 block） |

- managed block 写入 **`<cwd>/.gitignore`**（不存在则创建）；不向上寻找仓库根，git 对子树同样生效。
- 若 no-track 但安全阀把所有行都跳过（目录全是用户的）：**不创建空 block**，`git.action: 'none'`，并给出 warning。
- **根布局安全阀**：root 为 `''` 且 no-track 时，对四个目录逐个判断——`marker.ownedDirs` 已记录（由 init 创建，视为我们的）直接忽略；`marker.skippedDirs` 已记录则直接跳过（不再看特征，因为首次运行可能已在该目录里创建了插件状态）；否则 `listTracked(dir)` 非空，**或**目录在 init 创建前已存在且递归至少有一个文件，且不含 Feynman 特征（`outputs/.plans`、`outputs/.drafts`、`notes/session-logs/README.md`、`autoresearch.*`）时，才跳过该行并在 `warnings` 说明（`outputs/ already has content; not ignoring it`）。结果分别写回 `ownedDirs`/`skippedDirs`，保证第二次运行保持同一判断。评估必须发生在**任何目录创建之前**；`.feynman/` 是插件自有目录，不需要此检查。
- ignore 相关失败（`.gitignore` 只读、block 截断、fs 错误）是**非致命 warning**：`git.status: 'error'`、`git.action: 'none'`、`detail` 说明，`init` 仍 `kind: 'success'`；核心脚手架文件（目录、marker、模板）失败才是命令错误（R4.3.4）。
- 写完后必须 `checkIgnore` 复核**实际写入 block 的目录**：
  - 期望 ignored 而实际未 ignored（父仓库/全局 excludes/权限）→ `warnings` 追加 `git ignore did not take effect (see git check-ignore -v)`，并在 `doctor` 展示原始行。
  - 因安全阀被跳过的目录不参与复核。
  - `--track` 时若产物路径仍 ignored → 同样警告。
- `.feynman/.gitignore` 无论哪种 tracking 都存在（缓存双保险）。

### 7.4 既有 marker 非法

- 无论是否给 `--root`：`init` 返回错误 `The .feynman/project.json file is not valid; fix or delete it before running init.`，不创建/不覆盖任何文件（校验发生在所有写操作之前）。该文案里的 `.feynman/project.json` 由 `MARKER_DIR`/`MARKER_FILE` 拼接，输出逐字一致但代码不含字面量。
- 工作流仍按 R2 回退并在 brief header 给出 `Note:`，不受 `init` 拒绝影响。

### 7.5 返回与文案

`describeScaffold` 输出（语义结构，测试断言子串）：

```
Feynman project: artifact root .feynman/ (source: default); git: ignored (.gitignore managed block created).
created: .feynman/project.json, .feynman/outputs/.plans/, ...
kept: AGENTS.md
changed: .gitignore
warnings: ...
```

- `artifact root` 标签：`.feynman/` 或 `.`（root `''` 时写 `.`）。
- `git:` 取值：`ignored` / `tracked` / `not a repository` / `git unavailable`。
- `changed` 只列出内容确实被改写的受管文件：根 `.gitignore`（managed block 新建/更新/移除）、`<MARKER_DIR>/.gitignore`（补 `CACHE_IGNORE` 行）、`<MARKER_DIR>/<MARKER_FILE>`（root 值变化）。目录创建计入 `created`。

---

## 8. 兼容与迁移

- R8.1 旧布局只读兼容：`/outputs`、`status`、`doctor` 会列出根目录遗留产物；插件不移动它们。
- R8.2 不提供 `--migrate`。若用户手工移动文件，插件在下一次运行按 marker/legacy 规则自然收敛。
- R8.3 解析优先级保证：已存在 `outputs/.plans` 的项目在无 marker 时继续写根目录（不劈叉）。
- R8.4 `init` 已存在 marker 时不会因为"旧布局特征仍在"而改回根布局——marker 永远优先。
- R8.5 `fetch/` 路径与语义不变；旧缓存继续可用。
- R8.6 旧版本写在项目根的 `autoresearch.md` / `autoresearch.jsonl` / `autoresearch.sh`：新模板检查的是 `<root>/experiments/autoresearch.*`，两种布局都不会再自动识别这些旧文件为续跑状态；需要续跑就手工移入 `<root>/experiments/`。

---

## 9. 文案（逐字）

以下文案里的 `.feynman` 路径一律由 `MARKER_DIR`/`MARKER_FILE` 拼接：输出与本文逐字一致，代码里不出现字面量。

### 9.1 `init` 用法错误

```
Usage: /feynman init [--root <.|.feynman>] [--track | --no-track]
```

### 9.2 非 git 回执

```
git: not a repository (ignore rules unchanged)
```

### 9.3 `--root` 非法

```
Only `.` and `.feynman` are supported for --root.
```

### 9.4 工作流回执

```
/feynman <kind> workflow started. Output lands in .feynman/outputs/.
```

（root `''` 时：`Output lands in outputs/.`）

### 9.5 旧 `AGENTS.md` 告警（仅 root 不为 `''` 时）

```
AGENTS.md exists and still describes the project-root layout. Merge .feynman/AGENTS.template.md into it, or delete the outdated artifact section.
```

### 9.6 persona 的 `Artifacts:` 段（新）

```
                Artifacts:
                - Deliver one canonical Markdown artifact per workflow unless the user asks for more. Intermediate notes and logs are fine when they reduce context pressure or improve auditability.
                - Artifact paths in a workflow brief are authoritative and already resolved; write them exactly as given. Skills may spell paths as `<artifact-root>/…` or `$ARTIFACT_ROOT/…`; resolve the placeholder from the marker before use. The project artifact root is recorded in `.feynman/project.json` and defaults to `.feynman/`; when no path is given, resolve `outputs/`, `papers/`, `notes/`, and `experiments/` under that root. Experiment code, session state, and logs live under the artifact root's `experiments/` directory like every other research artifact; keep the project root clean.
                - `grep` from the workspace root does not search hidden directories; pass the artifact root as `path` when searching for artifacts.
                - Verify the artifact exists on disk before the final response. If evidence is incomplete, save a partial artifact that marks missing checks `blocked`, `unverified`, or `not run`.
```

（其余 persona 行不动。）

### 9.7 `/outputs` 提示（语义）

```
List research artifacts under <root>/{outputs,papers,notes,experiments} when present (group by workflow: <slug>.md deepresearch/lit, *-comparison.md compare, *-review.md review, *-audit.md audit, *-replication-plan.md replicate, *-recipe.md recipe, *-draft.md draft, *-summary.md summarize). Also list any legacy root outputs/, papers/, notes/; list a project-root experiments/ only when it contains `autoresearch.*`, not when it is the repository's own code directory. Use ls -a, exact paths, or glob; grep from the workspace root skips hidden directories. One line per artifact with its path; no raw source bodies.
```

---

## 10. 非目标

- 不迁移既有产物；不写 `--migrate`。
- 不按仓库类型自动探测布局。
- 不开放任意 root（仅 `.` / `.feynman`）。
- 不改 `fetch/` 路径；不改 Docker skill 里的 `results/` 示例（它只是示例命令，不是插件写入口）。
- 不改 `AGENTS.md` / `CHANGELOG.md` 的研究记忆语义（Step 2）。
- 不把 `/outputs` 改成确定性实现。
- 不改 `feynman_workflow` 的参数 schema。
- 不改上游 workflow 模板文本。

---

## 11. 实施阶段与写入范围

按顺序执行；每阶段结束跑该阶段测试。写范围用于并行/审阅时切分。

| 阶段 | 内容 | 写入范围 |
|---|---|---|
| A | `project-paths` + `project-git` 及其单测 | `lib/project-paths.js`、`lib/project-git.js`、`tests/project-paths.test.js`、`tests/project-git.test.js` |
| B | `init`：scaffold、命令参数、回执 | `lib/init-scaffold.js`、`index.js`（init/sessionHandlers）、`tests/init-scaffold.test.js`、`tests/commands.test.js`（init 段） |
| C0 | 记录 0.24.0 基线 → 锚定 autoresearch 路径（R4.12）→ 记录新基线 → 更新 `tests/commands.test.js` 的 frozen digest（必须在改 `prompts.js` 之前） | `experiments/capture-prompt-fixtures.mjs`、`tests/fixtures/prompt-hashes-024.json`、`tests/fixtures/prompt-hashes.json`、`tests/prompts.test.js`（T-REG-01/02）、`tests/commands.test.js`（digest 常量）、`resources/workflows.json`（仅 autoresearch 文本）、`resources/skills/feynman-autoresearch.md` |
| C | prompt 渲染、workflow tool、source-check、命令文案 | `prompts.js`、`lib/workflow-tool.js`、`lib/source-check.js`、`index.js`（其余 handler/文案）、`lib/client.js`（SUBCOMMANDS 文案）、`tests/commands.test.js`、`tests/prompts.test.js`、`tests/client.test.js` |
| D | persona 与其余 skills 文案 | `cordis.patch.yml`、`resources/skills/*.md`（除 C0 已改的 `feynman-autoresearch.md`） |
| E | evals 布局支持 | `evals/run.mjs`、`evals/score.mjs`、`evals/README.md` |
| F | 文档、版本、验收 | `README.md`、`RELEASES.md`、`docs/upstream-20261013.md`、`package.json` |

B 与 C 都改 `index.js` 与 `tests/commands.test.js`，必须串行（先 B 后 C）。

---

## 12. 风险与触发条件（实施时检查）

| 风险 | 检查点 |
|---|---|
| 映射改写用户输入 | C 阶段 fixture：`/feynman deepresearch "outputs/ 目录怎么设计"`、summarize `"papers/my study.pdf"` 断言原样 |
| 模块级常量/加载期映射冻结布局 | C 阶段断言：同一进程内先后以 `''` 与 `.feynman` 渲染，结果各自正确（覆盖 `LOG_BRIEF`；任何 `mapArtifactPaths` 调用不得在模块加载期发生） |
| `grep` 假阴性 | brief header 与 `/outputs` 提示都在；T-PROMPT-09 / T-CMD-07 断言 |
| autoresearch 裸文件仍在项目根 | R4.12 + T-PROMPT-14 |
| 根目录既有 `experiments/` 被当作插件目录 | R4.1 的 legacy 规则 + T-PATH-29 |
| 忽略规则静默失效 | `init` 写后复核；`doctor` 展示 `check-ignore -v` |
| 旧项目劈叉 | R2 的 legacy 特征 + T-PATH-21 |
| `experiments/` 被误映射或误判为旧布局 | T-PATH-05 表格行 + T-PROMPT-03 + T-PATH-29 |
| 根布局把用户目录藏掉 | T-INIT-19 / T-INIT-22（tracked 与非空目录安全阀） |
