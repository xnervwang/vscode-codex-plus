# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Test data for the skill search: a made-up skill catalogue and requests against it.

The skills imitate the shape of real ones: a
hyphenated name, sometimes a plugin prefix, a description ending in a "Use when ..." clause with
the phrases people type, some of them in Chinese. Several skills share words on purpose, so that a search has to
weigh the name and the trigger phrases against the rest of the description.
"""

SKILLS = [
    ("code-review-publish", "Create, update and publish a code review from a local commit, and what its description "
     "must say. Use when 发 CR / 提交代码审查 / publish a review / the review shows too many commits / a revision does "
     "not update."),
    ("code-review-comments", "Leave, reply to and resolve comments on a code review; drafts stay unpublished until asked. "
     "Use when 回复评审意见 / reply to a reviewer / resolve a thread / delete a draft comment."),
    ("web-fetching", "Fetch external web pages that need JavaScript, get past bot walls and rate limits, and download "
     "lists of pages in batches. Use when 抓网页 / 网页拉不到 / 被限速 / 429 / scrape a page / batch download."),
    ("internal-portal-fetch", "Read pages of internal portals that sign you in first and render on the client, and test "
     "whether your sign-in is still valid. Use when 内网页面读不出来 / portal shows a login page / session expired."),
    ("periodic-wakeup", "Set up a recurring alarm that wakes the conversation every few minutes so work does not stall "
     "between turns, and when to remove it. Use when 打更人 / 定时叫醒我 / 每隔几分钟踢一下 / wake me up periodically."),
    ("background-agent-offload", "Run a long task in a detached background agent that survives closing the laptop, check "
     "its progress, and resume it to correct it. Use when 派后台子 agent / 长任务放后台 / run it in the background."),
    ("git-identity", "Make commits to public hosting use the personal identity rather than the work one, check which "
     "config file supplied it, and where the API token lives. Use when 提交作者不对 / commit author is wrong / new "
     "machine git setup."),
    ("jira-ticket-writing", "Write the title and description of an issue tracker ticket for a bug, a failing pipeline or "
     "a task, and change its status. Use when 建 JIRA / 写 bug 单 / file a bug / close the ticket."),
    ("design-doc-writing", "Lay out a feature design document for review: sections, decisions up front, alternatives "
     "and compatibility. Use when 写设计文档 / design review / alternatives considered / what goes in the first page."),
    ("test-plan-writing", "Write a test design document that states which tests would prove completeness, with fixed "
     "fields for every case. Use when 测试设计文档 / test plan / pass criteria / which fields a test case needs."),
    ("perf-report-writing", "Write a performance or benchmark report: environment first, per-path overhead, baselines "
     "and noise bands. Use when 性能测试报告 / benchmark report / compare two runs / microbenchmark."),
    ("weekly-status-report", "Write the weekly project status email: colour, key dates, path to green and what changed. "
     "Use when 写周报 / status report / tracker email / turn yellow."),
    ("customer-letter-writing", "Draft a customer outreach letter from verified case facts using an approved template. "
     "Use when 给客户写信 / customer reachout / what do we tell the customer."),
    ("slack-reply-to-partner", "Draft a reply to a colleague from another team who asked about progress or timelines, "
     "keeping internal reasoning out. Use when 回复 SA / 别的团队问进度 / reply to a partner team."),
    ("cold-read-check", "Have a reader with no context judge whether English text reads as machine-written and give "
     "reasons, then revise until it passes. Use when 去 AI 味 / 冷读 / does this read like AI / 像机器写的."),
    ("external-model-prose", "Hand final English prose to a model from another vendor to write, then check every claim "
     "against the facts. Use when 换个模型写 / write the commit message / write the description in English."),
    ("ask-second-opinion", "Get a second opinion from two other models run in the background, with the flags for each "
     "and how to tell they finished. Use when 问问另一个模型 / second opinion / let another model look."),
    ("talk-to-other-model", "Drive a non-Claude model on a hosted API and relay every later message to it verbatim. "
     "Use when 用 GPT 跟我对话 / talk to GPT directly / put me through to another model."),
    ("three-sages-vote", "Three seats each write a proposal and review each other; only a unanimous vote counts. "
     "Use when 三贤人 / 让 magi 裁决 / several models must agree."),
    ("workspace-create", "Create a project directory with an engine workspace and a test workspace side by side, named "
     "by purpose. Use when 新建 workspace / 建工作区 / name this workspace / can I delete this workspace."),
    ("workspace-sync", "Resync a workspace that fell behind upstream and fix a review whose destination reverted. "
     "Use when 同步工作区 / workspace fell behind / rebase every package / thousands of commits in the diff."),
    ("clean-build-safety", "Which directories a clean build may delete and which cleanup commands destroy the working "
     "tree. Use when clean build / 删 build 目录 / undefined reference after a partial clean / build killed."),
    ("build-skip-tests", "Build only the binary you need, or a release build without running tests but with static "
     "analysis kept. Use when 只要二进制 / skip tests / flaky unit test blocks the build."),
    ("demo-cluster-run", "Bring up the desktop demo cluster and run the test suite's markers on it. Use when 起演示集群 / "
     "run the desktop tests / brazil demo / the demo runs old binaries."),
    ("parallel-demo-clusters", "Run several desktop demo clusters at once, each in its own namespaces, so ports and "
     "process kills stop colliding. Use when 同时起两个集群 / two demo clusters / namespaces for clusters."),
    ("preprod-cluster-ops", "Create a test cluster on the pre-production control plane, reach its host, and deploy a "
     "private build. Use when 起测试集群 / preprod cluster / ssh to the test host / deploy private build."),
    ("preprod-create-failure", "Diagnose a test cluster create that fails or stays creating, and clean up a stuck "
     "instance. Use when 集群创建卡住 / create stuck at a workflow step / cannot find version."),
    ("fault-injection-points", "Make a timing or failure path happen on demand with event points and fault cases. "
     "Use when 注入故障 / pause the process at a code location / hold a backend / deterministic race."),
    ("flaky-test-rules", "Write tests whose outcome does not depend on scheduling: poll for state instead of sleeping, "
     "use event points. Use when flaky test / 不稳定的用例 / 靠概率 / make a test deterministic."),
    ("integration-test-fix", "Investigate a failing integration test run from its link, read its logs and find the "
     "root cause. Use when test run failed / 集成测试失败 / debug a test failure."),
    ("pipeline-failure-triage", "Find why a release pipeline step is red, tell the four kinds of root cause apart and "
     "check for an existing ticket. Use when pipeline 红了 / pipeline step failed / why is the pipeline blocked."),
    ("deployment-fixer", "Diagnose and fix failed, stuck or blocked deployments, including template stack failures. "
     "Use when 部署失败 / deployment stuck / rollback failed."),
    ("oncall-ticket-triage", "Triage an operational ticket: ground-truth the instance, match known issues and pull logs "
     "to reach a verdict. Use when 分诊工单 / triage this ticket / oncall ticket / what is the root cause."),
    ("crash-stack-lookup", "Get the symbolised backtrace for a database crash from the crash report page or a saved "
     "query. Use when 崩溃栈 / core dump / backtrace / which bug is this crash."),
    ("host-logs-pull", "Pull an instance's host-side engine and storage logs and grep them without downloading. "
     "Use when 拉日志 / host logs / fresh crash not shipped yet / grep the active log."),
    ("archived-logs-pull", "Pull an instance's logs from the central log lake for a window in the past, even for a "
     "deleted instance. Use when 历史日志 / logs for last week / instance was deleted."),
    ("vacuum-wraparound-triage", "Tell the root causes of an approaching transaction id wraparound apart and the ways "
     "to mitigate. Use when xid wraparound / vacuum 没清 dead tuple / used xids warning."),
    ("snapshot-lineage", "Trace which snapshot a restored cluster came from and which source cluster made it. "
     "Use when 从哪个快照恢复 / restored from snapshot / source cluster of a restore."),
    ("fleet-stats-query", "Query fleet-wide numbers through the dashboard's data source: how many clusters use a "
     "feature. Use when 多少集群 / fleet stats / what share of accounts / dashboard numbers."),
    ("engine-telemetry", "Read engine telemetry on one instance or across the fleet. Use when engine metric in prod / "
     "telemetry fleet-wide / 遥测数据."),
    ("dashboard-numbers", "Log into a hosted dashboard workspace and pull the numbers behind a panel by running its "
     "query. Use when Grafana 看板 / numbers behind a panel / my role in this dashboard."),
    ("quip-archive", "Download a batch of shared documents to local markdown with images before the service shuts "
     "down. Use when 归档文档 / back up these documents / save them locally."),
    ("doc-platform-editing", "Create and edit documents on the document platform through its servers, link sections "
     "and upload images. Use when 编辑文档 / insert a screenshot / table column widths / section link."),
    ("wiki-edit", "Write, create and delete internal wiki pages and their attachments. Use when 写 wiki / edit the wiki "
     "page / wiki attachment."),
    ("upstream-patch", "Get a patch into the upstream open source database project: mailing list, review and testing. "
     "Use when 给社区提补丁 / upstream patch / mailing list / commitfest."),
    ("open-source-pr-gates", "Checks before sending anything to someone else's open source repository: look for "
     "duplicates, one fix per pull request, tests that fail before the fix. Use when 提 PR / open a pull request / "
     "first contribution / reply to the maintainer."),
    ("disk-cleanup", "Find what fills the development machine's disk and reclaim the package cache and core files. "
     "Use when 磁盘满了 / disk full / no space left on device / clean the package cache."),
    ("dev-machine-inventory", "The list of development machines with their stable aliases, OS and architecture. "
     "Use when 我有几台开发机 / which machine is arm / hostname of my dev box."),
    ("permission-gates", "How each permission gate decides and how to rewrite a blocked command. Use when 命令被拦 / "
     "denied by the classifier / why does it keep asking me / sensitive file."),
    ("panel-slow-open", "Diagnose an editor panel that opens slowly or stays blank, measure where the time goes. "
     "Use when 面板打开很慢 / blank panel / extension host uses gigabytes / service worker."),
    ("model-latency", "Tell whether a slow model is slow because of effort level, context size, output cap or "
     "throttling. Use when 模型变慢了 / 是不是被限流 / effort level / turn takes minutes."),
    ("usage-cost", "Group per-call spend and throttling events by session or model. Use when 花了多少钱 / how much did "
     "I spend / 429 events / usage dashboard."),
    ("duplicate-session", "Recognise one conversation run by two processes at once and keep only one. Use when 两个同名对话 "
     "/ file changed on disk that I did not touch / session runs in the background."),
    ("work-plan-maintain", "Keep this conversation's work plan up to date: rows, states and who a row waits on. "
     "Use when the user raises something new / a row is finished / a row waits on someone."),
    ("compaction-continuity", "What to write before the context is compacted so the work can carry on afterwards. "
     "Use when 上下文压缩 / before compaction / pick up after compaction."),
    ("release-artifact-names", "Turn a release line into its version set, pipeline and branch names. Use when which "
     "version set / pipeline name for this release / which branch to cherry-pick onto."),
    ("release-family-versions", "Map an engine minor version to its release family codename and back. Use when which "
     "family / 这个版本属于哪个系列 / codename of this release."),
    ("hotfix-process", "Steps of a hotfix release for one customer version, from branch to delivery. Use when hotfix / "
     "热修复 / patch one customer's version."),
    ("backport-flags", "Send a fix across release lines: where conflicts come from and which review flags to use. "
     "Use when backport / cherry-pick to another branch / 移植修复."),
    ("cross-package-change", "Land a change across several packages: review order and how the changes reach each "
     "line. Use when 多个包一起改 / which review to merge first / shared interface change."),
    ("threat-model-writing", "Write a threat model for a feature: assets, trust boundaries and mitigations. "
     "Use when 威胁模型 / threat model / security review prep."),
    ("security-review-intake", "Open a security review engagement and answer its intake survey. Use when security "
     "review / intake survey / who is my security guardian."),
    ("launch-readiness", "What each gate before a feature launch requires and who signs off. Use when 上线前要做什么 / "
     "launch checklist / readiness review / feature freeze."),
    ("readiness-review-writing", "Write the operational readiness review for a feature. Use when ORR / operational "
     "readiness / readiness document."),
    ("parameter-release", "Release a change to an engine parameter's definition through its defaults artifact and "
     "pipeline. Use when 改参数默认值 / add a parameter to parameter groups / parameter revision."),
    ("consistency-test-run", "Run a consistency test case against a cluster and read the checker's verdict. Use when "
     "一致性测试 / consistency test / run a case file."),
    ("transcribe-meeting", "Correct speech recognition mistakes in internal product names after transcribing a "
     "recording. Use when 会议录音转文字 / ASR heard it wrong / 术语听错了."),
    ("employee-policies", "Office and employee policies: vending limits, promotion cycles and feedback rules. "
     "Use when 升职 / promotion cycle / vending machine limit / 还能领几个充电器."),
    ("org-structure", "Who owns which component and whom to escalate to. Use when 找谁 / who owns this component / "
     "escalate to whom / my manager."),
    ("abbreviations", "What the team's abbreviations and code names stand for. Use when 这个缩写是什么意思 / what does "
     "this acronym mean."),
    ("Tools-all:skill-authoring", "Rules and format for adding a skill to the tools package: frontmatter, dependencies "
     "section and the format check. Use when 新增 skill / add a skill to the package / skill description too long."),
    ("Tools-all:package-publish", "Package an agent or skill and publish it to the registry, or install a changed skill "
     "locally to test it. Use when 发布包 / publish the package / test a skill locally."),
    # Overviews that use other skills' names as words. A search that weighs names no more than descriptions puts these
    # first for a request that only says a name.
    ("log-retention-overview", "How long host logs and archived logs are kept: host logs rotate on the host, archived "
     "logs move to the lake, and archived logs of a deleted host stay archived."),
    ("session-history-overview", "Session history explained: a duplicate session, a session list entry, a session title "
     "and why a duplicate session id shows twice in the session history."),
    ("review-etiquette", "Code review etiquette: tone of code review comments, when code review publish is due, how "
     "code review comments get resolved, and code review comments that block."),
    ("document-style-overview", "One writing style for every document: design doc writing, test plan writing, perf "
     "report writing and weekly status report writing share these rules on writing, doc headings and report tables."),
    ("cluster-naming-overview", "Naming rules for clusters: demo cluster run names, preprod cluster ops names, cluster "
     "tags, and how a demo cluster or preprod cluster is named for each run."),
    ("triage-glossary", "Glossary of triage words: pipeline failure triage, oncall ticket triage, a failure, a ticket, "
     "a crash stack lookup, triage of a pipeline failure versus triage of an oncall ticket."),
    ("cost-latency-faq", "Questions people ask about model latency and usage cost: why latency of a model grows, what "
     "usage cost covers, model usage, cost of latency."),
    ("telemetry-dashboard-overview", "Where engine telemetry shows up: dashboard numbers from engine telemetry, fleet "
     "stats query panels, telemetry dashboard numbers per fleet, stats of the engine."),
    ("release-glossary", "Release words explained: release family versions, a parameter release, a package publish, "
     "versions of a release family, and how a release is published."),
    ("test-glossary", "Test words explained: an integration test fix, a consistency test run, fault injection points, "
     "a test run that needs a fix, injection of a fault, points in a test."),
    ("skill-catalogue-overview", "What the catalogue covers: skill authoring, permission gates, org structure, threat "
     "model writing, launch readiness, web fetching, disk cleanup and clean build safety, each in one line."),
    ("snapshot-and-workspace-faq", "Questions about snapshot lineage and workspace sync: what lineage of a snapshot "
     "means, why a workspace sync is needed, snapshot of a workspace, sync of a lineage."),
    ("deployment-overview", "How a deployment moves through stages, what a deployment fixer looks at, and which "
     "deployment failures need a fixer at all."),
]

# Requests and the skill each should find among the top five.
QUERIES = [
    ("please publish my code review for this commit", "code-review-publish"),
    ("the reviewer left comments, help me reply to them", "code-review-comments"),
    ("scrape this web page, it keeps returning 429", "web-fetching"),
    ("the internal portal only shows a login page", "internal-portal-fetch"),
    ("wake me up every five minutes so the work keeps going", "periodic-wakeup"),
    ("run this long task in the background so it survives closing the laptop", "background-agent-offload"),
    ("my commit author is the wrong email on the public repo", "git-identity"),
    ("file a bug for this crash with the stack", "jira-ticket-writing"),
    ("help me lay out the design document for review", "design-doc-writing"),
    ("what fields should each test case in the test plan have", "test-plan-writing"),
    ("compare two benchmark runs and write the report", "perf-report-writing"),
    ("draft this week's status email for the tracker", "weekly-status-report"),
    ("what do we tell the customer about this incident", "customer-letter-writing"),
    ("does this paragraph read like AI wrote it", "cold-read-check"),
    ("get a second opinion from another model on this plan", "ask-second-opinion"),
    ("talk to GPT directly from now on", "talk-to-other-model"),
    ("the workspace fell behind upstream, resync it", "workspace-sync"),
    ("do a clean build, which directories can I delete", "clean-build-safety"),
    ("a flaky unit test blocks my build, skip tests", "build-skip-tests"),
    ("bring up the desktop demo cluster and run the tests", "demo-cluster-run"),
    ("run two demo clusters at once without collisions", "parallel-demo-clusters"),
    ("deploy my private build to the preprod test host", "preprod-cluster-ops"),
    ("pause the process at a code location to reproduce the race", "fault-injection-points"),
    ("make this flaky test deterministic", "flaky-test-rules"),
    ("why is the pipeline step red", "pipeline-failure-triage"),
    ("the deployment is stuck, fix it", "deployment-fixer"),
    ("get me the backtrace of this core dump", "crash-stack-lookup"),
    ("xid wraparound is getting close, vacuum is not cleaning", "vacuum-wraparound-triage"),
    ("which snapshot was this cluster restored from", "snapshot-lineage"),
    ("how many clusters across the fleet use this feature", "fleet-stats-query"),
    ("open a pull request to the open source project", "open-source-pr-gates"),
    ("no space left on device, clean the disk", "disk-cleanup"),
    ("the editor panel takes a minute to open", "panel-slow-open"),
    ("how much did I spend on model calls this month", "usage-cost"),
    ("which version set and pipeline name for this release", "release-artifact-names"),
    ("cherry-pick this fix to another branch, which flags", "backport-flags"),
    ("write a threat model for the new feature", "threat-model-writing"),
    ("what do I need before launching this feature", "launch-readiness"),
    ("add a skill to the tools package", "Tools-all:skill-authoring"),
    ("publish the package to the registry", "Tools-all:package-publish"),
    ("帮我发一个 CR", "code-review-publish"),
    ("回复评审意见", "code-review-comments"),
    ("这个网页抓不下来，被限速了", "web-fetching"),
    ("内网页面读不出来", "internal-portal-fetch"),
    ("设置打更人，定时叫醒我", "periodic-wakeup"),
    ("这个长任务放后台跑，派后台子 agent", "background-agent-offload"),
    ("提交作者不对", "git-identity"),
    ("建个 JIRA 写 bug 单", "jira-ticket-writing"),
    ("写设计文档", "design-doc-writing"),
    ("写一份测试设计文档", "test-plan-writing"),
    ("写性能测试报告", "perf-report-writing"),
    ("帮我写周报", "weekly-status-report"),
    ("给客户写信说明这次故障", "customer-letter-writing"),
    ("别的团队问进度，帮我回复 SA", "slack-reply-to-partner"),
    ("这段英文去 AI 味，冷读一下", "cold-read-check"),
    ("用 GPT 跟我对话", "talk-to-other-model"),
    ("交给三贤人裁决", "three-sages-vote"),
    ("新建 workspace", "workspace-create"),
    ("同步工作区代码", "workspace-sync"),
    ("起演示集群跑测试", "demo-cluster-run"),
    ("同时起两个集群", "parallel-demo-clusters"),
    ("起测试集群", "preprod-cluster-ops"),
    ("集群创建卡住了", "preprod-create-failure"),
    ("注入故障复现竞态", "fault-injection-points"),
    ("不稳定的用例，靠概率", "flaky-test-rules"),
    ("集成测试失败了", "integration-test-fix"),
    ("pipeline 红了", "pipeline-failure-triage"),
    ("部署失败", "deployment-fixer"),
    ("分诊这个工单", "oncall-ticket-triage"),
    ("拉一下历史日志", "archived-logs-pull"),
    ("从哪个快照恢复的", "snapshot-lineage"),
    ("Grafana 看板上的数字", "dashboard-numbers"),
    ("把这些文档归档到本地", "quip-archive"),
    ("给社区提补丁", "upstream-patch"),
    ("磁盘满了", "disk-cleanup"),
    ("我有几台开发机", "dev-machine-inventory"),
    ("命令被拦了", "permission-gates"),
    ("面板打开很慢", "panel-slow-open"),
    ("模型变慢了，是不是被限流", "model-latency"),
    ("这个月花了多少钱", "usage-cost"),
    ("上下文压缩之前要写什么", "compaction-continuity"),
    ("这个版本属于哪个系列", "release-family-versions"),
    ("热修复流程", "hotfix-process"),
    ("多个包一起改，先合哪个", "cross-package-change"),
    ("写威胁模型", "threat-model-writing"),
    ("上线前要做什么", "launch-readiness"),
    ("改参数默认值", "parameter-release"),
    ("跑一致性测试", "consistency-test-run"),
    ("会议录音转文字，术语听错了", "transcribe-meeting"),
    ("升职一年几轮", "employee-policies"),
    ("这个组件找谁", "org-structure"),
    ("这个缩写是什么意思", "abbreviations"),
    ("新增 skill 到包里", "Tools-all:skill-authoring"),
]

# Requests made of the words in a skill's name, which other skills' descriptions use as well: the skill named for them
# should come first. Without the weight on names, most of these lose first place.
BY_NAME = [
    ("workspace sync", "workspace-sync"),
    ("crash stack lookup", "crash-stack-lookup"),
    ("host logs", "host-logs-pull"),
    ("archived logs", "archived-logs-pull"),
    ("release family versions", "release-family-versions"),
    ("model latency", "model-latency"),
    ("duplicate session", "duplicate-session"),
    ("permission gates", "permission-gates"),
    ("usage cost", "usage-cost"),
    ("dashboard numbers", "dashboard-numbers"),
    ("fleet stats query", "fleet-stats-query"),
    ("engine telemetry", "engine-telemetry"),
    ("snapshot lineage", "snapshot-lineage"),
    ("fault injection points", "fault-injection-points"),
    ("integration test fix", "integration-test-fix"),
    ("deployment fixer", "deployment-fixer"),
    ("skill authoring", "Tools-all:skill-authoring"),
    ("package publish", "Tools-all:package-publish"),
    ("threat model writing", "threat-model-writing"),
    ("launch readiness", "launch-readiness"),
    ("parameter release", "parameter-release"),
    ("consistency test run", "consistency-test-run"),
    ("org structure", "org-structure"),
    ("code review comments", "code-review-comments"),
    ("code review publish", "code-review-publish"),
    ("design doc writing", "design-doc-writing"),
    ("test plan writing", "test-plan-writing"),
    ("perf report writing", "perf-report-writing"),
    ("weekly status report", "weekly-status-report"),
    ("preprod cluster ops", "preprod-cluster-ops"),
    ("demo cluster run", "demo-cluster-run"),
    ("pipeline failure triage", "pipeline-failure-triage"),
    ("oncall ticket triage", "oncall-ticket-triage"),
    ("disk cleanup", "disk-cleanup"),
    ("clean build safety", "clean-build-safety"),
    ("web fetching", "web-fetching"),
]

# Requests no skill is for: each should be given nothing, or at most one skill.
NEGATIVES = [
    "好的",
    "谢谢",
    "继续",
    "继续做吧",
    "ok go on",
    "thanks, that's all",
    "sure, do it",
    "好的，就这样吧",
    "看一下",
    "嗯嗯可以",
    "yes please",
    "no, the other one",
    "what do you think?",
    "你觉得呢",
    "可以，没问题",
    "do it now",
    "我明白了",
    "that is fine with me",
    "就这样",
    "好的谢谢你",
]
