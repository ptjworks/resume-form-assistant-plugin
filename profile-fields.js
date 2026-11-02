// 「我的信息」：网申表常问、简历里通常没有的字段。设置页、侧边栏和测试共用这一份定义。
(function attachResumeProProfile(globalScope) {
  const YES_NO = ["是", "否"];

  // id 是存储用的键，改了会丢用户数据；key 是交给匹配规则和 AI 的字段名，也是侧边栏芯片上的字。
  // 地区字段的 key 按「归属 + 层级」命名（籍贯省、户口所在地区县），ai-helpers 靠它分清省市县。
  // aliases 只用来判断「网页上这个字段我们已经有了」，不会作为字段名交出去。
  const PROFILE_SCHEMA = [
    {
      name: "基本信息",
      fields: [
        { id: "name", key: "姓名", aliases: ["真实姓名"] },
        { id: "namePinyin", key: "姓名拼音", placeholder: "ZHANG SAN", aliases: ["拼音"] },
        { id: "usedName", key: "曾用名" },
        { id: "gender", key: "性别", type: "select", options: ["男", "女"] },
        { id: "birth", key: "出生年月", type: "month", aliases: ["出生日期", "生日"] },
        { id: "ethnicity", key: "民族", placeholder: "汉族" },
        { id: "political", key: "政治面貌", type: "select", options: ["中共党员", "中共预备党员", "共青团员", "民主党派", "群众"] },
        { id: "marital", key: "婚姻状况", type: "select", options: ["未婚", "已婚", "离异", "丧偶"] },
        { id: "idType", key: "证件类型", type: "select", options: ["居民身份证", "护照", "港澳居民来往内地通行证", "台湾居民来往大陆通行证", "其他"] },
        { id: "idNumber", key: "证件号码", aliases: ["证件号", "身份证号", "身份证号码"] },
        { id: "height", key: "身高", label: "身高（厘米）" },
        { id: "weight", key: "体重", label: "体重（公斤）" },
        { id: "health", key: "健康状况", type: "select", options: ["健康", "良好", "一般"] },
        { id: "seriousDisease", key: "有无重大疾病史", type: "select", options: ["无", "有"] }
      ]
    },
    {
      name: "户籍与地区",
      fields: [
        { id: "nativeProvince", key: "籍贯省", label: "籍贯（省）" },
        { id: "nativeCity", key: "籍贯市", label: "籍贯（市）" },
        { id: "nativeCounty", key: "籍贯县", label: "籍贯（区县）" },
        { id: "hukouProvince", key: "户口所在地省", label: "户口所在地（省）" },
        { id: "hukouCity", key: "户口所在地市", label: "户口所在地（市）" },
        { id: "hukouCounty", key: "户口所在地区县", label: "户口所在地（区县）" },
        { id: "hukouType", key: "户口性质", type: "select", options: ["城镇", "农村"] },
        { id: "examProvince", key: "高考生源地省", label: "高考生源地（省）" },
        { id: "examCity", key: "高考生源地市", label: "高考生源地（市）" },
        { id: "homeAddress", key: "家庭住址", type: "textarea", aliases: ["家庭地址"] },
        { id: "currentAddress", key: "现居住地", type: "textarea", aliases: ["现住址", "居住地址", "通讯地址"] }
      ]
    },
    {
      name: "联系方式",
      fields: [
        { id: "phone", key: "手机号码", aliases: ["手机", "手机号", "移动电话", "联系电话"] },
        { id: "email", key: "常用邮箱", aliases: ["邮箱", "电子邮箱", "电子邮件"] },
        { id: "emergencyName", key: "紧急联系人姓名", aliases: ["紧急联系人"] },
        { id: "emergencyRelation", key: "紧急联系人关系", placeholder: "父亲" },
        { id: "emergencyPhone", key: "紧急联系人电话", aliases: ["紧急联系电话", "紧急联系人手机"] }
      ]
    },
    {
      name: "教育补充",
      fields: [
        { id: "highestEducation", key: "最高学历", type: "select", options: ["博士研究生", "硕士研究生", "大学本科", "大学专科", "高中及以下"], aliases: ["学历"] },
        { id: "highestDegree", key: "最高学位", type: "select", options: ["博士", "硕士", "学士", "无"], aliases: ["学位"] },
        { id: "studyMode", key: "学习形式", type: "select", options: ["全日制", "非全日制"] },
        { id: "graduation", key: "毕业时间", type: "month", aliases: ["毕业日期"] },
        { id: "classRank", key: "专业排名", placeholder: "前 10%" },
        { id: "studentCadre", key: "是否学生干部", type: "select", options: YES_NO },
        { id: "doubleDegree", key: "是否双学位", type: "select", options: YES_NO },
        { id: "upgrade", key: "是否专升本", type: "select", options: YES_NO },
        { id: "highSchool", key: "高中毕业学校" }
      ]
    },
    {
      name: "语言与技能",
      fields: [
        { id: "language", key: "外语语种", placeholder: "英语", aliases: ["外语"] },
        { id: "languageLevel", key: "外语等级", placeholder: "CET-6" },
        { id: "languageScore", key: "外语成绩" },
        { id: "computerLevel", key: "计算机水平" },
        { id: "skills", key: "技能特长", type: "textarea" }
      ]
    },
    {
      name: "求职补充",
      fields: [
        { id: "expectedCity", key: "期望工作地点" },
        { id: "availableDate", key: "可到岗时间" },
        { id: "acceptAdjustment", key: "是否服从调剂", type: "select", options: YES_NO },
        { id: "specialCategory", key: "专项招聘类别" },
        { id: "awards", key: "奖励荣誉", type: "textarea" }
      ]
    }
  ];

  const FAMILY_GROUP = "家庭主要成员";
  const FAMILY_RELATIONS = ["父亲", "母亲", "配偶", "兄弟姐妹", "子女", "其他亲属"];
  // 这几种关系只会有一个人，备份追加时按关系对上；其他关系按姓名对上。
  const SINGLE_RELATIONS = new Set(["父亲", "母亲", "配偶"]);
  const FAMILY_FIELDS = [
    { id: "name", key: "姓名" },
    { id: "birth", key: "出生年月", type: "month" },
    { id: "political", key: "政治面貌" },
    { id: "company", key: "工作单位" },
    { id: "job", key: "职务" },
    { id: "phone", key: "联系电话" }
  ];

  const CUSTOM_GROUP = "补充字段";
  // #429 第五项第 2 点：这个网站记住的回答。填写时并进资料，只在同一个网站读出来。
  const SITE_GROUP = "本网站回答";
  // 一个网站最多记住的题数，和桌面 archive-store 的 MAX_SITE_ANSWERS_PER_SITE 一致。
  const MAX_SITE_ANSWERS_PER_SITE = 30;
  const MAX_CUSTOM_FIELDS = 200;
  const MAX_OFFERED_LABELS = 20;
  // #189：已填项也进候选，一张表上可复用的内容比空字段多，上限放宽；超出的只报个数。
  const MAX_OFFERED_CANDIDATES = 40;
  // 单项内容的上限；超出的多半是整段作答，不当作可复用信息。桌面整份档案另有 24 KB 上限（MAX_PROFILE_BYTES）。
  const MAX_CANDIDATE_VALUE_CHARS = 2000;
  const MAX_PROFILE_BYTES = 24 * 1024;
  // 长题目要整句留着（#228），只防住异常长的整段文字。和 field-scan.js 的 MAX_OFFER_CHARS 一致。
  const MAX_OFFERED_LABEL_CHARS = 120;
  // 扫描已经不会把这些当字段名；这里再兜一层：纯计数器、纯占位文字不进「我的信息」。
  const NOT_A_LABEL = /^[\d\s\/／()（）]+$|^(?:请)?(?:选择|输入|填写|上传|搜索)$/;

  // #228：可以加多条的经历（教育、实习、获奖、证书……）里的字段，换个网站就对不上是哪一条，
  // 交给简历模板，不进「我的信息」。「语言」「技能」不算：上面「语言与技能」本来就是单值信息。
  const ENTRY_SECTION = /经历|教育背景|学习背景|实习|工作经验|任职|项目|科研|研究成果|获奖|奖项|奖励|荣誉|专利|证书|资格|论文|专著|发表|成果|培训|实践|校园|学生干部|学生工作|社团|家庭|成员|亲属/;
  const INTENT_SECTION = /意向|期望|求职/;
  const FAMILY_SECTION = /家庭|成员|亲属/;
  // 和上面「教育补充」「语言与技能」「求职补充」同类的概括信息，出现在经历区块里也照收（「班级排名」之于「专业排名」）。
  const PROFILE_LIKE_TITLE = /排名|最高学历|最高学位|学习形式|学生干部|双学位|专升本|外语|英语|语种|四六级|cet|计算机|技能|特长/i;
  // 找不到所属区块时，离开上下文就看不懂的题目不问。
  const CONTEXTLESS_TITLE = /^(?:名称|名字|时间|开始时间|结束时间|起止时间|起始时间|获得时间|日期|描述|说明|备注|类型|类别|级别|等级|内容|地点|单位|职务|角色)$/;

  const SKIPPED_INPUT_TYPES = new Set(["password", "file", "checkbox", "hidden", "submit", "button", "reset", "image"]);
  // 补充字段是用户自己起的名，拦不住一行叫「网银密码」：这种字段不推荐、不交给 AI。
  const SECRET_LABEL = /密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret/i;
  // 名字普通、内容却是「密码：xxx」这种写法的，同样不交给 AI。
  const SECRET_VALUE = /(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S/i;
  // 网页自己声明了这是密码、一次性验证码或银行卡信息（autocomplete 属性）：不管字段名怎么写都不收。
  const SENSITIVE_AUTOCOMPLETE = /one-time-code|cc-|password/i;
  // 明显只适用于当前岗位/公司的作答：可以列出来，但不默认勾选。
  const JOB_SPECIFIC_LABEL = /为什么|原因|理由|动机|谈谈|请(?:简述|简要|描述|介绍|说明|阐述)|自我评价|自我介绍|应聘|报考|投递|[本该贵](?:岗位|职位|公司|单位)|岗位|职位|招聘(?:信息|渠道)|得知|推荐人|内推/;
  const JOB_SPECIFIC_VALUE_CHARS = 300;
  // #429 第五项：补充字段里有些题目原样对上也不在本地直接填，照旧交给 AI 按上下文判断。
  // 证件和各种号码、联系方式、政治面貌、薪资（#429 列的四类），再加银行账户。
  // 中英混写的（「学生ID」「E-mail地址」「QQ号」）也认。比的是归一后的题目（小写、去掉空格）。
  const SAVED_ANSWER_EXCLUDED = /证件|身份|护照|通行证|签证|驾驶证|驾照|准考证|考号|报名号|学籍|学号|工号|编号|证号|识别号|号码|社保|公积金|银行|开户|卡号|[账帐]号|[账帐]户|手机|电话|座机|传真|邮箱|邮件|e-?mail|微信|qq|地址|住址|邮编|邮政编码|联系方式|联系人|政治面貌|党员|团员|党派|入党|入团|薪|工资|待遇|收入|salary|id(?![a-z])/i;
  // 题目写法列不全，再看回答本身：一长串数字、邮箱、网址多半是号码、联系方式，也不在本地复用。
  // 数字之间的空格、短横、括号、加号不算断开（「138-0013-8000」「+86 138 0013 8000」）；日期（「2026-07-01」）先去掉，不算号码。
  const IDENTIFIER_VALUE = /\d{5,}|@|https?:\/\/|www\./i;
  const DATE_IN_VALUE = /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}(?:\s*[-/.月]\s*\d{1,2}\s*日?)?/g;
  const NUMBER_SEPARATORS = /[\s\-—–()（）.·+]/g;
  // 题目里没有汉字的（外企网申的英文题目）不在本地复用：英文的证件、联系方式、岗位相关写法列不全，照旧交给 AI。
  const HAS_HAN = /[\u3400-\u9fff]/;
  // 题目说的是对方公司（「本公司」「我们企业」「是否有亲属在公司工作」）：换一家公司答案可能不同，
  // 等按站点存（#429 第五项第 2 点）了再在同一个站点复用。「现公司」「原单位」问的是申请人自己的经历，照常复用。
  const COMPANY_REFERENCE = /(?:[本该贵我此]|我们|你们|这家|对方)(?:公司|企业|单位|部门|机构|集团|银行|行|司|院|校)|(?:亲属|亲戚|亲友|家人|家属|配偶|直系).*(?:工作|任职|就职)/;
  // 离开所在区块就看不懂的笼统题目。
  const GENERIC_TITLE = /^(?:其[他它](?:信息|说明|情况)?|补充(?:说明|信息|内容)?|附加(?:说明|信息)?|附言|留言)$/;
  const CONTACT_SECTION = /紧急联系|联系人|监护人/;
  // 按网站存回答时的网站（#429）：几家公司共用一个域名的招聘平台，公司在路径或查询参数里。
  // 这些平台的整个域名（含子域名）都只按下面认得出的公司算，认不出就不按网站存，宁可交给 AI 也不串到别家：
  // Moka 的 {app.}mokahr.com/{campus-recruitment|campus_apply|apply|…}/{公司}/…（手机版前面多一段 m）；
  // hotjob 的 wecruit.hotjob.cn/SU{24 位十六进制}/…；
  // Greenhouse 的 {job-}boards{.eu}.greenhouse.io/{公司}/…，嵌入页 /embed/job_app?for={公司}；
  // Lever 的 jobs{.eu}.lever.co/{公司}/…。
  const MOKA_ROUTES = new Set(["campus-recruitment", "social-recruitment", "intern-recruitment", "campus_apply", "social_apply", "apply", "recommendation-apply"]);
  const TENANT_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
  // 平台自己的路径，不是公司。
  const RESERVED_SEGMENTS = new Set(["embed", "api", "v0", "v1", "jobs", "job", "apply", "search", "s", "index", "static", "assets"]);
  const companySegment = (segment) => (segment && !RESERVED_SEGMENTS.has(segment.toLowerCase()) ? segment : "");
  const PATH_TENANT_HOSTS = [
    { host: /(?:^|\.)mokahr\.com$/, tenant: (segments) => {
      const rest = segments[0] === "m" ? segments.slice(1) : segments;
      return MOKA_ROUTES.has(rest[0]) ? companySegment(rest[1]) : "";
    } },
    { host: /(?:^|\.)hotjob\.cn$/, tenant: (segments) => /^SU[0-9a-f]{24}$/i.test(segments[0] || "") ? segments[0] : "" },
    { host: /(?:^|\.)greenhouse\.io$/, tenant: (segments, url) => {
      if (!/^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(url.hostname.toLowerCase())) return "";
      return segments[0] === "embed" ? url.searchParams.get("for") || "" : companySegment(segments[0]);
    } },
    { host: /(?:^|\.)lever\.co$/, tenant: (segments, url) => /^jobs(?:\.eu)?\.lever\.co$/.test(url.hostname.toLowerCase()) ? companySegment(segments[0]) : "" }
  ];
  // 公司在查询参数里、在不认得的路径里，或者认不出来的共享站点（含子域名）：不按网站存，免得把一家公司的回答填到另一家。
  const SHARED_HOSTS = /(?:^|\.)(?:51job\.com|zhaopin\.com|nowcoder\.com|zhipin\.com|liepin\.com|lagou\.com|shixiseng\.com|yingjiesheng\.com|iguopin\.com|ncss\.cn|gaoxiaojob\.com|chinahr\.com|kanzhun\.com|wintalent\.cn|linkedin\.com|indeed\.com|ashbyhq\.com|workable\.com|smartrecruiters\.com)$/;
  // 平台本身的域名：公司在它们的子域名上（acme.zhiye.com、acme.jobs.feishu.cn），这几个域名本身不算哪一家。
  const SHARED_EXACT = /^(?:zhiye\.com|italent\.cn|jobs\.feishu\.cn)$/;
  // 和协议 isSiteKey 一样的形状：host[:port][/一段]。
  const SITE_KEY = /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?(?:\/[A-Za-z0-9_-]{1,64})?$/;
  // 只在同一个网站复用的题：题目问到对方公司。去掉「本公司」这几个字再看是不是只适用于当前岗位（「为什么选择本公司」还是）。
  const COMPANY_IN_JOB_LABEL = /[本该贵](?:公司|单位)/g;

  function text(value) {
    return String(value ?? "").trim();
  }

  function normalizeKey(value) {
    return text(value).toLowerCase().replace(/[\s:：*（）()【】[\]\-_/.·]+/g, "");
  }

  function emptyProfile() {
    return { values: {}, family: [], custom: [] };
  }

  function normalizeProfile(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const profile = emptyProfile();

    if (source.values && typeof source.values === "object") {
      for (const [id, value] of Object.entries(source.values)) {
        const clean = text(value);
        if (clean) profile.values[id] = clean;
      }
    }

    for (const member of Array.isArray(source.family) ? source.family : []) {
      if (!member || typeof member !== "object") continue;

      const relation = text(member.relation);
      const next = { relation: FAMILY_RELATIONS.includes(relation) ? relation : "其他亲属" };
      FAMILY_FIELDS.forEach((field) => {
        next[field.id] = text(member[field.id]);
      });

      if (FAMILY_FIELDS.some((field) => next[field.id])) {
        profile.family.push(next);
      }
    }

    // 值为空的补充字段也留着：那是从网页上加进来、等用户补内容的。
    // 同名的只留一条，优先留有内容的，免得先加的空行把后填的内容挤掉。
    const byKey = new Map();
    for (const item of Array.isArray(source.custom) ? source.custom : []) {
      const key = text(item?.key);
      const normalized = normalizeKey(key);
      if (!normalized) continue;

      const value = text(item?.value);
      const existing = byKey.get(normalized);
      if (existing) {
        if (!existing.value && value) existing.value = value;
        continue;
      }
      if (byKey.size >= MAX_CUSTOM_FIELDS) continue;
      byKey.set(normalized, { key, value });
    }
    profile.custom = [...byKey.values()];

    return profile;
  }

  // 同一关系有多人时加序号（兄弟姐妹1、兄弟姐妹2），只有一人时不加。
  function familyPrefixes(family) {
    const totals = {};
    family.forEach((member) => {
      totals[member.relation] = (totals[member.relation] || 0) + 1;
    });
    const seen = {};
    return family.map((member) => {
      seen[member.relation] = (seen[member.relation] || 0) + 1;
      return totals[member.relation] > 1 ? `${member.relation}${seen[member.relation]}` : member.relation;
    });
  }

  function profileToResumeFields(rawProfile) {
    const profile = normalizeProfile(rawProfile);
    const fields = [];

    PROFILE_SCHEMA.forEach((group) => {
      group.fields.forEach((field) => {
        const value = profile.values[field.id];
        if (value) fields.push({ group: group.name, key: field.key, value });
      });
    });

    const prefixes = familyPrefixes(profile.family);
    profile.family.forEach((member, index) => {
      // 家庭成员表格里常有一列「关系 / 称谓」下拉框。
      fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}关系`, value: member.relation });
      FAMILY_FIELDS.forEach((field) => {
        if (member[field.id]) fields.push({ group: FAMILY_GROUP, key: `${prefixes[index]}${field.key}`, value: member[field.id] });
      });
    });

    const emitted = new Set(fields.map((field) => normalizeKey(field.key)));
    profile.custom.forEach((item) => {
      const normalized = normalizeKey(item.key);
      if (!item.value || SECRET_LABEL.test(item.key) || SECRET_VALUE.test(item.value) || emitted.has(normalized)) return;
      emitted.add(normalized);
      fields.push({ group: CUSTOM_GROUP, key: item.key, value: item.value });
    });

    return fields;
  }

  // 旧数据迁到桌面前用（#130 PR 5）：桌面档案会随备份带走，像密码、验证码的项不收，
  // 整份送过去会被整片拒绝。这里先剔掉，与桌面 reject_profile_secrets 同一口径。
  function stripProfileSecrets(rawProfile) {
    const profile = normalizeProfile(rawProfile);
    let removed = 0;
    for (const [id, value] of Object.entries(profile.values)) {
      if (SECRET_VALUE.test(value)) {
        delete profile.values[id];
        removed += 1;
      }
    }
    profile.family = profile.family
      .map((member) => {
        const next = { ...member };
        FAMILY_FIELDS.forEach((field) => {
          if (next[field.id] && SECRET_VALUE.test(next[field.id])) {
            next[field.id] = "";
            removed += 1;
          }
        });
        return next;
      })
      .filter((member) => FAMILY_FIELDS.some((field) => member[field.id]));
    profile.custom = profile.custom.filter((item) => {
      const secret = SECRET_LABEL.test(item.key) || SECRET_VALUE.test(item.value);
      if (secret) removed += 1;
      return !secret;
    });
    return { profile, removed };
  }

  function countProfileValues(profile) {
    return profileToResumeFields(profile).length;
  }

  function countPendingFields(profile) {
    return normalizeProfile(profile).custom.filter((item) => !item.value).length;
  }

  function hasProfileContent(profile) {
    const normalized = normalizeProfile(profile);
    return Boolean(Object.keys(normalized.values).length || normalized.family.length || normalized.custom.length);
  }

  // 模板优先：模板里已有的字段名，档案里的同名字段不再加入。
  function mergeResumeFields(templateFields, profileFields) {
    const template = Array.isArray(templateFields) ? templateFields : [];
    const taken = new Set(template.map((field) => normalizeKey(field?.key)));

    return [
      ...template,
      ...(Array.isArray(profileFields) ? profileFields : []).filter((field) => !taken.has(normalizeKey(field.key)))
    ];
  }

  // 已经有着落的字段名：预置字段（字段名、界面标签、别名）、已有家庭成员的全部字段、补充字段、模板字段。
  function knownFieldKeys(rawProfile, resumeFields) {
    const profile = normalizeProfile(rawProfile);
    const keys = new Set();
    const add = (value) => {
      const normalized = normalizeKey(value);
      if (normalized) keys.add(normalized);
    };

    PROFILE_SCHEMA.forEach((group) => group.fields.forEach((field) => {
      add(field.key);
      add(field.label);
      (field.aliases || []).forEach(add);
    }));
    // 成员已经在档案里、只是某一项没填：这一项该去成员那里补，不该另起一个补充字段。
    familyPrefixes(profile.family).forEach((prefix) => {
      add(`${prefix}关系`);
      FAMILY_FIELDS.forEach((field) => add(`${prefix}${field.key}`));
    });
    profile.custom.forEach((item) => add(item.key));
    (Array.isArray(resumeFields) ? resumeFields : []).forEach((field) => add(field?.key));

    return keys;
  }

  // 经历类区块里的字段：返回要用的名字（同类概括信息）或 null（不收）。
  function entryFieldLabel(candidate) {
    const section = text(candidate?.section);
    const title = text(candidate?.title ?? candidate?.label);
    if (!section) return CONTEXTLESS_TITLE.test(title) ? null : undefined;
    if (FAMILY_SECTION.test(section)) return null;
    const entry = candidate?.sectionRepeatable || (ENTRY_SECTION.test(section) && !INTENT_SECTION.test(section));
    if (!entry) return undefined;
    return PROFILE_LIKE_TITLE.test(title) ? title : null;
  }

  // 候选字段的名字：对不上题目、噪声和敏感类控件返回空串。「加到我的信息」的两条路（只收空字段的旧筛选、
  // 连已填项一起收的候选规划）共用这一道，字段识别范围不会因为后者而变。
  function candidateLabel(candidate, stats = null) {
    const entryLabel = entryFieldLabel(candidate);
    if (entryLabel === null) {
      if (stats) stats.entry = (stats.entry || 0) + 1;
      return "";
    }
    const label = text(entryLabel ?? candidate?.label);
    const normalized = normalizeKey(label);

    if (normalized.length < 2 || label.length > MAX_OFFERED_LABEL_CHARS || NOT_A_LABEL.test(label)) return "";
    if (SKIPPED_INPUT_TYPES.has(candidate?.inputType) || SECRET_LABEL.test(label)) return "";
    if (SENSITIVE_AUTOCOMPLETE.test(text(candidate?.autocomplete))) return "";
    return label;
  }

  // #429 第五项：补充字段是用户在别的网页上答过、自己勾选存下的。网页题目按 normalizeKey 归一后和其中一项的名字完全相同，
  // 就在本地直接填这一项，不用等 AI。formFields 是要填的网页字段（fieldId、label、group），taken 是别的规则已经填上的字段，
  // pageFields 是整张表的字段，用来数同名的题（后来冒出来的字段只填新的几个，同名要和页面上原有的一起数）。
  // 不这样复用的（照旧交给 AI）：没有汉字的英文题目；SAVED_ANSWER_EXCLUDED 那几类，回答像号码、邮箱、网址的；只适用于当前岗位、公司的题（存的时候默认不勾选的那类，
  // 再加题目里说「本行」「我司」的）和整段作答；
  // 笼统的短题目；同一张表上同名的题不止一个；题在可以加多条的区块里（group 末尾带序号）、家庭成员和紧急联系人区块里，
  // 以及经历区块里除排名、外语这类概括信息以外的题（和存的时候 entryFieldLabel 的口径一样）。
  // #429 第五项第 2 点：这个网站记住的回答（SITE_GROUP，网页端只读出当前网站的）也在这里比，只用于题目问到对方公司的那类题
  // （siteScopedTitle），和补充字段的题目正好不重叠；家庭区块里问「是否有亲属在本公司工作」的也算。
  function savedAnswerMatches(formFields, resumeFields, taken = new Set(), pageFields = formFields) {
    // 资料来自 profileToResumeFields：只给有值的补充字段，归一后同名的只给一次（没填回答的只是待补的名字，不算第二个答案）。
    // 这里再数一次同名，是给不经过它的调用兜底。
    const saved = new Map();
    const site = new Map();
    (Array.isArray(resumeFields) ? resumeFields : []).forEach((field) => {
      const target = field?.group === CUSTOM_GROUP ? saved : field?.group === SITE_GROUP ? site : null;
      if (!target) return;
      const id = normalizeKey(field.key);
      const value = text(field.value);
      if (id && value) target.set(id, target.has(id) ? null : value);
    });
    if (!saved.size && !site.size) return [];

    const forms = Array.isArray(formFields) ? formFields : [];
    const sameLabel = new Map();
    (Array.isArray(pageFields) && pageFields.length ? pageFields : forms).forEach((field) => {
      const id = normalizeKey(field?.label);
      if (id) sameLabel.set(id, (sameLabel.get(id) || 0) + 1);
    });
    const matches = [];
    forms.forEach((field) => {
      if (!field?.fieldId || taken.has(field.fieldId)) return;
      const label = text(field.label);
      const id = normalizeKey(label);
      const scoped = siteScopedTitle(id);
      const value = scoped ? site.get(id) : reusableTitle(id) ? saved.get(id) : null;
      if (!value || id.length < 2 || sameLabel.get(id) > 1) return;
      if (value.length > JOB_SPECIFIC_VALUE_CHARS || looksLikeIdentifier(value)) return;
      // 「区块 2」是 field-scan 给同一区块里同名的题排的序号（`${section} ${repeatIndex}`，一定带空格）。
      // 网页自己的区块名带数字（「教育经历2」「志愿一」）不靠这一条：经历类区块由 entryFieldLabel 拦下，
      // 别的区块里同一道题出现不止一次时由上面的同名计数拦下。
      const group = text(field.group);
      if (/\s\d+$/.test(group) || CONTACT_SECTION.test(group)) return;
      if (entryFieldLabel({ section: group, title: label }) === null && !(scoped && FAMILY_SECTION.test(group))) return;
      matches.push({ fieldId: field.fieldId, value });
    });
    return matches;
  }

  function looksLikeIdentifier(value) {
    return IDENTIFIER_VALUE.test(value) || IDENTIFIER_VALUE.test(value.replace(DATE_IN_VALUE, " ").replace(NUMBER_SEPARATORS, ""));
  }

  // id 是归一后的题目。
  function reusableTitle(id) {
    return HAS_HAN.test(id) && !(SAVED_ANSWER_EXCLUDED.test(id) || JOB_SPECIFIC_LABEL.test(id) || COMPANY_REFERENCE.test(id) || SECRET_LABEL.test(id)
      || CONTEXTLESS_TITLE.test(id) || GENERIC_TITLE.test(id) || NOT_A_LABEL.test(id));
  }

  // 只在同一个网站复用的题（#429）：题目问到对方公司（「本公司」「本行」「亲属在……工作」），
  // 别的地方和补充字段一样：证件、联系方式、政治面貌、薪资，只适用于当前岗位的，像密码的，都不算。id 是归一后的题目。
  function siteScopedTitle(id) {
    return HAS_HAN.test(id) && COMPANY_REFERENCE.test(id) && !(SAVED_ANSWER_EXCLUDED.test(id) || SECRET_LABEL.test(id)
      || JOB_SPECIFIC_LABEL.test(id.replace(COMPANY_IN_JOB_LABEL, "")));
  }

  // 网址对应的网站（#429）：小写 host，去掉 www.，带非默认端口；几家公司共用一个 host 的招聘平台再加路径里的公司那一段。
  // 认不出公司的共享站点、IP v6、不是 http(s) 的返回空串：这时不按网站存，也不按网站填。
  function siteKeyOf(href) {
    let url;
    try {
      url = new URL(String(href || ""));
    } catch {
      return "";
    }
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || SHARED_HOSTS.test(host) || SHARED_EXACT.test(host)) return "";
    // 端口 0 能写进网址，协议不收（只收 1～65535）。
    if (url.port && !(Number(url.port) >= 1 && Number(url.port) <= 65535)) return "";
    let key = url.port ? `${host}:${url.port}` : host;
    const rule = PATH_TENANT_HOSTS.find((item) => item.host.test(host));
    if (rule) {
      const tenant = rule.tenant(url.pathname.split("/").filter(Boolean), url);
      if (!TENANT_SEGMENT.test(tenant || "")) return "";
      // 公司段统一小写：同一家公司在网址里大小写不同（Acme、acme）也算一个网站。
      key = `${key}/${tenant.toLowerCase()}`;
    }
    return SITE_KEY.test(key) && key.length <= 200 ? key : "";
  }

  // 桌面读回来的网站回答（{ key, value }）并进资料用的形状。
  function siteAnswerFields(answers) {
    return (Array.isArray(answers) ? answers : [])
      .filter((item) => text(item?.key) && text(item?.value))
      .map((item) => ({ group: SITE_GROUP, key: text(item.key), value: text(item.value) }));
  }

  // 家庭区块里问对方公司的题（「是否有亲属在本公司工作」）：别的家庭字段照旧不收，这一类按网站存。
  function siteFamilyLabel(candidate) {
    const section = text(candidate?.section);
    if (!FAMILY_SECTION.test(section) || candidate?.sectionRepeatable || CONTACT_SECTION.test(section)) return "";
    if (!siteScopedTitle(normalizeKey(candidate?.title ?? candidate?.label))) return "";
    return candidateLabel({ ...candidate, section: "" });
  }

  // 一次填写之后，网页上既没匹配上、也还空着的字段。密码验证码、文件、勾选框、经历类区块里的字段不算。
  function pickUnansweredLabels(candidates, knownKeys, limit = MAX_OFFERED_LABELS, stats = null) {
    const picked = [];
    const seen = new Set();

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate?.matched || candidate?.hasValue) continue;
      const label = candidateLabel(candidate, stats);
      if (!label) continue;
      const normalized = normalizeKey(label);
      if (knownKeys?.has(normalized) || seen.has(normalized)) continue;

      seen.add(normalized);
      picked.push(label);
      if (picked.length >= limit) break;
    }

    return picked;
  }

  function sameValue(left, right) {
    const squash = (value) => text(value).replace(/\s+/g, " ");
    return squash(left) === squash(right);
  }

  const SKIP_TEXT = {
    secret: (key) => `「${key}」的内容像密码或验证码，不会保存。`,
    stale: (key) => `「${key}」所在的网页内容已经变化，对不上了；重新一键填写后可再保存。`,
    "too-long": (key) => `「${key}」的内容太长，不会保存。`,
    ambiguous: (key) => `「${key}」在网页上出现多次且内容不同，没有保存。`,
    "fixed-conflict": (key) => `「${key}」在桌面已有内容（来自简历模板或预置字段），与网页不同，没有保存。`,
    "fixed-empty": (key) => `「${key}」属于简历模板或预置字段，请在桌面「我的信息」里直接填写，没有保存。`,
    same: (key) => `「${key}」桌面里已经有相同内容，没有重复保存。`,
    cleared: (key) => `「${key}」在网页上已经清空，没有保存。`,
    "value-changed": (key) => `「${key}」网页内容已变化，请核对更新后的内容再保存。`,
    "existing-changed": (key) => `「${key}」在桌面里刚有了不同的内容，没有覆盖；请重新核对后再保存。`,
    "conflict-unconfirmed": (key) => `「${key}」与桌面已有内容不同，需要勾选「替换」才会覆盖，没有保存。`,
    gone: (key) => `「${key}」在网页上找不到了，没有保存。`,
    full: (key) => `「${key}」放不下：「我的信息」已满，先在桌面删掉用不上的补充字段。`,
    "site-unfit": (key) => `「${key}」的回答太长，或像号码、联系方式，不会按网站记住。`,
    "site-full": (key) => `「${key}」放不下：这个网站已经记住了 ${MAX_SITE_ANSWERS_PER_SITE} 道题，先在桌面「网站回答」里删掉用不上的。`
  };

  function skipNote(id, key, reason) {
    return { id, key, reason, text: SKIP_TEXT[reason](key) };
  }

  // 候选规划（#189）：网页上没对上简历、也不在经历区块里的字段，连同它们此刻的内容，按桌面现有档案分好类。
  // candidates 每项是 { label, …题目信息, matched, state: ready|stale|unreadable, value, autocomplete }，
  // 内容由网页端在读取那一刻填，这里不碰页面。同名字段只留一条（id 就是规范化后的字段名）：
  //   filled   已填、可保存的新字段；completes 表示补全桌面里同名的待补充项
  //   pending  只有字段名（网页上空着，或有内容但读不出来），保存后在桌面标「待补充」
  //   conflicts 桌面同名补充字段已有不同的内容，由用户决定是否替换
  //   notes    不能保存的项和原因；same 桌面已有相同内容的项数（sameIds 是它们的 id）
  //   site     #429：只在这个网站复用的题（siteScopedTitle）和网页上的回答，存到桌面的网站回答；id 带 site: 前缀，
  //            existing 是这个网站已经记住的不同回答（要用户勾选才替换）。只有传了 site（{ answers: 桌面里这个网站的回答 }，
  //            即桌面支持而且认得出网站）才分出来；不传时这类题照旧按补充字段处理。
  //   siteWaiting  这类题网页上还空着的个数：只记回答，空着的不列；调用方据此留着候选，用户答了再列出来。
  function planProfileOffer({ candidates, profile: rawProfile, templateFields = [], limit = MAX_OFFERED_CANDIDATES, stats = null, site = null } = {}) {
    const profile = normalizeProfile(rawProfile);
    // 模板和预置字段（含家庭成员）：同名的没法再存成补充字段，存了也会被它们盖住。
    const fixedProfile = { ...profile, custom: [] };
    const fixedValues = new Map();
    mergeResumeFields(templateFields, profileToResumeFields(fixedProfile)).forEach((field) => {
      const id = normalizeKey(field?.key);
      if (id && !fixedValues.has(id)) fixedValues.set(id, text(field.value));
    });
    const fixedKeys = knownFieldKeys(fixedProfile, templateFields);
    const customByKey = new Map(profile.custom.map((item) => [normalizeKey(item.key), item]));
    const siteAnswers = site ? new Map((Array.isArray(site.answers) ? site.answers : [])
      .filter((item) => text(item?.key) && text(item?.value)).map((item) => [normalizeKey(item.key), { key: text(item.key), value: text(item.value) }])) : null;
    let siteRoom = siteAnswers ? MAX_SITE_ANSWERS_PER_SITE - siteAnswers.size : 0;

    const rank = (entry) => entry.state === "ready" ? (entry.value ? 3 : 2) : entry.state === "unreadable" ? 1 : 0;
    const merged = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate?.matched) continue;
      const label = (siteAnswers && siteFamilyLabel(candidate)) || candidateLabel(candidate, stats);
      if (!label) continue;
      const state = candidate.state === "stale" ? "stale" : candidate.state === "unreadable" ? "unreadable" : "ready";
      const entry = { id: normalizeKey(label), key: label, state, value: state === "ready" ? text(candidate.value) : "", ambiguous: false };
      const prior = merged.get(entry.id);
      if (!prior) {
        merged.set(entry.id, entry);
      } else if (prior.value && entry.value && !sameValue(prior.value, entry.value)) {
        prior.ambiguous = true;
      } else if (rank(entry) > rank(prior)) {
        merged.set(entry.id, { ...entry, key: prior.key, ambiguous: prior.ambiguous });
      }
    }

    const plan = { filled: [], pending: [], conflicts: [], site: [], siteWaiting: 0, notes: [], same: 0, sameIds: [], hidden: 0 };
    for (const entry of merged.values()) {
      const { id, key, value } = entry;
      if (entry.ambiguous) { plan.notes.push(skipNote(id, key, "ambiguous")); continue; }
      if (entry.state === "stale") { plan.notes.push(skipNote(id, key, "stale")); continue; }
      if (SECRET_VALUE.test(value)) { plan.notes.push(skipNote(id, key, "secret")); continue; }
      if (value.length > MAX_CANDIDATE_VALUE_CHARS) { plan.notes.push(skipNote(id, key, "too-long")); continue; }
      const hasValue = Boolean(value);
      const unreadable = entry.state === "unreadable";

      if (siteAnswers && siteScopedTitle(id)) {
        // 只记题目、不记回答没有用：网页上空着或读不准的不列，只数一下。
        if (!hasValue) { plan.siteWaiting += 1; continue; }
        if (value.length > JOB_SPECIFIC_VALUE_CHARS || looksLikeIdentifier(value)) { plan.notes.push(skipNote(id, key, "site-unfit")); continue; }
        // 模板或预置字段里已有同名的题、回答也一样：不用再按网站记一遍。回答不同的照样列，这个网站的答法就是要跟着网站走。
        if (fixedKeys.has(id) && sameValue(fixedValues.get(id) || "", value)) { plan.same += 1; plan.sameIds.push(`site:${id}`); continue; }
        const existing = siteAnswers.get(id);
        if (existing && sameValue(existing.value, value)) { plan.same += 1; plan.sameIds.push(`site:${id}`); continue; }
        if (plan.filled.length + plan.pending.length + plan.conflicts.length + plan.site.length >= limit) { plan.hidden += 1; continue; }
        if (!existing && siteRoom <= 0) { plan.notes.push(skipNote(id, key, "site-full")); continue; }
        if (!existing) siteRoom -= 1;
        plan.site.push({ id: `site:${id}`, key: existing?.key || key, value, existing: existing?.value || "", defaultSelected: !existing });
        continue;
      }

      if (fixedKeys.has(id)) {
        if (!hasValue) continue;
        const existing = fixedValues.get(id) || "";
        if (existing && sameValue(existing, value)) { plan.same += 1; plan.sameIds.push(id); }
        else plan.notes.push(skipNote(id, key, existing ? "fixed-conflict" : "fixed-empty"));
        continue;
      }

      const listed = plan.filled.length + plan.pending.length + plan.conflicts.length + plan.site.length;
      const custom = customByKey.get(id);
      if (custom) {
        const existing = text(custom.value);
        if (!hasValue) { plan.sameIds.push(id); continue; }
        if (existing && sameValue(existing, value)) { plan.same += 1; plan.sameIds.push(id); continue; }
        if (listed >= limit) { plan.hidden += 1; continue; }
        if (existing) plan.conflicts.push({ id, key: custom.key, value, existing });
        else {
          const jobSpecific = JOB_SPECIFIC_LABEL.test(key) || JOB_SPECIFIC_LABEL.test(custom.key)
            || value.length > JOB_SPECIFIC_VALUE_CHARS;
          plan.filled.push({ id, key: custom.key, value, completes: true, jobSpecific, defaultSelected: !jobSpecific });
        }
        continue;
      }

      if (listed >= limit) { plan.hidden += 1; continue; }
      if (hasValue) {
        const jobSpecific = JOB_SPECIFIC_LABEL.test(key) || value.length > JOB_SPECIFIC_VALUE_CHARS;
        plan.filled.push({ id, key, value, completes: false, jobSpecific, defaultSelected: !jobSpecific });
      } else {
        plan.pending.push({ id, key, unreadable });
      }
    }
    return plan;
  }

  function profileOfferSummary(plan) {
    const conflicts = plan?.conflicts?.length || 0;
    const site = plan?.site?.length || 0;
    return `可保存到我的信息：已填 ${plan?.filled?.length || 0} 项，待补 ${plan?.pending?.length || 0} 项`
      + (conflicts ? `；另有 ${conflicts} 项与桌面已有内容不同` : "")
      + (site ? `；${site} 项只在这个网站使用` : "");
  }

  function planHasOffer(plan) {
    return Boolean(plan && (plan.filled.length || plan.pending.length || plan.conflicts.length || plan.site?.length));
  }

  // 没有用户勾选信息时（页面上保留的旧按钮）：按默认勾选的项保存，冲突项从不默认替换。
  function defaultProfileSelection(plan) {
    const pick = (items, kind) => (items || []).filter((item) => item.defaultSelected)
      .map((item) => ({ id: item.id, key: item.key, kind, reviewedValue: item.value ?? "" }));
    return [...pick(plan?.filled, "filled"), ...pick(plan?.pending, "pending"), ...pick(plan?.site, "site")];
  }

  function utf8Length(value) {
    let bytes = 0;
    for (const char of String(value)) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  // 把用户勾选的项写进档案。plan 必须是点击那一刻按网页当前值和桌面最新档案重算的；
  // selection 每项 { id, key, kind, reviewedValue: 用户看到的网页值, replaceOf: 看到的桌面旧值 }。
  // 看到的和现在的对不上（网页清空了、桌面刚有了别的值）就不写，也不悄悄换成别的：照实报在 skipped 里。
  function applyProfileSelection(rawProfile, plan, selection = []) {
    const profile = normalizeProfile(rawProfile);
    const items = new Map();
    (plan?.filled || []).forEach((item) => items.set(item.id, { ...item, kind: "filled" }));
    (plan?.pending || []).forEach((item) => items.set(item.id, { ...item, kind: "pending" }));
    (plan?.conflicts || []).forEach((item) => items.set(item.id, { ...item, kind: "conflict" }));
    const notes = new Map((plan?.notes || []).map((note) => [note.id, note]));
    const sameIds = new Set(plan?.sameIds || []);

    const saved = [];
    const skipped = [];
    const seenIds = new Set();
    let full = false;
    const skip = (id, key, reason) => skipped.push(skipNote(id, key, reason));
    const fits = () => utf8Length(JSON.stringify(profile)) <= MAX_PROFILE_BYTES;

    for (const choice of Array.isArray(selection) ? selection : []) {
      const id = text(choice?.id);
      // 网站回答（#429，id 带 site:）走 applySiteSelection，这里不碰，也不报成「找不到了」。
      if (!id || id.startsWith("site:") || seenIds.has(id)) continue;
      seenIds.add(id);
      const item = items.get(id);
      const key = item?.key || notes.get(id)?.key || text(choice?.key) || id;

      if (!item) {
        const note = notes.get(id);
        if (note) skipped.push(note);
        else skip(id, key, sameIds.has(id) ? "same" : "gone");
        continue;
      }

      const seen = choice?.kind;
      if (!["filled", "pending", "conflict"].includes(seen)) { skip(id, key, "value-changed"); continue; }
      if (item.kind === "pending" && (seen === "filled" || seen === "conflict")) { skip(id, key, "cleared"); continue; }
      if (seen !== item.kind) { skip(id, key, seen === "pending" ? "value-changed" : "existing-changed"); continue; }
      if (typeof choice?.reviewedValue !== "string" || choice.reviewedValue !== (item.value ?? "")) {
        skip(id, key, "value-changed");
        continue;
      }
      if (item.kind === "conflict") {
        if (seen !== "conflict" || choice?.replaceOf === undefined) { skip(id, key, seen === "conflict" ? "conflict-unconfirmed" : "existing-changed"); continue; }
        if (!sameValue(choice.replaceOf, item.existing)) { skip(id, key, "existing-changed"); continue; }
      }

      const existing = profile.custom.find((entry) => normalizeKey(entry.key) === id);
      const before = JSON.stringify(profile.custom);
      if (existing) {
        existing.value = item.kind === "pending" ? existing.value : item.value;
      } else {
        if (profile.custom.length >= MAX_CUSTOM_FIELDS) { full = true; skip(id, key, "full"); continue; }
        profile.custom.push({ key: item.key, value: item.kind === "pending" ? "" : item.value });
      }
      if (!fits()) {
        profile.custom = JSON.parse(before);
        full = true;
        skip(id, key, "full");
        continue;
      }
      saved.push({
        id, key: existing?.key || item.key, value: item.kind === "pending" ? "" : item.value,
        kind: item.kind === "pending" ? "pending" : item.kind === "conflict" ? "replaced" : item.completes ? "completed" : "filled"
      });
    }

    return { profile, saved, skipped, full };
  }

  // 用户勾选的网站回答（#429），和 applyProfileSelection 同一套核对：plan 是点击那一刻按网页当前值和桌面里这个网站的回答重算的，
  // selection 里只看 id 带 site: 的项。看到的和现在的对不上就不存，照实报在 skipped 里。
  // 返回 answers（发给桌面的 { key, value, previous }，previous 是用户看到的桌面旧回答）和 saved、skipped。
  function applySiteSelection(plan, selection = []) {
    const items = new Map((plan?.site || []).map((item) => [item.id, item]));
    const sameIds = new Set(plan?.sameIds || []);
    const answers = [];
    const saved = [];
    const skipped = [];
    const seen = new Set();
    const skip = (id, key, reason) => skipped.push(skipNote(id, key, reason));
    for (const choice of Array.isArray(selection) ? selection : []) {
      const id = text(choice?.id);
      if (!id.startsWith("site:") || seen.has(id)) continue;
      seen.add(id);
      const item = items.get(id);
      const key = item?.key || text(choice?.key) || id.slice(5);
      if (!item) { skip(id, key, sameIds.has(id) ? "same" : "gone"); continue; }
      if (choice?.kind !== "site" || typeof choice?.reviewedValue !== "string" || choice.reviewedValue !== item.value) {
        skip(id, key, "value-changed");
        continue;
      }
      if (item.existing) {
        if (choice.replaceOf === undefined) { skip(id, key, "conflict-unconfirmed"); continue; }
        if (!sameValue(choice.replaceOf, item.existing)) { skip(id, key, "existing-changed"); continue; }
      } else if (choice.replaceOf !== undefined) {
        skip(id, key, "existing-changed");
        continue;
      }
      answers.push({ key: item.key, value: item.value, ...(item.existing ? { previous: item.existing } : {}) });
      saved.push({ id, key: item.key, value: item.value, kind: "site" });
    }
    return { answers, saved, skipped };
  }

  // 保存结果给用户看的话。saved 非空只表示桌面确认写入了这些项；skipped 里的照实列出，不混进「已保存」。
  function describeProfileSave({ saved = [], skipped = [] } = {}) {
    const filled = saved.filter((item) => item.kind !== "pending").length;
    const pending = saved.length - filled;
    const details = skipped.map((item) => item.text);
    if (!saved.length) {
      return { kind: "info", text: skipped.length ? "没有保存任何内容。" : "没有选中要保存的内容。", hint: "", details };
    }
    const kind = skipped.length ? "partial" : "success";
    if (!filled) {
      return { kind, text: `已添加 ${pending} 项待补充字段${skipped.length ? `，另有 ${skipped.length} 项没保存` : ""}。`,
        hint: "它们只存了字段名；到桌面「我的信息」补上内容后，下次填写才能用。", details };
    }
    return {
      kind,
      text: `已保存 ${saved.length} 项，下次填写可用${skipped.length ? `；另有 ${skipped.length} 项没保存` : ""}。`,
      hint: pending ? `其中 ${pending} 项只存了字段名，可稍后到桌面「我的信息」补充内容。` : "",
      details
    };
  }

  function addPendingFields(rawProfile, labels, resumeFields = []) {
    const profile = normalizeProfile(rawProfile);
    const known = knownFieldKeys(profile, resumeFields);
    let added = 0;
    let full = false;

    for (const label of Array.isArray(labels) ? labels : []) {
      const key = text(label);
      const normalized = normalizeKey(key);
      if (!normalized || known.has(normalized) || SECRET_LABEL.test(key)) continue;
      if (profile.custom.length >= MAX_CUSTOM_FIELDS) {
        full = true;
        break;
      }
      known.add(normalized);
      profile.custom.push({ key, value: "" });
      added += 1;
    }

    return { profile, added, full };
  }

  // 设置页表单读出来的一组 { kind, row, field, value }，还原成档案。
  function profileFromEntries(entries) {
    const values = {};
    const family = new Map();
    const custom = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
      const value = String(entry?.value ?? "");

      if (entry?.kind === "value") {
        values[entry.field] = value;
      } else if (entry?.kind === "family") {
        if (!family.has(entry.row)) family.set(entry.row, {});
        family.get(entry.row)[entry.field] = value;
      } else if (entry?.kind === "custom") {
        if (!custom.has(entry.row)) custom.set(entry.row, {});
        custom.get(entry.row)[entry.field] = value;
      }
    }

    return normalizeProfile({ values, family: [...family.values()], custom: [...custom.values()] });
  }

  function isSameMember(left, right) {
    if (left.relation !== right.relation) return false;
    if (SINGLE_RELATIONS.has(left.relation)) return true;
    return Boolean(left.name) && normalizeKey(left.name) === normalizeKey(right.name);
  }

  // 备份追加时用：本机已经填了的不动，只补本机空着的。
  function mergeProfiles(localProfile, incomingProfile) {
    const local = normalizeProfile(localProfile);
    const incoming = normalizeProfile(incomingProfile);

    const values = { ...incoming.values, ...local.values };

    const family = local.family.map((member) => ({ ...member }));
    incoming.family.forEach((member) => {
      const match = family.find((existing) => isSameMember(existing, member));
      if (!match) {
        family.push({ ...member });
        return;
      }
      FAMILY_FIELDS.forEach((field) => {
        if (!match[field.id] && member[field.id]) match[field.id] = member[field.id];
      });
    });

    const custom = local.custom.map((item) => {
      if (item.value) return item;
      const match = incoming.custom.find((other) => normalizeKey(other.key) === normalizeKey(item.key));
      return match?.value ? { key: item.key, value: match.value } : item;
    });
    const localKeys = new Set(local.custom.map((item) => normalizeKey(item.key)));
    incoming.custom.forEach((item) => {
      if (!localKeys.has(normalizeKey(item.key))) custom.push(item);
    });

    return normalizeProfile({ values, family, custom });
  }

  const api = {
    CUSTOM_GROUP,
    MAX_SITE_ANSWERS_PER_SITE,
    SITE_GROUP,
    SECRET_LABEL,
    SECRET_VALUE,
    FAMILY_FIELDS,
    FAMILY_GROUP,
    FAMILY_RELATIONS,
    PROFILE_SCHEMA,
    MAX_OFFERED_CANDIDATES,
    addPendingFields,
    applyProfileSelection,
    applySiteSelection,
    countPendingFields,
    countProfileValues,
    defaultProfileSelection,
    describeProfileSave,
    emptyProfile,
    hasProfileContent,
    knownFieldKeys,
    looksLikeIdentifier,
    mergeProfiles,
    mergeResumeFields,
    normalizeKey,
    normalizeProfile,
    pickUnansweredLabels,
    planHasOffer,
    planProfileOffer,
    profileFromEntries,
    profileOfferSummary,
    profileToResumeFields,
    savedAnswerMatches,
    siteAnswerFields,
    siteKeyOf,
    siteScopedTitle,
    stripProfileSecrets
  };

  globalScope.ResumeProProfile = api;

  try {
    if (typeof module === "object" && module && typeof module.exports === "object") {
      module.exports = api;
    }
  } catch {
    // A page element or frame named "module" (#275).
  }
})(typeof self !== "undefined" ? self : globalThis);
