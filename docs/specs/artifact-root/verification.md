# Verification: 项目级 artifact root（`.feynman/`）

配套：[spec.md](spec.md)、[review.md](review.md)。测试编号 `T-*` 与 spec 的 `R*` 对应。

## 0. 环境与约定

- 运行：`bun test`（默认）与 `node --test tests/*.test.*`（兼容性）。
- 每个涉及文件系统的用例使用独立临时目录（`mkdtemp`），不写仓库工作区。
- git 用例在临时目录 `git init`，不配置身份、不提交（除非用例明确需要）。
- 断言路径一律用 POSIX 分隔符（测试在 Windows 上也应通过）。
- 新增测试文件：`tests/project-paths.test.js`、`tests/project-git.test.js`、`tests/init-scaffold.test.js`、`tests/prompts.test.js`（T-PROMPT-* 与 T-REG-*）、`tests/static.test.js`（T-STATIC-*）。现有 `tests/commands.test.js`、`tests/research.test.js`、`tests/evals.test.js` 补命令/工具/eval 用例与 frozen digest。
- "不含裸 `outputs/`" 一律用正则 `(?<![\w./-])(outputs|papers|notes|experiments)/` 断言（`.feynman/outputs/` 会包含子串 `outputs/`，普通 `includes` 会假失败）。
- 现有 `tests/commands.test.js` 的 init 用例在仓库 `.scratch/`（父级 `.gitignore` 忽略）内运行：改为 `os.tmpdir()`，并更新 `created` 断言（新增 `.feynman/project.json`、`.feynman/AGENTS.template.md`、`<root>/...` 目录）。
- `tests/evals.test.js` 的 `fixture()` 会创建 `outputs/.plans` 与 `.drafts`，按 legacy 解析为根布局，改动后应继续通过；若将来移除这些标记，必须在 fixture 里写 `.feynman/project.json`。

---

## 1. 单元测试矩阵

### 1.1 `lib/project-paths.js`

| ID | 用例 | 期望 |
|---|---|---|
| T-PATH-01 | `normalizeRoot`：`'.'`、`'./'`、`''` | `''` |
| T-PATH-02 | `normalizeRoot`：`'.feynman'`、`'.feynman/'` | `'.feynman'` |
| T-PATH-03 | `normalizeRoot`：`'..'`、`'.git'`、`'/abs'`、`'C:\\x'`、`'cache'` | `null` |
| T-PATH-04 | `normalizeRoot` 空白：`' .feynman '` | `null`（不做 trim；错误值宁可拒绝） |
| T-PATH-05 | `mapArtifactPaths` 覆盖 R3.5 全部行 | 逐行相等 |
| T-PATH-06 | 幂等：对映射结果再映射 | 不变 |
| T-PATH-07 | `artifactDir('', 'outputs', '.plans')` | `'outputs/.plans'` |
| T-PATH-08 | `artifactDir('.feynman', 'outputs', '.notes')` | `'.feynman/outputs/.notes'` |
| T-PATH-09 | `artifactDir('.feynman', 'papers')` 不以 `./` 开头 | 断言 |
| T-PATH-10 | `artifactPath(relativeCwd, '.feynman', 'outputs')` 用相对 cwd 调用 | 返回绝对路径，无双前缀 |
| T-PATH-11 | `readMarker` 缺失 | `status: 'missing'` |
| T-PATH-12 | `readMarker` 合法 JSON | `status: 'present'` + 归一后的 root |
| T-PATH-13 | `readMarker` 坏 JSON | `status: 'invalid'` + `error` |
| T-PATH-14 | `readMarker` root 未知值（`'cache'`） | `status: 'invalid'` |
| T-PATH-15 | `detectLegacyLayout`：`outputs/.plans/` 存在 | `legacy: true`，evidence 含该路径 |
| T-PATH-16 | `detectLegacyLayout`：`outputs/.drafts/` | 同上 |
| T-PATH-17 | `detectLegacyLayout`：`papers/x.provenance.md` | 同上 |
| T-PATH-18 | `detectLegacyLayout`：`notes/session-logs/README.md` | 同上 |
| T-PATH-19 | `detectLegacyLayout`：只有 `outputs/build.js`（非 Feynman 特征） | `legacy: false` |
| T-PATH-20 | `resolveLayout`：marker `.` 且存在 `outputs/.plans` | root `''`，source `'marker'` |
| T-PATH-21 | `resolveLayout`：无 marker + legacy 特征 | root `''`，source `'legacy'` |
| T-PATH-22 | `resolveLayout`：无 marker + 无特征 | root `'.feynman'`，source `'default'` |
| T-PATH-23 | `resolveLayout`：坏 marker + 无特征 | root `'.feynman'`，source `'default'`，detail 含错误 |
| T-PATH-24 | `legacyArtifacts`：统计三个旧目录（outputs/papers/notes）的文件数 | 数字正确；`present` 只含存在项；不含 experiments |
| T-PATH-25 | `workspaceRoot`：`workingDirectory` 服务返回值优先 | 用服务值 |
| T-PATH-26 | `workspaceRoot`：服务缺失时回退 `header.cwd` | 用 header 值 |
| T-PATH-27 | `workspaceRoot`：相对 cwd | `resolve` 后的绝对路径 |
| T-PATH-28 | `workspaceRoot`：无 ctx、无 session | `undefined`，不抛错 |
| T-PATH-29 | 根目录只有用户自带的 `experiments/`（无 Feynman 特征） | `detectLegacyLayout` 为 false；`legacyArtifacts` 不含 experiments |
| T-PATH-30 | `layoutLabel('')` / `layoutLabel('.feynman')` | `'.'` / `'.feynman/'` |
| T-PATH-31 | `mapArtifactPaths('Create `.plans` and `outputs`.', '.feynman')` | `` `outputs` `` → `` `.feynman/outputs` ``；普通 prose 单词 `outputs` 不变 |

### 1.2 `lib/project-git.js`

| ID | 用例 | 期望 |
|---|---|---|
| T-GIT-01 | 临时 git 仓库 | `isWorkTree` → `ok: true` |
| T-GIT-02 | 非仓库临时目录 | `ok: false` |
| T-GIT-03 | 子目录（仓库内） | `ok: true` |
| T-GIT-04 | PATH 指向空目录的子进程调用 `isWorkTree` | `ok: false, reason: 'git-not-found'`（用 `process.execPath` 起子进程，`env: { ...process.env, PATH: <empty dir> }`；空字符串 PATH 在 glibc 下会回退到默认搜索路径，测不住） |
| T-GIT-05 | `checkIgnore`：`.gitignore` 含 `.feynman/`，探测 `.feynman/outputs/.probe` | `ignored: true`，source 含规则 |
| T-GIT-06 | `checkIgnore`：未忽略路径 | `ignored: false` |
| T-GIT-07 | `checkIgnore`：不存在的路径也能判定 | 不抛错 |
| T-GIT-08 | `listTracked`：已提交/已 add 的文件 | 返回相对路径数组 |
| T-GIT-09 | `readManagedBlock`：无 block | `null` |
| T-GIT-10 | `readManagedBlock`：完整 block | 起止行（0-based）与行内容正确 |
| T-GIT-11 | `readManagedBlock`：只有 START | 识别为截断（返回对象含 `truncated: true` 或由 `writeManagedBlock` 报错） |
| T-GIT-12 | `writeManagedBlock`：文件不存在 | 创建，`action: 'created'`，内容精确 |
| T-GIT-13 | `writeManagedBlock`：已有内容但无 block、末尾无换行 | 追加且保留原文逐字节；中间恰一个空行 |
| T-GIT-14 | `writeManagedBlock`：更新既有 block | block 外内容逐字节不变；`action: 'updated'` |
| T-GIT-15 | 重复写入相同内容 | `action: 'unchanged'`，文件 mtime 不变（或内容相同即可） |
| T-GIT-16 | block 被截断 | 返回 `error: 'truncated'`，文件不修改 |
| T-GIT-17 | `removeManagedBlock` | 只删我方 block，外部内容不变，多余的连续空行被收敛 |
| T-GIT-18 | CRLF 文件 | 插入行使用 CRLF；既有内容不混合换行 |
| T-GIT-19 | 空文件 | 只写 block，无多余空行 |
| T-GIT-20 | negation：`.gitignore` 为 `outputs/*` + `!outputs/keep.txt` | `checkIgnore(keep.txt)` → `ignored: false`（pattern 以 `!` 开头）；`checkIgnore(other.txt)` → `ignored: true` |
| T-GIT-21 | block 前后都有内容 | 更新/移除后 block 外字节不变，接缝空行折叠正确 |

> `writeManagedBlock` 的 remove 语义在 spec R7.3（track 模式移除 block）中需要；实现可提供 `removeManagedBlock(file)` 或 `writeManagedBlock(file, [])`，测试按实现选择其一，spec 同步。

### 1.3 `lib/init-scaffold.js`

| ID | 用例 | 期望 |
|---|---|---|
| T-INIT-01 | 非 git 空目录，默认参数 | 创建 `.feynman/project.json`、`.feynman/.gitignore`、`.feynman/AGENTS.template.md`、`.feynman/outputs/{.plans,.drafts,.notes}`、`.feynman/papers`、`.feynman/notes/session-logs/README.md`、`AGENTS.md`；不创建根目录 `experiments/`，也不预创建 `.feynman/experiments/` |
| T-INIT-02 | 非 git 目录同参数第二次执行 | `created: []`、`changed: []`、`git.status: 'not-a-repo'`、`git.action: 'none'` |
| T-INIT-02b | git 仓库同参数第二次执行 | `created: []`、`changed: []`、`git.action: 'unchanged'` |
| T-INIT-03 | `project.json` 内容 | `{version:1, artifactRoot:'.feynman'}`，末尾换行 |
| T-INIT-04 | `.feynman/.gitignore` | 含 `fetch/` |
| T-INIT-05 | `AGENTS.md` 模板渲染 | 含 `.feynman/outputs/`、`.feynman/notes/`、`.feynman/papers/`、`.feynman/experiments/`；不含裸 `outputs/`、`experiments/` 前缀 |
| T-INIT-06 | 已存在 `AGENTS.md` | `kept` 含 AGENTS.md；创建/保留 `.feynman/AGENTS.template.md`；根文件内容不变；重复执行 created 为空 |
| T-INIT-07 | 旧模板 `AGENTS.md`，root `.feynman` | `warnings` 含 §9.5 文案；root `''` 时无此告警 |
| T-INIT-08 | 已存在 `notes/session-logs/README.md` | kept，不覆盖 |
| T-INIT-09 | git 仓库默认参数 | managed block = `.feynman/`；`checkIgnore(.feynman/outputs/.probe)` 为 true |
| T-INIT-10 | `--track` | 无 block（`action: 'removed'`）；`.feynman/outputs/.probe` 未忽略；`.feynman/fetch/x` 仍被忽略 |
| T-INIT-11 | `--track` 后再 `--no-track` | block 恢复；幂等 |
| T-INIT-12 | `--root .` | 根目录 `outputs/{.plans,.drafts,.notes}`、`papers`、`notes/session-logs`；marker `.` |
| T-INIT-13 | 非 git 仓库 | `git.status: 'not-a-repo'`；`.gitignore` 未创建/未改 |
| T-INIT-14 | marker 已存在 `.`，无参数 | root 保持 `''`，source `'marker'` |
| T-INIT-15 | 坏 marker JSON | 返回错误（spec §7.4），文件未被覆盖，且不发生其它写入 |
| T-INIT-16 | `.feynman` 为符号链接（解析到工作区内） | `warnings` 提示；流程不失败。解析到工作区外 → `error`，不写入 |
| T-INIT-16b | 四个产物目录之一（如 `outputs`）是指向工作区外的符号链接 | `error`，不写入 |
| T-INIT-17 | root 为相对路径传入 | 正常完成，展示路径正确 |
| T-INIT-18 | `.feynman/experiments/` 不预创建 | 断言两种布局都不创建 |
| T-INIT-19 | 根布局 + 已跟踪 `outputs/foo.txt` | no-track 时跳过 `outputs/` 行并 warning；其余目录照常 |
| T-INIT-20 | 根布局 + `outputs/.plans`（本插件的） | 允许忽略 `outputs/` |
| T-INIT-21 | `--root .` 在 git 仓库（空目录） | block 为五行 `outputs/`、`papers/`、`notes/`、`experiments/`、`.feynman/` |
| T-INIT-22 | 根布局 + 未跟踪但非空的 `experiments/foo.py` | 跳过 `experiments/` 行并 warning（不隐藏用户的 WIP） |
| T-INIT-23 | `.feynman` 是普通文件 | 返回错误、附已完成项；不崩溃 |
| T-INIT-24 | 根 `.gitignore` 是目录 | `kind: 'success'` + warning（`git.status: 'error'`），其余步骤完成；不崩溃 |
| T-INIT-25 | 根布局四个目录都是用户内容 | 不创建空 block；`git.action: 'none'` + warning；不隐藏用户目录 |
| T-INIT-26 | 根布局连续执行两次默认 init | 第二次 `created: []`、block 仍是同样五行、`git.action: 'unchanged'`（防安全阀把自建目录误判为用户目录） |
| T-INIT-27 | 已有外部规则忽略 `.feynman/`（无我方 block） | `git.action: 'none'`，不重复追加 block；`--track` 时给出 "still ignored" warning |
| T-INIT-28 | 根布局 + 用户自有 `outputs/build.js`，连续两次 init | 两次都跳过 `outputs/`；marker 记 `skippedDirs:['outputs']`、`ownedDirs` 不含 outputs；block 不含 `outputs/` |
| T-INIT-29 | 根布局空仓库 init 后写 `papers/draft.md`，再 init | `papers/` 仍在 block；无 `papers/` warning；`ownedDirs` 含 papers |
| T-INIT-16c | 默认 `.feynman` 布局：根 `outputs` 为越界符号链接 | 不被误判，init 成功；`.feynman/outputs` 为越界符号链接时拒绝 |

### 1.4 `prompts.js`

| ID | 用例 | 期望 |
|---|---|---|
| T-PROMPT-01 | 12 个 workflow，root `''` | 与 fixture hash 一致（T-REG-01） |
| T-PROMPT-02 | deepresearch，root `.feynman` | 含 `.feynman/outputs/<slug>.md`、`.feynman/outputs/.plans/<slug>.md`；无裸 `outputs/`、`papers/`、`notes/` |
| T-PROMPT-03 | `log` 模板，root `.feynman` | 四个目录（含 `experiments/`）全部加前缀；无裸前缀（用 §0 的正则） |
| T-PROMPT-04 | deepresearch 主题含 `outputs/ 目录怎么设计` | 主题子串原样出现 |
| T-PROMPT-05 | review 目标 `papers/2401.12345.pdf` | 原样 |
| T-PROMPT-06 | summarize `"papers/my study.pdf"` | source 原样；产物路径在 `.feynman/outputs/` 下 |
| T-PROMPT-07 | log，root `.feynman` | 产物路径 `.feynman/notes/...`；无裸 `notes/` |
| T-PROMPT-08 | 同一进程先 root `''` 再 root `.feynman` 渲染 log/deepresearch | 两次结果各自正确（模块常量冻结回归） |
| T-PROMPT-09 | header | root `.feynman` 时首段含 `Artifact root: .feynman/` 与 `path: ".feynman"`；root `''` 时无 header |
| T-PROMPT-10 | TOOL_PRELUDE | root `.feynman` 时 source_check 路径被映射 |
| T-PROMPT-11 | `layout.note` 非空 | header 追加 `Note: <note>` 行 |
| T-PROMPT-12 | 映射后不含 `/.feynman/.feynman/` | 无双前缀 |
| T-PROMPT-13 | `TOOL_PRELUDE` 在 brief 中只出现一次 | 计数为 1（防 buildPrompt 重复拼接） |
| T-PROMPT-14 | autoresearch，root `.feynman` | 含 `.feynman/experiments/autoresearch.md`、`.jsonl`、`.sh`；resume 检查行也是该路径；无裸 `autoresearch.*`（用 `(?<![\w./-])autoresearch\.` 断言） |
| T-PROMPT-15 | log，root `.feynman` | “artifacts written to …” 句中四个目录全部映射，含 `experiments/` |
| T-PROMPT-16 | 回归（T-REG-02） | 与 `prompt-hashes-024.json` 相比，除 `autoresearch` 外无差异；`autoresearch` 仅多 6 个 `experiments/` 前缀、无裸文件路径 |

### 1.5 命令层（`tests/commands.test.js`）

| ID | 用例 | 期望 |
|---|---|---|
| T-CMD-01 | `init --root cache` | error，文本 §9.3 |
| T-CMD-02 | `init --track --no-track` | error，usage |
| T-CMD-03 | `init --root . --root .feynman` | error，usage |
| T-CMD-04 | `init extra` | error，usage（保持现状） |
| T-CMD-05 | 工作流回执 root `.feynman` | `Output lands in .feynman/outputs/.` |
| T-CMD-06 | 工作流回执 root `''` | `Output lands in outputs/.` |
| T-CMD-07 | `/outputs` 提示 | 含 `.feynman/outputs`、`.feynman/experiments`、旧布局说明、`grep` 注意事项 |
| T-CMD-08 | `status` 无遗留 | 含 `Artifact root:`、`Git:`；无 `Legacy artifacts` |
| T-CMD-09 | `status` 有遗留 `outputs/` | 含 `Legacy artifacts: outputs/` |
| T-CMD-10 | `doctor` | 含 marker 状态与 `git check-ignore` 行 |
| T-CMD-11 | `feynman_source_check`（mock web/fetch） | 写盘到 `<root>/outputs/`，返回绝对路径 |
| T-CMD-12 | 插件 systemPrompt 段 | 含 `project artifact root`，不含裸 `outputs/<slug>-source-check.md` |
| T-CMD-13 | `feynman_source_check` 工具描述（schema-only 构造） | 含 `project artifact root`；构造时不触发 fs/git |
| T-CMD-14 | `help` 与 `SESSION_COMMANDS` 描述 | init 提及 artifact root/参数；outputs 不再写 "experiments/ stays at the project root" |
| T-CMD-15 | `lib/client.js` 的 SUBCOMMANDS | init 行提及 artifact root（实现为 T-STATIC-04；id 集合仍由 `tests/client.test.js` 的 picker 用例覆盖） |
| T-CMD-16 | 无 cwd 的工作流命令 | 回执 `Output lands in outputs/.`；brief 无 header |

### 1.6 工具层

| ID | 用例 | 期望 |
|---|---|---|
| T-TOOL-01 | `createWorkflowTool(refs, resolveRoot)` 在带 `.feynman` marker 的会话执行 | instructions 含 `.feynman/outputs/`；无 cwd 时退回 root `''`（无 header） |
| T-TOOL-02 | 工具描述 | 含 "project artifact root"；不出现手写 `.feynman` 字面量（由常量拼接，可用 T-STATIC-02 覆盖） |

### 1.7 evals

| ID | 用例 | 期望 |
|---|---|---|
| T-EVAL-01 | `buildTask(workflow, question, 'upstream')`（从 run.mjs 导出） | 写/使用 marker `.`；task 无 header；结果行 `layout: 'upstream'` |
| T-EVAL-02 | `buildTask(..., 'feynman')` | task 含 `.feynman/outputs/` 与 header；`layout: 'feynman'` |
| T-EVAL-03 | `score.mjs`：`.feynman` workdir | 找到 `.feynman/outputs/<slug>.md`，`done: 1` |
| T-EVAL-04 | `score.mjs`：旧 workdir（根 `outputs/`，无 marker） | 按 legacy 解析，`done: 1` |
| T-EVAL-05 | `score.mjs`：marker `.feynman` 但产物写在根 `outputs/` | `done: 0`（不得 read-both 得分） |

---

## 2. 集成 / 端到端（临时 git 仓库）

脚本化验收（可写成 `experiments/artifact-root-e2e.mjs`，不进入发布包）：

1. `mktemp -d` + `git init`；放 `README.md`、`.gitignore`（含一行注释）与 `AGENTS.md`，然后 `git add` 三者（**不提交**，避免身份配置）。
2. 调 `scaffoldProject(cwd)`：
   - 断言 `git status --short` **不出现** `.feynman/`、`outputs/`、`papers/`、`notes/`；
   - `git check-ignore -v .feynman/outputs/.probe` 命中我方 block；
   - `AGENTS.md` 在 status 中仍是未修改的已暂存项（`A  AGENTS.md`）。
3. 调 `scaffoldProject(cwd, { tracking: 'track' })`：
   - `git status --short` 出现 `.feynman/`（未跟踪）；
   - `check-ignore .feynman/fetch/x` 仍为 true（嵌套 `.gitignore`）。
4. 调 `scaffoldProject(cwd)`（无参数保留状态）：
   - 仍为 track，不被回退成 ignored（幂等性）。
5. `scaffoldProject(cwd, { root: '.', tracking: 'no-track' })`：
   - 四个目录都被忽略（`experiments/` 无受跟踪文件时）；`AGENTS.md` 保持原样；
   - `AGENTS.md` 保持原样。
6. 相对 cwd：`scaffoldProject(relativePathFromCwd)` 正常。
7. 非 git 目录：不创建/不修改 `.gitignore`。

---

## 3. 回归 fixture（必须在改 `prompts.js` 之前生成）

- 新增 `experiments/capture-prompt-fixtures.mjs`：用固定输入渲染 12 个 workflow（含 `summarize` 的参数组合），对 root `''` 的输出取 `sha256`。要记录两份：
  1. `tests/fixtures/prompt-hashes-024.json`：改动任何模板**之前**的 0.24.0 基线；
  2. `tests/fixtures/prompt-hashes.json`：按 R4.12 锚定 autoresearch 路径之后、加入渲染映射之前的基线。

  ```json
  { "deepresearch": "…", "lit": "…", "review": "…", "review-loop": "…", "audit": "…",
    "replicate": "…", "recipe": "…", "compare": "…", "draft": "…", "autoresearch": "…",
    "log": "…", "summarize": "…" }
  ```

- 固定输入（写进脚本，避免漂移）：

  | workflow | 输入 |
  |---|---|
  | deepresearch | `mechanistic interpretability` |
  | lit | `retrieval augmented generation` |
  | review | `2401.12345` |
  | review-loop | `2401.12345` |
  | audit | `https://github.com/owner/repo` |
  | replicate | `2401.12345` |
  | recipe | `fine-tune a 7B model on 8 GPUs` |
  | compare | `vLLM vs SGLang` |
  | draft | `efficient attention` |
  | autoresearch | `improve MMLU by 2 points` |
  | log | `''` |
  | summarize | `papers/long report.pdf --window-size 4000 --overlap 100 --tier1-threshold 5000 --tier2-threshold 20000` |

- 生成步骤：在 Phase A/B 完成后、Phase C 修改 `prompts.js` 之前执行一次；把 fixture 与改动一起提交（沿用 eval 规则）。
- 另有一个已存在的 frozen digest：`tests/commands.test.js`（`DIGEST_ARGS` + digest 常量，约 :596-625）对全部 brief 做整体哈希。R4.12.1 会改变 `autoresearch` 的文本，C0 必须**有意**更新该 digest 并在提交说明写明原因；它的输入与本文件的 fixture 输入不同，两者互不替代。
- T-REG-01/02 放在新建的 `tests/prompts.test.js`。
- 测试 `T-REG-01`：Phase C 之后重算 hash，与 `prompt-hashes.json` 全部一致。
- 测试 `T-REG-02`：与 `prompt-hashes-024.json` 相比，除 `autoresearch` 外全部一致；`autoresearch` 的 root `''` 输出必须包含 6 处 `experiments/` 前缀（resume 行 `.md`/`.jsonl`、初始化行 `.md`/`.jsonl`/`.sh`、报告行 `.jsonl`），且不存在不带 `experiments/` 前缀的裸 `autoresearch.md|.jsonl|.sh`。任何其它有意修改都必须在提交说明里写明并更新基线。

---

## 4. evals 协议

- 代码改动前后使用同一模型、同一批 id：`--ids q01,q04 --workflow lit`。
- 两次分别跑 `--layout upstream` 与 `--layout feynman`，比较 `done`、`plan`、`provenance_fields`、`cites/valid/recall`、路径列。
- 通过标准：两种布局 `done = 1`，产物路径与 `layout` 一致；`feynman` 布局下不存在根目录 `outputs/` 写入。
- 若模型把产物写错根：先修 prompt（header/具体路径），不得改评分器让步。
- 结果文件（`evals/results/*.jsonl`）与 fixture 一起提交。

---

## 5. 静态检查

| ID | 检查 | 方法 |
|---|---|---|
| T-STATIC-01 | skills 无裸 `outputs/`、`papers/`、`notes/`、`experiments/` 前缀（含 preview 的 `$ARTIFACT_ROOT` 形式） | 测试读取 `resources/skills/*.md`，正则 `(?<![\w./-])(outputs|papers|notes|experiments)/` 不得命中（`<artifact-root>/` 写法除外）；`feynman-autoresearch.md` 的会话文件行必须是 `<artifact-root>/experiments/...` |
| T-STATIC-02 | 除 `lib/project-paths.js`（常量）与测试/fixture 外，代码不出现 `'.feynman/'` / `'.feynman'` 字面量 | `grep` 断言：`lib/*.js`（除 `project-paths.js`）、`index.js`、`prompts.js`、`evals/*.mjs` 命中数为 0（含 `lib/fetch-content.js` 与 `lib/content-store.js` 注释）；正则 `/(?<![\w./-])\.feynman(?=[/'\"\s])/`，URL `www.feynman.is` 不算命中 |
| T-STATIC-03 | persona 不再列死四个根目录 | 测试/审阅 `cordis.patch.yml` |
| T-STATIC-04 | README/RELEASES/upstream 文档已更新 | 人工清单（§6） |
| T-STATIC-05 | 导出模板常量与评审时逐字一致 | 仓库不再 vendored 上游 `project-scaffold.ts`，改为断言 `PROJECT_AGENTS_TEMPLATE`/`SESSION_LOGS_README` 的 `sha256` 与评审值一致（渲染只在写盘时发生） |

---

## 6. 手工验收清单

1. `bun test` 与 `node --test tests/*.test.*` 全绿。
2. 临时仓库跑 `/feynman init`：`git status` 无产物目录；`git check-ignore -v` 输出被回执复述。
3. 在临时仓库跑一次真实会话（DSH 加载插件）：`/feynman deepresearch "test topic"` 的 brief 首段含 `Artifact root: .feynman/`，产物落在 `.feynman/outputs/`；`/feynman outputs` 能列出。
4. `--root .` 项目：brief 与 0.24.0 一致（可用 fixture 对照）。
5. 旧项目（有 `outputs/.plans`）首次运行仍写根目录；`status` 报 `source: legacy`。
6. `README.md` 的 “Artifacts and layout” 段落与实现一致（tree、flags、gitignore 行为、grep 注意）。
7. `docs/upstream-20261013.md` 有 artifact location 分歧条目。

---

## 7. Definition of done

- [ ] spec §11 Phase A–F 全部完成，命令与文档同步。
- [ ] T-REG-01（root `''` 逐字节回归）通过。
- [ ] T-PATH / T-GIT / T-INIT / T-PROMPT / T-CMD / T-EVAL / T-STATIC 全部通过。
- [ ] 集成脚本 §2 在临时 git 仓库跑通，含 track 切换与幂等。
- [ ] evals 两种布局各至少 1 题跑通（需要 API key；无 key 时记录为未执行）。
- [ ] 无新增写入工作区外的路径（审阅 `resolve`/`join` 调用）。
- [ ] `experiments/` 在两种布局下都被映射；`.feynman/experiments/` 不被预创建；根目录不被插件创建 `experiments/`。
