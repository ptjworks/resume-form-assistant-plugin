# 一键填写评测语料（#429 第 11 项）

比较发给 AI 的两种写法：资料只发编号、分组和字段名（默认的做法，`ai-worker.js`），和连值一起发（插件状态页打开「AI 填写时发送资料原文」时的做法，`ai-worker-values.js`）。两种都在插件里，评测和插件一样按请求里的 `sendValues` 走哪条路。

- `resume.json`：一份虚构资料。`profile` 是桌面「我的信息」的结构，`template` 是桌面解析简历得到的原始字段，`siteAnswers` 是按网站存过的回答（#452）。评测按 content.js 的顺序拼成发给 worker 的资料。
- `pages.json`：五张合成的网申表，照银行、国企、北森、外企英文表和开放题区块的常见结构写。每题标了按这份资料应该填的值；`null` 是资料里没有、应该空着。

都是编的：人名、单位、号码、学校都不真实，证件号按校验规则算出。

## 评测

模拟模型（不联网、不花钱，CI 里也跑）：

```bash
node scripts/eval-fill.mjs --mock empty
```

真实模型**会产生费用**，只在改提示词或推荐模型时手动运行，不进 CI。Key 只从环境变量 `RESUME_PRO_EVAL_API_KEY` 读，用 1Password 注入：

```bash
op-dev run --env-file <只写 RESUME_PRO_EVAL_API_KEY=op://… 的文件> -- node scripts/eval-fill.mjs --base-url https://api.example.com/v1 --model some-model --confirm-paid --runs 3 --out eval-fill.json
```

输出每种写法的填对、填错、没填、该空着、开放题被现写的题数，发出的字节数和平均耗时，再列出两种写法结论不同的题。加 `--verbose` 在控制台看这些题各填了什么；结果文件里没有填的值，也没有模型原文。
