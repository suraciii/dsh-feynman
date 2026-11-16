# 最终审查：项目级 artifact root（`.feynman/`）

- 日期：2026-11-16
- 审查对象：[spec.md](spec.md)、[verification.md](verification.md)、[分析稿](../../../outputs/artifact-root-20261116.md)
- 方法：实现侧逐条走查 + 独立审查（另起 agent，只读代码与 spec）+ 实测 git/ripgrep/DSH 行为
- 结论：**初版不能直接实施；3 个阻塞问题、8 个实施级缺口、若干测试/文档矛盾已全部修进 spec/verification。现在可以按 §11 阶段开始。**

---

## 1. 阻塞级（已修）

### B1 安全阀与目录创建顺序自相矛盾

- 现象：R4.3.2 先创建 `outputs/{.plans,.drafts,.notes}` 与 `notes/session-logs/README.md`，再评估 ignore 安全阀。于是 `notes/` 在评估时"已存在且非空"，而特征列表里没有它 → 跳过 `notes/`；`outputs/` 也因含三个子目录被当成非空 → 跳过。T-INIT-21 要求的五行不可满足；第二次 `init` 会把自建目录全判成"用户的"，行集清空后按"空 lines 移除 block"处理 → I6 幂等被破坏。
- 处置：R4.3.2 改为**创建前快照**评估；"非空"定义为递归至少一个文件（空子目录不算）；特征列表加入 `notes/session-logs/README.md`；新增 T-INIT-26 覆盖根布局连续两次 `init`。

### B2 跟踪状态会从 no-track 翻成 track 并删除 block

- 现象：`probePath` 只探 `<root>/outputs/.probing`。若 `outputs/` 被安全阀跳过（用户目录），探测结果是"未忽略"；第二次无参数 `init` 走到 `marker 存在 → track`，于是 `removeManagedBlock`，把 `papers/`、`notes/`、`experiments/`、`.feynman/` 全部暴露给 git。
- 处置：§7.3 的判定顺序改为**先看我方 managed block**（存在即保持 no-track），再看外部忽略规则，最后才回退 marker/track。新增 T-INIT-26 复现。

### B3 `git check-ignore` 的 negation 语义被写反

- 实测：`.gitignore` 为 `outputs/*` + `!outputs/keep.txt` 时，`git check-ignore -v -- outputs/keep.txt` **exit 0**，输出 `!outputs/keep.txt`。原 spec 把 exit 0 一律当 ignored，probe 与写后复核都会误判。
- 处置：R4.2 明确"pattern 以 `!` 开头 → `ignored: false`"；同时从右往左解析 `source:line:pattern`（兼容 Windows 盘符），`execFileSync` 的 exit 1/128 捕获为正常结果。

---

## 2. 实施级缺口（已修）

| # | 发现 | 处置 |
|---|---|---|
| I1 | 现有 `tests/commands.test.js` 有 frozen digest（约 :596-625），R4.12.1 改 autoresearch 文本会使其失败；原计划未纳入 | C0 阶段明确更新 digest（有意变更、写提交说明）；T-REG fixture 与 digest 输入不同，互不替代 |
| I2 | `lib/client.js` 的 `SUBCOMMANDS` 是 `prompts.js` 的静态副本，裸命令 picker 会与 `help` 不一致；原写入范围没有它 | R4.7.10 + Phase C 纳入 `lib/client.js`；新增 T-CMD-15 |
| I3 | `.feynman/AGENTS.template.md` 只在"AGENTS.md 已存在"时写 → 首次运行创建 AGENTS.md，第二次才建模板，`created` 非空，违反 I6 | §5.4 改为**每次都写**模板副本（已存在则 kept） |
| I4 | ignore 写失败（只读、block 截断、`.gitignore` 是目录）与核心脚手架失败没有区分，结果形状也没有 `error` | scaffold 结果加 `error?`；核心文件失败 = 命令错误，ignore 失败 = 非致命 warning（`git.status:'error'`）；新增 T-INIT-23/24/25 |
| I5 | "模板改为经 `mapArtifactPaths` 渲染"没说清是常量还是写盘时；`experiments/check-init-templates.mjs` 依赖常量保持上游原文 | R4.3.1 明确：常量不变，**写盘时**渲染；新增 T-STATIC-05 |
| I6 | 允许 `.feynman` 为符号链接会与 I3（不写工作区外）冲突 | R2.5 改为读可用、写前 `realpath` 校验；出工作区则 `init` 报错、工具拒写 |
| I7 | `init` 用 `session.header.cwd`，而其它工具用 `workingDirectory` 服务优先，可能脚手架与产物落在不同目录 | R4.7.5 改为 `workspaceRoot(ctx, session)` |
| I8 | skill 里把命令写成 `pandoc <artifact-root>/outputs/x.md`，shell 会把 `<` 当重定向 | R4.8.2/R4.12.3 明确：prose 用 `<artifact-root>`，可执行命令用 `$ARTIFACT_ROOT` 并加引号 |

---

## 3. 测试与文档矛盾（已修）

| # | 发现 | 处置 |
|---|---|---|
| T1 | T-PROMPT-03 声称 deepresearch 模板含 `experiments/`；实际 0 处，只有 `log` 有 | 重指到 `log` 模板 |
| T2 | T-STATIC-02 在 `lib/content-store.js:7` 的注释上必失败 | R4.11.2 要求改注释；T-STATIC-02 写明覆盖 content-store |
| T3 | "不含裸 `outputs/`"用 `includes` 会因 `.feynman/outputs/` 假失败 | verification §0 统一指定 lookbehind 正则 |
| T4 | T-INIT-02 在非 git fixture 上期望 `git.action:'unchanged'` | 拆成 T-INIT-02（非 git → `none`）与 T-INIT-02b（git → `unchanged`） |
| T5 | T-EVAL-01/02 断言 `buildPrompt` 内部，没有可测入口 | R4.9.1 要求 `run.mjs` 导出 `buildTask(workflow, question, { layout })` |
| T6 | §7.4/§9.5 的逐字文案含 `.feynman`，与 T-STATIC-02 冲突 | §9 开头说明：文案由 `MARKER_DIR`/`MARKER_FILE` 拼接，输出逐字一致 |
| T7 | §9.7 的 "a manifest" 未定义 | 删掉，只按 `autoresearch.*` 判断 |
| T8 | 分析稿 §5.3 仍写"`--track` 时 block 含 `.feynman/fetch/`"，与 spec 的"track = 移除 block"不一致 | 已改分析稿 |

---

## 4. 已确认无误的部分

- **映射顺序**：先对上游模板映射，再替换 `$@`/`<slug>`；用户输入不会被改写。existing `buildPrompt(...args)` 调用因默认 root `''` 保持兼容。
- **DSH 事实**：`workingDirectory.get(session)` 存在；`grep` 从工作区根跳过隐藏目录、显式传 `path` 可搜；skills `get()` 拿不到 session，因此 skills 必须静态 root 无关——三个假设都成立。
- **现有测试影响**：prompt 单测默认 root `''` 不变；`tests/evals.test.js` 的 fixture 已含 `outputs/.plans`/`.drafts`，按 legacy 解析为根布局，不需要改；`source_check` 测试只断言 basename，写 `.feynman/outputs/` 仍通过（新增断言见 T-CMD-11）。
- **git 行为**：`git check-ignore` 对不存在路径可用、子树 `.gitignore` 生效、worktree/submodule 可用 `rev-parse --is-inside-work-tree` 识别。
- **`--root .`**：root 为 `''` 时 zero-op 映射，brief 与 0.24.0 逐字一致（autoresearch 锚定除外）。

---

## 5. 残余风险（接受并记录）

| 风险 | 处置 |
|---|---|
| 默认 no-track 下 `git clean -xdf` 会删除全部研究产物 | 文档 + `doctor` 警告；版本化交给 `--track`。不因这个风险改默认（污染是更强的默认伤害） |
| 旧版留在项目根的 `autoresearch.*` 不再自动续跑 | RELEASES 说明；手工移入 `<root>/experiments/` |
| no-track 时布局 marker 不共享，队友克隆后按默认布局 | 文档说明；需要团队一致就 `--track` |
| `--root .` 在代码库仍可能与用户目录撞名 | 用户显式选择；`init` 的安全阀与 warning 兜底 |
| Windows 仅做了路径/EOL 设计与单测假设，未实机验证 | 验收清单保留；CI 上跑 Windows 单测 |
| 模型不服从具体路径 | eval 门禁：两种布局各跑一题，写错根先修 prompt 不让步 |

---

## 6. 实施前检查清单

1. Phase A 先落地 `project-paths`/`project-git`，不改变任何行为；跑通 T-PATH/T-GIT。
2. Phase B 的测试用 `os.tmpdir()`，不要放在仓库 `.scratch/`（父级 `.gitignore` 会干扰 `check-ignore`）。
3. Phase C0 顺序不能乱：0.24.0 fixture → autoresearch 锚定 → 新 fixture → 更新 digest。
4. T-STATIC-02/05 作为发布门禁（`.feynman` 字面量、模板逐字比对）。
5. evals 至少各跑一题；写错根只修 prompt，不改评分器。

---

## 7. R → T 覆盖抽查

| 要求 | 测试 |
|---|---|
| R1.1/R1.2 | T-PATH-07/08、T-STATIC-02 |
| R1.3 | T-PROMPT-02/03/14/15 |
| R2.1–R2.5 | T-PATH-11…23、T-INIT-16、T-PATH-29/30、T-CMD-16 |
| R3.1–R3.5 | T-PATH-04…06、T-PROMPT-04/05/06/12 |
| R4.1 | T-PATH-01…30 |
| R4.2 | T-GIT-01…20 |
| R4.3 | T-INIT-01…26 |
| R4.4 | T-PROMPT-01…16 |
| R4.5 | T-TOOL-01/02 |
| R4.6 | T-CMD-11/13 |
| R4.7 | T-CMD-01…16 |
| R4.8 | T-STATIC-01/03 |
| R4.9 | T-EVAL-01…05 |
| R4.10 | T-STATIC-04（人工） |
| R4.11 | T-STATIC-02、T-STATIC-05 |
| R4.12 | T-PROMPT-14/16、T-REG-02、T-STATIC-01 |

> 复审后补入 T-GIT-20（negation），已实测 `outputs/*` + `!outputs/keep.txt` 时 `check-ignore -v` 对 `keep.txt` 返回 exit 0 且 pattern 以 `!` 开头。

---

## 8. 实施结果（2026-11-16）

Phase A–F 已全部落地，验证按 `verification.md` 执行：

- `bun test`：202 pass / 0 fail（11 个测试文件）；`node --test tests/*.test.js`：202 pass / 0 fail。
- 新模块：`lib/project-paths.js`、`lib/project-git.js`；`lib/init-scaffold.js` 重写；`prompts.js`/`workflow-tool`/`source-check`/`index.js`/`evals` 接入 layout；skills 与 persona 改为 root 无关。
- e2e（临时 git 仓库）：默认 init 建 `.feynman/` 并写入 managed block；第二次 `created/changed` 为空；`--track` 移除 block 且 `fetch/` 仍被忽略；`--root .` 写入五行 block；根布局二次执行幂等。
- 静态门禁：skills 无裸目录前缀；`index.js`/`prompts.js`/`lib`/`evals` 除 `project-paths.js` 外无 `.feynman` 字面量；persona 不再写死位置；init 模板 hash 固定。
- 与计划的差异（已回写 spec/verification）：T-STATIC-05 改为模板 hash fixture（上游 `project-scaffold.ts` 已不在仓库）；`mapArtifactPaths` 额外映射反引号包裹的裸目录名（review 模板的 `outputs` 一处，T-PATH-31）。

已知未覆盖：真实模型行为（eval 门禁需凭据）、Windows 实机、上游根布局项目首次 `init` 的交互提示（`--root .feynman` 的 Note 已在 prompt header 中给出）。

---

## 9. 实施后独立审查（2026-11-16）

另起实施审查 agent 对照 spec/verification 走查未提交的改动，并由主 agent 逐条复现。发现 1 个阻塞、若干非阻塞问题，全部已修：

### 阻塞

- **`init` 符号链接检查用错 root**：检查路径用的是 `explicitRoot ?? marker root` 而不是解析后的 `root`。默认 `.feynman` 布局下会漏检 `.feynman/outputs`（可写到工作区外），同时会误拒项目根的正常 `outputs` 符号链接。已改为 `artifactPath(rootDir, root, dir)`，新增 T-INIT-16c（默认布局越界/非越界两种）。

### 非阻塞（已修）

- `fetch-content` 的返回提示是单引号字符串，`${MARKER_DIR}` 没插值；改为模板字符串并加测试断言。
- `source-check` 描述补上 “project artifact root / by default”。
- `--track` 在没有 managed block 时改为 `git.action: 'none'`（原为 `unchanged`）。
- `status`/`doctor` 区分 `git unavailable` 与 `not a repository`。
- `mapArtifactPaths` 的“反引号裸目录名”行为回写进 spec R3.1/R3.2/R3.5（原 spec 只写 `dir/`）。
- `check-ignore -v` 解析改为非贪婪 `^(.*?):(\d+):(.*)$`，spec 同步；`writeManagedBlock` 的 EOL 改为“首行决定”。
- README 增补 `grep` 隐藏目录注意事项；RELEASES 改 `## v0.25.0`。
- `buildTask` 同时接受字符串与 `{ layout }`（verification 统一为字符串）。
- 根布局安全阀新增持久化：`ownedDirs`（init 创建的目录，后续可忽略）与 `skippedDirs`（用户自有，永不忽略）。修掉两个真实问题：第二次 `init` 会把用户 `outputs/build.js` 误忽略；根布局写 `papers/<slug>.md` 后第二次 `init` 会撤回 `papers/`。
- `AGENTS.md` 不可读时 kept 不失败；是目录时仍报错；从 `.feynman` 切到根布局且 AGENTS 仍写隐藏路径时给出提示（spec §5.4 已记录）。

### 审查后验证

- `bun test` 202 pass / 0 fail；`node --test tests/*.test.js` 202 pass / 0 fail。
- 新增负向用例：默认布局的根 `outputs` 链接不误判、`.feynman/outputs` 越界拒绝、第二次 init 保留 `papers/`、`--track` 无 block、legacy 转换提示、marker `.feynman` 但产物写根目录时 `done: 0`。

### 仍未覆盖

- verification 的 T-CMD 矩阵仍有若干命令层行没有一一对应测试（多为既有命令的文案/分支）。
- 真实模型下的 eval 行为（需凭据）；Windows 实机。

---

## 10. 迁移后回归审查（2026-11-16）

在目录迁移实现上再走一遍“所有入口是否会写错根”：

- **发现并修复**：`feynman_research_role` 与 `/feynman run` 直接把 `resources/roles.json` 的原始文本塞给模型，verifier 里的 `outputs/<slug>-source-check.md` 没有经过 layout 映射，`.feynman` 布局下会把子代理指向项目根。现在两处都按 session layout 调用 `mapArtifactPaths`，角色文本改为“读取工具返回的 artifact 路径”。
- **persona 措辞**：明确“workflow brief 的路径已解析；skill 里的 `<artifact-root>`/`$ARTIFACT_ROOT` 是占位符，需从 marker 解析”，避免把占位符当字面路径。spec §9.6 同步。
- **autoresearch skill** 补上 `<artifact-root>` 的定义，不再只给三个占位路径。
- 新增回归测试：所有 12 个工作流的 `.feynman` 渲染无裸目录前缀；四个角色的内容都按 layout 映射；`source_check` 在 upstream 根布局写 `outputs/` 而不是 `.feynman/`。
- `bun test` 205 pass / 0 fail；`node --test tests/*.test.js` 205 pass / 0 fail。
- 已确认的迁移语义（非缺陷）：根布局的 `.feynman/project.json` 在 no-track 下不共享；旧项目根只留下 `experiments/autoresearch.*` 时不触发 legacy 检测，需手工选 `--root .`；`init` 不预建 `experiments/`（autoresearch 按需创建）。
