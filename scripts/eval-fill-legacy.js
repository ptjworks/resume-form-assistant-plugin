// #429 第 11 项之前的发值方式：资料连值一起发给 AI，AI 回值。只给 scripts/eval-fill.mjs 对比准确率用，下个版本删掉。
// 不进插件包（desktop/scripts/pack-plugin.js 的清单里没有 scripts/），线上的 ai-worker.js 里也没有这条路。
// 用法：在同一个 vm 里先跑 ai-worker.js，再跑这个文件，它把 handleAiFill 换成下面这份。
// 下面是 #429 第 11 项合并前 next（55bd2b4）上 ai-worker.js 的原样代码，只改了名字，免得和新的撞上；
// selectResumeCandidates 原来在 ai-helpers.js 里，只剩这里在用，一起搬过来。

const LEGACY_SYSTEM_PROMPT = [
  "你是一个网页表单填写助手。根据简历字段数据，判断表单中每个输入框应该填写什么值。",
  "规则：",
  "1. 仅返回 JSON 数组，不含任何解释或 markdown 代码块",
  '2. 格式：[{"fieldId":"xxx","value":"yyy"}]',
  "3. 只填写能确定匹配的字段，不确定的跳过",
  "4. 基本信息字段优先精确匹配，不要把教育背景、经历、技能字段填进姓名、邮箱、手机号、出生日期等基础字段",
  "5. 下拉框、单选框的 value 必须是该字段 options 里的原文，不要改写、不要自造，不要选「请选择」这类占位项",
  "6. 证件类型、学历、学位、外语语种/等级、年月分拆、省市县等下拉框，简历里有明确对应的数据就填写，没有就跳过",
  "7. 带 cascadeLevel 的字段属于同一组联动下拉，按层级分别给出省、市、县等对应层级的值",
  "8. 匹配考虑同义词：手机=电话=联系方式=mobile=phone；学历=最高学历=培养层次",
  "9. 紧急联系人、父亲、母亲、配偶、家庭成员等字段只能用对应那个人的数据；不要把本人的姓名、手机号、邮箱、出生日期填进去，也不要把一个人的数据填给另一个人",
  "10. 籍贯、高考生源地、户口所在地是三个不同的问题，不能拿一个的数据填另一个；省、市、县要填对应层级",
  "11. 带 multiple 的字段可以多选：简历里有几项就给几项，用「、」隔开，每一项都按第 5 条取 options 里的原文",
  "12. 带 cascade 的字段是逐级选择（省 → 市 → 区县这类）：从最上面一级写到简历里有的最细一级，用「/」隔开，例如「广东省/深圳市/南山区」",
  "13. 带 maxLength 的字段，value 不能超过这个字数（lengthUnit 为 byte 时按字节算，汉字算 2）；长回答写不下就精简，学校、公司、专业这类名称写不下时跳过，不要截断"
].join("\n");

// Keep complete groups (including every repeated experience). Unknown or
// cross-domain labels deliberately fall back to the full resume.
function selectResumeCandidates(formFields, resumeFields) {
  const domains = [
    /教育|学校|院校|研究生|硕士|博士|专业|学历|学位|入学|毕业|education|school|university|major|degree|postgraduate/i,
    /工作经历|实习|任职经历|工作内容|工作单位|公司|雇主|\bwork\s+(?:history|experience)\b|\bemployment\b|\binternship\b|\bcompany\b/i,
    /项目|科研|研究经历|\bproject\b|\bresearch\b/i,
    /论文|专利|发表|publication|patent/i,
    /证书|奖励|奖项|荣誉|certificate|award/i,
    /技能|语言能力|skill|language/i,
    /基本信息|个人信息|姓名|电话|邮箱|籍贯|personal|contact/i
  ];
  const classify = (text) => domains.flatMap((pattern, i) => pattern.test(text) ? [i] : []);
  const selected = new Set();
  for (const field of formFields) {
    const context = [field.group, field.label, field.placeholder, field.name, field.ariaLabel].filter(Boolean).join(" ");
    // Eligibility/location questions are not employment-history questions.
    if (/authoriz|eligib|sponsor|visa|work\s*(?:permit|location)|career\s*plan|工作许可|工作授权|工作地点|工作计划|职业规划|求职意向|就业资格|签证/i.test(context)) return resumeFields;
    const categories = classify(context);
    if (categories.length !== 1) return resumeFields;
    const category = categories[0];
    if (!resumeFields.some(item => classify(String(item.group || "")).includes(category))) return resumeFields;
    const relevant = resumeFields.filter((item) => {
      const groups = classify(String(item.group || ""));
      // Custom groups cannot safely be ruled out.
      // Current employer/role and similar facts may live in basic info.
      return !groups.length || groups.includes(6) || groups.includes(category);
    });
    if (!relevant.length) return resumeFields;
    relevant.forEach((item) => selected.add(item));
  }
  return resumeFields.filter((item) => selected.has(item));
}

function legacyPromptBytes(fields, candidates) {
  // The user text is JSON-escaped again inside the Native Messaging envelope.
  return new TextEncoder().encode(JSON.stringify(buildLegacyUserPrompt(fields, candidates))).length;
}

function makeLegacyBatches(formFields, resumeFields) {
  const batches = [];
  let skippedOversized = 0;
  let skippedNoContext = 0;
  let current = [];
  const emit = fields => {
    if (!fields.length) return;
    const candidates = selectResumeCandidates(fields, resumeFields);
    if (!candidates.length) { skippedNoContext += fields.length; return; }
    if (legacyPromptBytes(fields, candidates) <= AI_USER_BUDGET) {
      batches.push({ fields, candidates });
      return;
    }
    // One field can still exceed the budget if the resume has many large candidates.
    // Send subsets of candidates for that field; never truncate JSON or an individual value.
    let subset = [];
    let emitted = false;
    const skippedBefore = skippedOversized;
    for (const candidate of candidates) {
      if (legacyPromptBytes(fields, [...subset, candidate]) <= AI_USER_BUDGET) {
        subset.push(candidate);
      } else {
        if (subset.length) { batches.push({ fields, candidates: subset }); emitted = true; }
        subset = [];
        if (legacyPromptBytes(fields, [candidate]) <= AI_USER_BUDGET) subset.push(candidate);
        else skippedOversized += 1;
      }
    }
    if (subset.length) { batches.push({ fields, candidates: subset }); emitted = true; }
    if (!emitted && skippedOversized === skippedBefore) skippedOversized += fields.length;
  };
  for (const field of formFields) {
    const next = [...current, field];
    const candidates = selectResumeCandidates(next, resumeFields);
    if (legacyPromptBytes(next, candidates) <= AI_USER_BUDGET) {
      current = next;
    } else {
      emit(current);
      current = [];
      emit([field]);
    }
  }
  emit(current);
  return { batches, skippedOversized, skippedNoContext };
}

async function legacyHandleAiFill(message, controller = new AbortController()) {
  // #223: a caller may ask for a tier (the strong model for a re-match). Without one the
  // request stays exactly what every desktop understands.
  const tier = message.tier === "strong" || message.tier === "default" ? message.tier : undefined;
  // #224：深度分析共用一份调用预算。带了 maxCalls 就最多发这么多次，并如实报告实际次数。
  const maxCalls = Number.isInteger(message.maxCalls) && message.maxCalls >= 0 ? message.maxCalls : undefined;
  const incomingFormFields = Array.isArray(message.formFields) ? message.formFields : [];
  const incomingResumeFields = Array.isArray(message.resumeFields) ? message.resumeFields : [];
  const formFields = incomingFormFields.filter(field => !isSecretField(field));
  const resumeFields = incomingResumeFields.filter(safeResumeField);
  const secretFormFields = incomingFormFields.length - formFields.length;
  if (!formFields.length) return { success: false, error: incomingFormFields.length
    ? "表单里只有像密码的字段，没有发给 AI。" : "没找到可填写的输入框。",
    diagnostics: { errorCode: incomingFormFields.length ? "secret_only" : "none", secretFormFields } };
  if (!resumeFields.length) return { success: false, error: "当前模板没有可用字段。",
    diagnostics: { errorCode: "no_resume_fields", secretFormFields } };

  // 和网页先填的字段同一份口径（#402），包括补充字段里题目原样对得上的回答（#429）。
  // 补填新出现的字段时网页带上整张表的题目（pageLabels），同名的题和页面上原有的一起数。
  const pageFields = Array.isArray(message.pageLabels)
    ? message.pageLabels.filter(label => typeof label === "string").map(label => ({ label })) : formFields;
  const ruleMatches = ResumeProAIHelpers.localRuleMatches(formFields, resumeFields, ResumeProProfile, pageFields);
  const matchedFieldIds = new Set(ruleMatches.map(match => match.fieldId));
  const remainingFormFields = formFields.filter(field => !matchedFieldIds.has(field.fieldId));
  const selectedCandidates = remainingFormFields.length
    ? selectResumeCandidates(remainingFormFields, resumeFields) : [];
  const diagnostics = {
    ruleMatches: ruleMatches.length, aiFields: remainingFormFields.length,
    candidateFields: selectedCandidates.length, resumeFields: resumeFields.length,
    apiMs: 0, promptBytes: 0, errorCode: "none", aiMatches: 0,
    skippedSecret: incomingFormFields.length - formFields.length + incomingResumeFields.length - resumeFields.length,
    secretFormFields,
    skippedOversized: 0, skippedNoContext: 0,
    ...(tier ? { tierRequested: tier } : {}),
    ...(maxCalls === undefined ? {} : { calls: 0 })
  };
  const aiMatches = [];
  const warnings = [];
  let openView;

  if (remainingFormFields.length) {
    const apiStart = performance.now();
    const { batches, skippedOversized, skippedNoContext } = makeLegacyBatches(remainingFormFields, resumeFields);
    diagnostics.skippedOversized = skippedOversized;
    diagnostics.skippedNoContext = skippedNoContext;
    if (skippedOversized) {
      diagnostics.errorCode = "input_too_large";
      warnings.push(aiFailureMessage({ reason: "input_too_large" }));
    }
    if (skippedNoContext) {
      if (diagnostics.errorCode === "none") diagnostics.errorCode = "no_context";
      warnings.push("简历里没有能对应这些网页字段的资料，已跳过 AI 填写。");
    }
    for (const batch of batches) {
      if (controller.signal.aborted) break;
      if (maxCalls !== undefined && diagnostics.calls >= maxCalls) {
        diagnostics.budgetExhausted = true;
        warnings.push("已达到本次深度分析的模型调用上限，部分字段没有交给 AI。");
        break;
      }
      if (maxCalls !== undefined) diagnostics.calls += 1;
      const prompt = buildLegacyUserPrompt(batch.fields, batch.candidates);
      diagnostics.promptBytes += new TextEncoder().encode(prompt).length;
      const result = await sendToDesktop({ purpose: "fill", tier, system: LEGACY_SYSTEM_PROMPT, user: prompt, signal: controller.signal });
      if (tier && (result?.tier === "strong" || result?.tier === "default")) diagnostics.tierUsed = result.tier;
      // #299：服务商多久回了响应头（几批取最慢的），超时停在哪一步。旧桌面不给就不记。
      if (Number.isInteger(result?.firstByteMs) && result.firstByteMs >= 0) {
        diagnostics.firstByteMs = Math.max(diagnostics.firstByteMs ?? 0, result.firstByteMs);
      }
      if (TIMEOUT_STAGES.includes(result?.timeoutStage)) diagnostics.timeoutStage = result.timeoutStage;
      if (!result?.ok) {
        const reason = result?.reason ?? "unavailable";
        if (SKIP_CODES.has(diagnostics.errorCode)) diagnostics.errorCode = reason;
        warnings.push(strongFailureMessage(tier, result) ?? aiFailureMessage(result));
        if (reason === "not_configured") openView = "settings-ai";
        // Only a failure tied to this batch's content is worth trying the next batch for.
        // Everything else (desktop gone, not paired, no key, slow or unreachable provider)
        // will fail the same way again, and each attempt costs a native round trip or a
        // full provider timeout.
        if (!BATCH_LOCAL_FAILURES.has(reason)) break;
        continue;
      }
      if (controller.signal.aborted) break;
      try {
        aiMatches.push(...ResumeProAIHelpers.filterValidMatches(batch.fields, normalizeLegacyMatches(parseJsonContent(result.text))));
      } catch {
        if (SKIP_CODES.has(diagnostics.errorCode)) diagnostics.errorCode = "bad_response";
        warnings.push(aiFailureMessage({ reason: "bad_response" }));
      }
    }
    diagnostics.apiMs = performance.now() - apiStart;
  }
  if (controller.signal.aborted && diagnostics.errorCode === "none") {
    diagnostics.errorCode = "cancelled";
    warnings.push(aiFailureMessage({ reason: "cancelled" }));
  }
  const seenMatchIds = new Set();
  const matches = ResumeProAIHelpers.filterValidMatches(formFields, [...ruleMatches, ...aiMatches])
    .filter(match => {
      if (seenMatchIds.has(match.fieldId)) return false;
      seenMatchIds.add(match.fieldId);
      return true;
    });
  diagnostics.aiMatches = matches.filter(match => !matchedFieldIds.has(match.fieldId)).length;
  const warning = [...new Set(warnings)].join(" ");
  return { success: !warning || matches.length > 0, matches, warning, error: warning, diagnostics,
    ...(openView ? { openView } : {}) };
}

function buildLegacyUserPrompt(formFields, resumeFields) {
  return [
    "表单字段列表：",
    JSON.stringify(formFields),
    "",
    "简历字段列表：",
    JSON.stringify(resumeFields),
    "",
    "填写原则：基本信息优先匹配基本信息分组；教育背景不要填进邮箱、电话、出生日期、籍贯等基础字段；低置信度时留空。"
  ].join("\n");
}

function normalizeLegacyMatches(payload) {
  const source = Array.isArray(payload) ? payload : payload?.matches;

  if (!Array.isArray(source)) {
    throw new Error("结果不是 JSON 数组。");
  }

  return source
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const fieldId = String(item.fieldId ?? "").trim();
      const value = String(item.value ?? "");

      if (!fieldId || !value) {
        return null;
      }

      return { fieldId, value };
    })
    .filter(Boolean);
}

handleAiFill = legacyHandleAiFill;
