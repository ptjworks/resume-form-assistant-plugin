(function attachResumeProAIHelpers(globalScope) {
  const GENERIC_ENTITY_PATTERN = /^([\u4e00-\u9fa5A-Za-z]+?)(\d+)([\u4e00-\u9fa5A-Za-z].*)$/;
  const ENTITY_LABEL_BY_GROUP = [
    { pattern: /教育/, label: "教育经历" },
    { pattern: /实习/, label: "实习经历" },
    { pattern: /工作/, label: "工作经历" },
    { pattern: /科研/, label: "科研经历" },
    { pattern: /校园/, label: "校园经历" },
    { pattern: /项目/, label: "项目经历" },
    { pattern: /论文/, label: "论文" },
    { pattern: /专利/, label: "专利" },
    { pattern: /证书/, label: "证书" },
    { pattern: /奖励/, label: "奖励" }
  ];

  const FIELD_SEMANTICS = [
    { type: "pinyin", keywords: ["拼音", "pinyin"] },
    { type: "email", keywords: ["邮箱", "email", "e-mail", "mail"] },
    { type: "phone", keywords: ["手机", "电话", "联系方式", "mobile", "phone", "联系电话"] },
    { type: "gender", keywords: ["性别", "gender"] },
    { type: "birth_date", keywords: ["出生日期", "生日", "birth", "出生年月"] },
    { type: "name", keywords: ["姓名", "name", "realname"] },
    // 证件类型只认下拉和单选（inferFieldSemantic）：号码框的占位文字可能写着「请先选择证件类型」。
    { type: "id_type", keywords: ["证件类型", "证件种类", "idtype", "idcardtype"] },
    { type: "id_number", keywords: ["身份证", "证件号码", "证件号", "idnumber", "身份证号"] },
    { type: "hometown", keywords: ["籍贯", "生源地", "户口", "户籍", "nativeplace", "hometown", "hukou"] },
    { type: "region", keywords: ["国家/地区", "国家地区", "country", "region", "地区"] },
    { type: "major", keywords: ["专业", "major"] },
    { type: "school", keywords: ["学校", "院校", "大学", "学院", "school", "university"] },
    { type: "degree", keywords: ["学历", "学位", "培养层次", "degree"] }
  ];
  // 关键词先 normalize 好：本地匹配里每一对网页字段和简历字段都要查这张表。
  const SEMANTIC_KEYWORDS = FIELD_SEMANTICS.map((item) => ({ type: item.type, keywords: item.keywords.map(normalizeText) }));
  // 「联系方式」是泛称，可能要电话也可能要邮箱：只靠它认成电话的不作数，往后看（inferFieldSemantic）。
  const CONTACT_WORD = normalizeText("联系方式");
  const PHONE_WORDS = SEMANTIC_KEYWORDS.find((item) => item.type === "phone").keywords.filter((word) => word !== CONTACT_WORD);
  // 表里没有、但看得出是别的号码的简历字段名：不是手机也不是证件号，不按值去猜。
  const OTHER_NUMBER_KEY = /微信|wechat|qq|学号|学生证|工号|准考证|考生号|报名号|学籍|证书|编号|卡号|账号|帐号|邮编|邮政编码/;
  // 字段名认不出、只能按值猜手机和证件号时用（isResumeFieldMatch）；核对手机和证件号的值时也拿来互相排除（isValueValidForField）。
  const MOBILE_VALUE = /^(\+?86)?1[3-9]\d{9}$/;
  const CN_ID_VALUE = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dxX]$/;
  // #429 18 位身份证号（GB 11643）：6 位地址码、8 位出生日期、3 位顺序码、1 位校验码（ISO 7064 MOD 11-2）。
  // 港澳台居民居住证（81、82、83 开头）和 2023 版外国人永久居留身份证（9 加省级代码开头）也是这个编法。
  // 15 位的一代证 2013 年起停用，不认。规则对照 china-id-card（MIT）自己写的，没有拷它的代码。
  const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const ID_PROVINCES = new Set("11 12 13 14 15 21 22 23 31 32 33 34 35 36 37 41 42 43 44 45 46 50 51 52 53 54 61 62 63 64 65".split(" "));
  // 号码看得出的证件类型在选项里的写法，按顺序找；选项读不到（自定义下拉）时用第一个。
  const ID_TYPE_NAMES = {
    resident: ["居民身份证"],
    hkmo: ["港澳居民居住证", "港澳台居民居住证"],
    tw: ["台湾居民居住证", "港澳台居民居住证"],
    foreign: ["外国人永久居留身份证"]
  };
  // 选项里没有分开写的居住证、只有合写的一项时选合写的（findSelectOptionIndex）。
  const JOINT_RESIDENCE = "港澳台居民居住证";
  // 资料里写的证件类型认得出是哪一种（连同 OPTION_SYNONYMS 里的写法），才拿来和号码比；认不出的不算对不上。
  const STATED_ID_TYPES = [
    ["居民身份证", ["resident"]], ["港澳居民居住证", ["hkmo"]], ["台湾居民居住证", ["tw"]], [JOINT_RESIDENCE, ["hkmo", "tw"]],
    ["外国人永久居留身份证", ["foreign"]], ["护照", []], ["港澳居民来往内地通行证", []], ["台湾居民来往大陆通行证", []]
  ];

  // #429 下拉、单选的选项和资料是同一个意思的不同写法，又不是包含关系（「汉族」对「汉」、「共青团员」对「中国共产主义青年团团员」）。
  // 每组是同一个意思的几种写法，选项里正好一项是同组的另一种写法才用它（findSelectOptionIndex）。只收确定同义的：
  // 学历和学位不混（「本科」不等于「学士」）；「群众」和「无党派人士」在国标（GB/T 4762）里是两项；
  // 「港澳通行证」也可能是内地居民往来港澳通行证，不当成回乡证。一种写法只能在一组里（tests/ai-helpers.test.js 查）。
  const ETHNIC_NAMES = ("汉 蒙古 回 藏 维吾尔 苗 彝 壮 布依 朝鲜 满 侗 瑶 白 土家 哈尼 哈萨克 傣 黎 傈僳 佤 畲 高山 拉祜 水 东乡 纳西 景颇 柯尔克孜 土 "
    + "达斡尔 仫佬 羌 布朗 撒拉 毛南 仡佬 锡伯 阿昌 普米 塔吉克 怒 乌孜别克 俄罗斯 鄂温克 德昂 保安 裕固 京 塔塔尔 独龙 鄂伦春 赫哲 门巴 珞巴 基诺").split(" ");
  // 外语等级。「四级」「六级」也是计算机等级这类题的写法，这几组只在选项里至少有两种外语等级时才用（findSelectOptionIndex）。
  const LEVEL_SYNONYMS = [
    ["CET-4", "大学英语四级", "英语四级", "四级"],
    ["CET-6", "大学英语六级", "英语六级", "六级"],
    ["TEM-4", "专业英语四级", "英语专业四级", "专四"],
    ["TEM-8", "专业英语八级", "英语专业八级", "专八"]
  ];
  const OPTION_SYNONYMS = [
    // 证件类型（#418）：「我的信息」写全称（profile-fields.js），网站常写简称，旁边还有「香港居民身份证」这类。
    ["居民身份证", "身份证", "中国居民身份证", "中华人民共和国居民身份证", "大陆居民身份证", "二代身份证"],
    ["港澳居民来往内地通行证", "回乡证"],
    ["台湾居民来往大陆通行证", "台胞证"],
    // 2017 年改名前叫「外国人永久居留证」。
    ["外国人永久居留身份证", "外国人永久居留证"],
    // 政治面貌：国标全称（GB/T 4762）、常用简称。单写「党员」不收：民主党派的党员也这么写。
    ["中共党员", "中国共产党党员", "共产党员"],
    ["中共预备党员", "中国共产党预备党员", "预备党员"],
    ["共青团员", "中国共产主义青年团团员", "团员"],
    ["民革会员", "中国国民党革命委员会会员"],
    ["民盟盟员", "中国民主同盟盟员"],
    ["民建会员", "中国民主建国会会员"],
    ["民进会员", "中国民主促进会会员"],
    ["农工党党员", "中国农工民主党党员"],
    ["致公党党员", "中国致公党党员"],
    ["台盟盟员", "台湾民主自治同盟盟员"],
    ["无党派人士", "无党派民主人士", "无党派"],
    // 民族（GB/T 3304 的 56 个民族）：带不带「族」字。
    ...ETHNIC_NAMES.map((name) => [`${name}族`, name]),
    // 学历：只收学历自己的写法，「硕士」「博士」也是学位，不放进来。
    ["大学本科", "本科"],
    ["大学专科", "专科", "大专"],
    ...LEVEL_SYNONYMS,
    // 计算机等级（NCRE）：带不带「考试」「全国」。
    ...["一", "二", "三", "四"].map((level) => [`全国计算机等级考试${level}级`, `全国计算机等级${level}级`, `计算机等级${level}级`, `计算机${level}级`]),
    // 是否题：英文表单。
    ["是", "Yes"],
    ["否", "No"],
    // 性别：英文表单。只写首字母（M、F）的不放这里，见 choiceValue。
    ["男", "男性", "Male"],
    ["女", "女性", "Female"]
    // 「中国」不当成「中国大陆」：港澳台居民的国籍也是中国，选项把港澳台分开列时照旧不选。
  ];
  const SYNONYM_GROUPS = new Map();
  for (const names of OPTION_SYNONYMS) {
    const group = { names, normalized: new Set(names.map(normalizeText)), family: LEVEL_SYNONYMS.includes(names) ? "level" : "" };
    for (const name of group.normalized) if (!SYNONYM_GROUPS.has(name)) SYNONYM_GROUPS.set(name, group);
  }

  function detectCascadeGroups(fields, fieldMap) {
    const selectFields = fields.filter((f) => f.tagName === "select");
    let cascadeGroupIndex = 0;
    const processedSelectIDs = new Set();
    const locationRegex = /(省|市|区|county|city|province)/i;

    selectFields.forEach((currentField) => {
      if (processedSelectIDs.has(currentField.fieldId)) {
        return;
      }

      const currentElement = fieldMap.get(currentField.fieldId)?.element;
      if (!currentElement) return;

      let parent = currentElement.parentElement;
      let depth = 0;

      while (parent && depth < 5) {
        const validSelectFieldsInParent = selectFields.filter((f) => {
          const el = fieldMap.get(f.fieldId)?.element;
          return el && parent.contains(el);
        });

        if (validSelectFieldsInParent.length > 1) {
          const hasLocationKeywords = validSelectFieldsInParent.some((f) =>
            locationRegex.test(f.name) || locationRegex.test(f.idAttr) || locationRegex.test(f.ariaLabel) || locationRegex.test(f.label)
          );

          let isCascade = hasLocationKeywords;

          if (!isCascade) {
             for (let i = 1; i < validSelectFieldsInParent.length; i++) {
               if (validSelectFieldsInParent[i].options.length <= 1) {
                 isCascade = true;
                 break;
               }
             }
          }

          if (isCascade) {
            const isKeywordBased = hasLocationKeywords;
            let cascadeSelects;
            if (isKeywordBased) {
              cascadeSelects = validSelectFieldsInParent.filter((f) =>
                locationRegex.test(f.name) || locationRegex.test(f.idAttr) ||
                locationRegex.test(f.ariaLabel) || locationRegex.test(f.label) ||
                f.options.length <= 1
              );
            } else {
              const firstSparseIndex = validSelectFieldsInParent.findIndex((f, i) => i > 0 && f.options.length <= 1);
              cascadeSelects = firstSparseIndex > 0
                ? validSelectFieldsInParent.filter((f, i) =>
                    i === firstSparseIndex - 1 || (i >= firstSparseIndex && f.options.length <= 1)
                  )
                : [];
            }
            if (cascadeSelects.length > 1) {
              cascadeSelects.forEach((f, idx) => {
                f.cascadeGroup = `group-${cascadeGroupIndex}`;
                f.cascadeLevel = idx;
                processedSelectIDs.add(f.fieldId);
              });
              cascadeGroupIndex++;
            }
            break;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
    });
  }

  const helpers = {
    normalizeText,
    inferFieldSemantic,
    idNumberInfo,
    buildRuleBasedMatches,
    isSecretFormField,
    isSafeResumeField,
    localRuleMatches,
    findSelectOptionIndex,
    isSameOptionText,
    optionSearchText,
    isEnglishLevelLabel,
    englishLevelSearchAlternative,
    splitMultipleValues,
    isPlaceholderOption,
    filterValidMatches,
    semanticizeParsedFields,
    normalizeParsedFields,
    normalizeDateValue,
    rangeDateValue,
    rangeDateParts,
    isPresentDate,
    detectCascadeGroups,
    isValueValidForField,
    hasRealOptions,
    choiceValue,
    controlChoiceValue,
    hasQualifiedEducationValue,
    spanSide,
    questionHint,
    valueShape,
    datePart,
    catalogKeys,
    maskResumeValues,
    looseText
  };

  globalScope.ResumeProAIHelpers = helpers;

  try {
    if (typeof module === "object" && module && typeof module.exports === "object") {
      module.exports = helpers;
    }
  } catch {
    // A page element or frame named "module" (#275).
  }

  function normalizeText(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/[\s:：*（）()【】\[\]\-_/.]+/g, "");
  }

  // 只看字段自己的文字：group 是所属区块（「联系方式」「家庭成员」），会把「地址」「QQ」也带成电话。
  // 区块只用来分清是谁的字段（personScope）。
  // 以题目为准：先只看 label，认不出再依次看 aria-label、placeholder、name、id，哪一样认得出就用哪一样。
  // 几样拼在一起按 FIELD_SEMANTICS 的顺序找，题目写「身份证号码」、name 是 mobile 的框会认成电话（排在前面）。
  // 只靠「联系方式」认成电话的（CONTACT_WORD），后面几样认得出是电话还是邮箱就照那样认，都认不出才按电话；
  // 后面认出别的类不算，「联系方式」的框 name 是 contactName 也不是姓名。同一样文字里写了邮箱的（「联系方式（邮箱）」），
  // 表里邮箱排在电话前面，先认成邮箱，轮不到这一步。
  function inferFieldSemantic(field) {
    const choice = field?.inputType === "select" || field?.inputType === "radio";
    let contact = false;
    const parts = [field?.label, field?.ariaLabel, field?.placeholder, field?.name, field?.idAttr];
    for (const [at, part] of parts.entries()) {
      const haystack = normalizeText(part);
      // 英文的「sex」按整词认，只看题目、aria-label、占位文字：Middlesex、Essex 这类校名、地名里也有这几个字母。
      const type = (haystack && SEMANTIC_KEYWORDS.find((item) => (item.type !== "id_type" || choice)
        && item.keywords.some((keyword) => haystack.includes(keyword)))?.type)
        || (at < 3 && /\bsex\b/i.test(String(part ?? "")) ? "gender" : "");
      if (!type || (contact && type !== "phone" && type !== "email")) continue;
      if (type === "phone" && !PHONE_WORDS.some((word) => haystack.includes(word))) {
        contact = true;
        continue;
      }
      return type;
    }
    return contact ? "phone" : "";
  }

  // 18 位的号码返回 { valid, kind }：校验码、出生日期和开头都对才 valid，kind 是 ID_TYPE_NAMES 里的一种，不 valid 时为空。
  // 不是 18 位数字（末位可以是 X）的返回 null。
  function idNumberInfo(value) {
    const text = String(value ?? "").replace(/\s/g, "").toUpperCase();
    if (!/^\d{17}[\dX]$/.test(text)) return null;
    const sum = ID_WEIGHTS.reduce((total, weight, i) => total + weight * Number(text[i]), 0);
    const year = Number(text.slice(6, 10));
    const month = Number(text.slice(10, 12));
    const day = Number(text.slice(12, 14));
    const birth = new Date(Date.UTC(year, month - 1, day));
    // 和本地的今天按年月日比，不按时刻。
    const now = new Date();
    const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const dateOk = year >= 1900 && birth.getUTCMonth() === month - 1 && birth.getUTCDate() === day
      && year * 10000 + month * 100 + day <= today;
    const head = text.slice(0, 2);
    const kind = ID_PROVINCES.has(head) ? "resident" : head === "81" || head === "82" ? "hkmo" : head === "83" ? "tw"
      : text[0] === "9" && ID_PROVINCES.has(text.slice(1, 3)) ? "foreign" : "";
    const valid = Boolean(kind) && dateOk && "10X98765432"[sum % 11] === text[17];
    return { valid, kind: valid ? kind : "" };
  }

  // 简历字段名是哪一类：先查 FIELD_SEMANTICS，再认 DOB 这类缩写（整个名字才算，Adobe 不算）和别的号码。
  // 认不出返回空串。只看字段名不看分组，和 inferFieldSemantic 一样：分组「联系方式」会把整组都认成电话。
  function resumeKeyType(key) {
    const type = inferFieldSemantic({ label: key });
    if (type) return type;
    const text = normalizeText(key);
    if (/^(dob|born)$/.test(text)) return "birth_date";
    return OTHER_NUMBER_KEY.test(text) ? "other" : "";
  }

  function buildRuleBasedMatches(formFields, resumeFields) {
    const strongTypes = new Set(["name", "email", "phone", "gender", "birth_date", "id_type", "id_number", "hometown", "region"]);
    const matches = [];
    const usedResumeIndexes = new Set();
    // 简历字段名的类别每项只算一次，用到时才算。
    const keyTypes = new Map();
    const keyTypeOf = (index) => {
      if (!keyTypes.has(index)) keyTypes.set(index, resumeKeyType(resumeFields[index]?.key));
      return keyTypes.get(index);
    };

    formFields.forEach((field) => {
      const semantic = inferFieldSemantic(field);

      if (!strongTypes.has(semantic)) {
        return;
      }

      const formScope = personScope(fieldContextText(field));
      if (semantic === "id_type") {
        const match = idTypeMatch(field, resumeFields, formScope, keyTypeOf);
        if (match) matches.push(match);
        return;
      }
      // #429 级联的地区题（一个「籍贯」框从省选到区县）：同一个问题下简历里分开存的省、市、县拼成一条路径（「河南省/南阳市/南召县」）。
      const composed = semantic === "hometown" && field?.cascade === true
        ? composeRegionPath(field, resumeFields, usedResumeIndexes, formScope) : null;
      if (composed && isValueValidForField(field, composed.value)) {
        matches.push({ fieldId: field.fieldId, value: composed.value });
        composed.indexes.forEach((index) => usedResumeIndexes.add(index));
        return;
      }
      const matchIndex = resumeFields.findIndex((resumeField, index) => {
        return !usedResumeIndexes.has(index) && fitsResumeField(semantic, field, resumeField, formScope, () => keyTypeOf(index));
      });

      if (matchIndex >= 0) {
        matches.push({
          fieldId: field.fieldId,
          value: choiceValue(field, resumeFields[matchIndex].value)
        });
        usedResumeIndexes.add(matchIndex);
      }
    });

    return matches;
  }

  // 一条简历资料能不能填进这个网页字段：同一个人、语义对得上、值这个字段收得下。
  // 语义对得上、但值收不下的（下拉里没有这个选项），不能占住位置，调用方接着往后找。
  function fitsResumeField(semantic, field, resumeField, formScope, keyType) {
    return isSamePersonScope(resumeField, formScope) && isResumeFieldMatch(semantic, resumeField, field, keyType)
      && isValueValidForField(field, resumeField.value);
  }

  // 证件类型拿来比的号码按普通的证件号码框取（idTypeMatch）。
  const ID_NUMBER_FIELD = { label: "证件号码", inputType: "text", options: [] };

  // #429 证件类型：号码看不出类型的照资料填。看得出的，资料没写就按号码选；资料写的和号码对不上不填，
  // 带上 blocked，填写时记作没填上（「和证件号码对不上」），也不再交给 AI。
  function idTypeMatch(field, resumeFields, formScope, keyTypeOf) {
    const own = resumeFields.filter((item) => String(item?.value ?? "").trim() && isSamePersonScope(item, formScope));
    const stated = String(own.find((item) => /证件(类型|种类)/.test(normalizeText(item.key)))?.value ?? "").trim();
    // 和证件号码框取同一条：同一个判断（fitsResumeField），按顺序取第一条。不跳过已经用掉的资料：
    // 号码框排在证件类型前面时，它用掉的正是要比的这条。
    const numberItem = resumeFields.find((item, index) => fitsResumeField("id_number", ID_NUMBER_FIELD, item, formScope, () => keyTypeOf(index)));
    const info = numberItem ? idNumberInfo(numberItem.value) : null;
    const number = info?.valid ? info : null;
    const match = (value) => ({ fieldId: field.fieldId, value });
    if (!number) return stated ? match(stated) : null;
    const names = ID_TYPE_NAMES[number.kind];
    const inferred = hasRealOptions(field) ? names.find((name) => findSelectOptionIndex(field.options, name) >= 0) : names[0];
    if (!stated) return inferred ? match(inferred) : null;
    const blocked = { ...match(stated), blocked: "id_type_mismatch" };
    // 「我的信息」的证件类型里没有居住证和永久居留证，持这几种证的只能选「其他」。
    if (/^其[他它]$/.test(stated)) return number.kind === "resident" ? blocked : match(inferred || stated);
    // 括号里的补充（「居民身份证（二代）」）不看。认不出的写法照资料填，选项里没有就交给 AI。
    const bare = stated.replace(/[（(][^）)]*[）)]/g, "");
    const kinds = STATED_ID_TYPES.find(([name]) => isSameOptionText(name, bare))?.[1];
    if (kinds && !kinds.includes(number.kind)) return blocked;
    // 资料写合写的「港澳台居民居住证」、选项分开写的：号码分得清是哪一种，按号码选。
    const fits = !hasRealOptions(field) || findSelectOptionIndex(field.options, stated) >= 0;
    return kinds && !fits && inferred ? match(inferred) : match(stated);
  }

  // 级联地区题要的整条路径：题目自己没写层级（写了「籍贯（省）」的照常只要省），简历里同一个问题至少有省和下面一级，按省、市、县拼起来。
  // 每一级只取第一项；拼上的几项都算用掉了。
  function composeRegionPath(field, resumeFields, usedResumeIndexes, formScope) {
    const ownText = normalizeText([field?.label, field?.placeholder, field?.name, field?.idAttr, field?.ariaLabel].filter(Boolean).join(" "));
    if (regionLevel(ownText)) return null;
    const byLevel = new Map();
    resumeFields.forEach((resumeField, index) => {
      if (usedResumeIndexes.has(index) || !String(resumeField?.value ?? "").trim()) return;
      if (!isSamePersonScope(resumeField, formScope) || !isSameRegionTopic(resumeField, field)) return;
      const level = regionLevel(normalizeText(resumeField.key));
      if (level && !byLevel.has(level)) byLevel.set(level, index);
    });
    const levels = ["province", "city", "county"].filter((level) => byLevel.has(level));
    if (levels.length < 2 || levels[0] !== "province") return null;
    const indexes = levels.map((level) => byLevel.get(level));
    return { value: indexes.map((index) => String(resumeFields[index].value).trim()).join("/"), indexes };
  }

  // 像密码的网页字段和简历资料不参与匹配，也不发给 AI。profile 是 profile-fields.js（ResumeProProfile）。
  function isSecretFormField(field, profile) {
    return String(field?.inputType ?? "").toLowerCase() === "password"
      || profile.SECRET_LABEL.test([field?.label, field?.name, field?.key].filter(Boolean).join(" "));
  }

  function isSafeResumeField(field, profile) {
    return !profile.SECRET_LABEL.test(String(field?.key ?? ""))
      && !profile.SECRET_VALUE.test(String(field?.value ?? ""));
  }

  // 本地规则的匹配结果（#402）：worker 的 ruleMatches、网页先填的字段和后来冒出来的字段用同一份口径。
  // #429 第五项：规则认不出的字段，再看补充字段里有没有题目原样对得上的回答（profile.savedAnswerMatches）。
  // pageFields 是整张表的字段（后来冒出来的字段只传新的几个时用），不传就是 formFields。
  function localRuleMatches(formFields, resumeFields, profile, pageFields = formFields) {
    const forms = formFields.filter((field) => !isSecretFormField(field, profile));
    const resume = resumeFields.filter((field) => isSafeResumeField(field, profile));
    const rules = filterValidMatches(forms, buildRuleBasedMatches(forms, resume));
    const taken = new Set(rules.map((match) => match.fieldId));
    const saved = typeof profile.savedAnswerMatches === "function"
      ? filterValidMatches(forms, profile.savedAnswerMatches(forms, resume, taken, pageFields)) : [];
    const occupied = new Set([...taken, ...saved.map((match) => match.fieldId)]);
    return [...rules, ...saved, ...englishResultMatches(forms, resume, pageFields, occupied)];
  }

  function filterValidMatches(formFields, matches) {
    const formFieldMap = new Map(formFields.map((field) => [field.fieldId, field]));

    return matches.filter((match) => {
      const formField = formFieldMap.get(match.fieldId);

      if (!formField) {
        return false;
      }

      // 本地规则特意不填的（blocked）照样留着：填写时要报出来，也不能让 AI 再填。
      return Boolean(match.blocked) || isValueValidForField(formField, match.value);
    });
  }

  function fieldContextText(field) {
    return normalizeText([
      field?.group,
      field?.label,
      field?.placeholder,
      field?.name,
      field?.idAttr,
      field?.ariaLabel
    ].filter(Boolean).join(" "));
  }

  // 紧急联系人、父亲、母亲、配偶是不同的人：本人的字段不取他们的值，他们的字段也不取本人的值。
  // 工行把紧急联系人放在「个人基本信息」分组下，只看字段语义会把本人的姓名和手机号填进去。
  // 「家庭成员」这类不知道具体是谁的，只用来挡住本人的值，本地规则不替它挑人。
  function personScope(text) {
    const source = String(text ?? "");
    const tags = [];

    // 传进来的是 normalizeText 之后的文字：小写、没有空格，英文词是连在一起的。
    if (/紧急联系|紧急联络|紧急电话|应急联系|监护人|emergencycontact|emergencyphone|guardian/.test(source)) tags.push("contact");
    if (/父亲|爸爸|father/.test(source)) tags.push("father");
    if (/母亲|妈妈|mother/.test(source)) tags.push("mother");
    if (/配偶|妻子|丈夫|爱人|spouse|wife|husband/.test(source)) tags.push("spouse");
    if (/家庭(?:主要)?成员|家属|家人|亲属|父母|兄弟|姐妹|子女|familymember|relative|sibling/.test(source)) tags.push("relative");

    return tags;
  }

  function isSamePersonScope(resumeField, formScope) {
    const resumeScope = personScope(normalizeText([resumeField?.group, resumeField?.key].filter(Boolean).join(" ")));

    if (!formScope.length && !resumeScope.length) {
      return true;
    }

    if (!formScope.length || !resumeScope.length) {
      return false;
    }

    return formScope.some((tag) => tag !== "relative" && resumeScope.includes(tag));
  }

  // 下拉框、单选框选值：先精确，再归一化，最后「包含」。
  // 网页选项和资料写法常对不上（本科 / 大学本科），只做全等会让大量下拉框填不上。
  // 「包含」只在唯一命中时采用：「博士」同时包含于「博士研究生」和「博士后」时宁可不选。
  function findSelectOptionIndex(options, value, englishLevel = false) {
    const list = Array.isArray(options) ? options : [];
    const target = String(value ?? "").trim();

    if (!target || !list.length) {
      return -1;
    }

    const isObject = (option) => typeof option === "object" && option !== null;
    const optionValue = (option) => String(isObject(option) ? option.value ?? "" : option ?? "").trim();
    const optionText = (option) => String(isObject(option) ? option.text ?? "" : option ?? "").trim();
    // 占位项和禁用项每一步都不算：值恰好就是「请选择」也不能当成填上了。
    const usable = list
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !isPlaceholderOption(option));
    const findUsable = (test) => usable.find(({ option }) => test(option))?.index ?? -1;

    let index = findUsable((option) => optionValue(option) === target);
    if (index >= 0) return index;

    index = findUsable((option) => optionText(option) === target);
    if (index >= 0) return index;

    const normalizedTarget = normalizeText(target);
    if (!normalizedTarget) return -1;

    index = findUsable((option) => normalizeText(optionText(option)) === normalizedTarget
      || normalizeText(optionValue(option)) === normalizedTarget);
    if (index >= 0) return index;

    // 同一个意思的另一种写法（见 OPTION_SYNONYMS）：选项里正好一项是才用它，几项都是就照下面的规则。
    // 题目没明确问英语等级时，仍要求有两种外语等级，免得计算机等级题收下「CET-4」。
    const group = SYNONYM_GROUPS.get(normalizedTarget);
    const groupOf = (option) => SYNONYM_GROUPS.get(normalizeText(optionText(option))) || SYNONYM_GROUPS.get(normalizeText(optionValue(option)));
    const outOfScope = !englishLevel && Boolean(group?.family)
      && new Set(usable.map(({ option }) => groupOf(option)).filter((other) => other?.family === group.family)).size < 2;
    const synonyms = group && !outOfScope ? usable.filter(({ option }) => groupOf(option) === group) : [];
    if (synonyms.length === 1) return synonyms[0].index;
    if (englishLevel && group?.family && synonyms.length > 1) return -1;

    if ([ID_TYPE_NAMES.hkmo[0], ID_TYPE_NAMES.tw[0]].includes(normalizedTarget)) {
      index = findUsable((option) => normalizeText(optionText(option)) === JOINT_RESIDENCE);
      if (index >= 0) return index;
    }

    // 「全日制」不能落到「非全日制」，反过来也一样。
    const negatedBefore = (text, at) => /(非|不|无|未)$/.test(text.slice(0, at));
    const targetEducation = isEducationValue(normalizedTarget);
    const targetQualified = targetEducation && isQualifiedEducationValue(normalizedTarget);
    const candidates = usable.flatMap(({ option, index: optionIndex }) => {
      const text = normalizeText(optionText(option));

      if (text.length < 2) {
        return [];
      }
      // 学历的附加说明可能是未毕业、肄业等状态，不能用包含匹配把它丢掉。
      // 可省略的培养方式由有题目上下文的 choiceValue 处理。
      if (targetEducation && isEducationValue(text) && (targetQualified || isQualifiedEducationValue(text))) return [];

      const inOption = text.indexOf(normalizedTarget);
      if (inOption >= 0) {
        return negatedBefore(text, inOption) ? [] : [optionIndex];
      }

      const inTarget = normalizedTarget.indexOf(text);
      if (inTarget >= 0) {
        return negatedBefore(normalizedTarget, inTarget) ? [] : [optionIndex];
      }

      return [];
    });

    return candidates.length === 1 ? candidates[0] : -1;
  }

  // 选项文字和要填的值是不是同一项：归一化后相同，或是同一个意思的另一种写法（OPTION_SYNONYMS）。
  // 虚拟列表只画出一部分时只认这样的一项（custom-controls.js 的 match）。外语等级要看整张列表才算数，这里不认。
  function isSameOptionText(text, value, englishLevel = false) {
    const a = normalizeText(text);
    const b = normalizeText(value);
    if (!a || !b) return false;
    const group = SYNONYM_GROUPS.get(b);
    return a === b || Boolean(group && (!group.family || englishLevel) && group.normalized.has(a));
  }

  // #429 多选（原生 select multiple、antd 和 Element 的多选下拉）要选的几项：按顿号、逗号、分号、竖线和换行拆开，
  // 去掉空项和重复的。不按斜杠、空格拆：「C/C++」「Java EE」是一项。
  // 给了选项（options）时，整段正好是其中一项（选项文字里本来就带顿号，「Java、C++」）就当这一项，不拆。
  function splitMultipleValues(value, options) {
    const whole = String(value ?? "").trim();
    const key = normalizeText(whole);
    const texts = (option) => (typeof option === "object" && option !== null ? [option.text, option.value] : [option]);
    if (key && Array.isArray(options) && options.some((option) => !isPlaceholderOption(option)
      && texts(option).some((text) => normalizeText(text) === key))) return [whole];
    const seen = new Set();
    return whole.split(/[、，,；;｜|\n]+/).map((part) => part.trim()).filter((part) => {
      const key = normalizeText(part);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 下拉框里搜索时打的字：要填的值有别的写法、且每种写法都含着其中最短的一种时打这一种
  // （「土家族」打「土家」，选项写「土家」也搜得到），否则照原样打。
  function optionSearchText(value, label) {
    const raw = educationLevelWithoutQualifier(label, value) || String(value ?? "").trim();
    const group = SYNONYM_GROUPS.get(normalizeText(raw));
    if (!group) return raw;
    const core = group.names
      .filter((name) => Array.from(group.normalized).every((other) => other.includes(normalizeText(name))))
      .sort((a, b) => a.length - b.length)[0];
    return core || raw;
  }

  function isEnglishLevelLabel(label) {
    const text = normalizeText(label);
    return /^(?:大学)?(?:英语|英文)(?:考试)?(?:水平|等级|级别|能力(?:等级)?)$/.test(text)
      || /^english(?:test)?(?:proficiency(?:level)?|level)$/.test(text);
  }

  function isEnglishScoreLabel(label) {
    return /^(?:大学)?(?:英语|英文)(?:考试|等级|级别|水平)?(?:成绩|分数)$/.test(normalizeText(label));
  }

  // #481 简历可能把考试和分数存成一项证书，例如 CET-6（587 分）。
  function cetResult(value) {
    const text = String(value ?? "").normalize("NFKC").trim();
    const match = /^(.+?)(?:\s*\(\s*(\d{1,3})\s*分?\s*\)|(?:\s+|:\s*)(\d{1,3})\s*分?)$/.exec(text);
    const group = match && SYNONYM_GROUPS.get(normalizeText(match[1]));
    return group && /^CET-[46]$/.test(group.names[0])
      ? { level: match[1].trim(), code: group.names[0], score: match[2] ?? match[3] } : null;
  }

  // 同一区块明确分开问等级和成绩，且资料只有一份无歧义的成绩时，两栏用同一个考试结果。
  function englishResultMatches(forms, resume, pageFields, occupied) {
    const levels = pageFields.filter(field => isEnglishLevelLabel(field.label) && field.multiple !== true
      && (field.inputType === "select" || field.inputType === "radio"));
    const scores = pageFields.filter(field => isEnglishScoreLabel(field.label)
      && ["text", "number"].includes(field.inputType));
    if (levels.length !== 1 || scores.length !== 1) return [];
    const [level] = levels, [score] = scores;
    if (level.group !== score.group || occupied.has(level.fieldId) || occupied.has(score.fieldId)) return [];
    const candidates = resume.map(field => cetResult(field.value)).filter(Boolean);
    const result = candidates[0];
    if (!result || candidates.some(item => item.code !== result.code || item.score !== result.score)) return [];
    // 已单独存了等级或分数时，交给已有的匹配流程，避免用另一场考试的分数覆盖。
    if (resume.some(field => isEnglishLevelLabel(field.key) || isEnglishScoreLabel(field.key)
      || /^(?:外语等级|外语成绩|外语分数)$/.test(normalizeText(field.key))
      || /^cet[46]$/.test(normalizeText(field.value)) && normalizeText(field.value) !== normalizeText(result.code))) return [];
    if (!isValueValidForField(level, result.level)) return [];
    return [{ fieldId: level.fieldId, value: result.level }, { fieldId: score.fieldId, value: result.score }]
      .filter(match => forms.some(field => field.fieldId === match.fieldId));
  }

  function englishLevelSearchAlternative(value) {
    const key = normalizeText(value);
    const group = SYNONYM_GROUPS.get(key);
    if (!group?.family) return "";
    const [code, , , shortName] = group.names;
    // 「六级」能搜到「大学英语六级」，「CET」同时兼容 CET6 和 CET-6。结果还会按具体等级核对。
    return key === normalizeText(code) ? shortName : code.split("-")[0];
  }

  // 籍贯、高考生源地、户口所在地是三个问题，不能互相顶替；同一个问题下的省、市、县也要分清。
  function regionTopic(text) {
    if (/生源地/.test(text)) return "origin";
    if (/户口|户籍|hukou/.test(text)) return "hukou";
    if (/籍贯|nativeplace|hometown/.test(text)) return "native";
    return "";
  }

  function regionLevel(text) {
    // 「地区」「区域」里的「区」不是区县。
    const source = String(text ?? "").replace(/地区|区域/g, "");

    if (/省|自治区|province/.test(source)) return "province";
    if (/市|city/.test(source)) return "city";
    if (/县|区|county|district/.test(source)) return "county";
    return "";
  }

  function isSameRegionTopic(resumeField, formField) {
    // 两边都是先看字段自己的文字，看不出来才看分组：分组名「户籍与地区」不能把「籍贯」判成户口。
    const keyText = normalizeText(resumeField?.key);
    const keyTopic = regionTopic(keyText) || regionTopic(normalizeText(resumeField?.group));

    if (!keyTopic) {
      return false;
    }

    const ownText = normalizeText([
      formField?.label,
      formField?.placeholder,
      formField?.name,
      formField?.idAttr,
      formField?.ariaLabel
    ].filter(Boolean).join(" "));
    const groupText = normalizeText(formField?.group);

    // 「户口性质」「户籍类型」问的不是地方，只接受字段名一模一样的那一项。
    if (/性质|类型|类别/.test(ownText)) {
      return Boolean(keyText) && keyText === normalizeText(formField?.label);
    }

    const formTopic = regionTopic(ownText) || regionTopic(groupText);

    if (formTopic && formTopic !== keyTopic) {
      return false;
    }

    const keyLevel = regionLevel(keyText);
    const formLevel = regionLevel(ownText) || regionLevel(groupText);

    return !(keyLevel && formLevel && keyLevel !== formLevel);
  }

  function semanticizeParsedFields(fields) {
    const buckets = new Map();

    fields.forEach((field, index) => {
      const parsed = parseGenericKey(field.group, field.key);
      const bucketKey = parsed ? `${field.group}::${parsed.entityType}::${parsed.index}` : `raw::${index}`;

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { parsed, items: [] });
      }

      buckets.get(bucketKey).items.push({ ...field, sourceIndex: index });
    });

    const renamed = [];
    const seenKeys = new Map();

    buckets.forEach(({ parsed, items }) => {
      const anchor = parsed ? findAnchorValue(items, parsed, parsed.groupName) : "";
      const entityLabel = parsed ? resolveEntityLabel(parsed.groupName, parsed.entityType) : "";

      items.forEach((item) => {
        let nextKey = item.key;

        if (parsed) {
          const detail = sanitizeDetail(parsed, item.key);
          const prefix = anchor ? `${anchor}${entityLabel}` : entityLabel;

          if (prefix) {
            nextKey = detail ? `${prefix}-${detail}` : prefix;
          }
        }

        nextKey = uniquifyKey(nextKey, seenKeys);
        renamed.push({
          group: item.group,
          key: nextKey,
          value: item.value
        });
      });
    });

    return renamed;
  }

  function normalizeParsedFields(payload) {
    if (!Array.isArray(payload)) {
      throw new Error("结果不是 JSON 数组。");
    }

    return semanticizeParsedFields(
      payload
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const group = String(item.group ?? "").trim();
          const key = String(item.key ?? "").trim();
          const value = String(item.value ?? "");

          if (!group || !key) {
            return null;
          }

          return { group, key, value };
        })
        .filter(Boolean)
    );
  }

  // 占位项和禁用项：「请选择」「--」这类，以及 disabled 的选项。
  function isPlaceholderOption(option) {
    const isObject = typeof option === "object" && option !== null;

    if (isObject && option.disabled) {
      return true;
    }

    const text = String(isObject ? option.text ?? "" : option ?? "").trim();
    // 单独的「选择」才算占位，「选择其他」是正经选项；英文的 Select… / Choose… 开头都算。
    return /^(请选择|请输入|please\s*(select|choose)|select\b|choose\b|--|—)|^选择$/i.test(text);
  }

  function isResumeFieldMatch(semantic, resumeField, formField, keyType = () => resumeKeyType(resumeField?.key)) {
    const keyText = normalizeText([resumeField?.group, resumeField?.key].filter(Boolean).join(" "));
    const value = String(resumeField?.value ?? "").trim();
    const ownKey = normalizeText(resumeField?.key);
    // 字段名自己带着「手机」「证件」这类词就算，哪怕它归到了别的类（「证件编号」算别的号码，「手机/邮箱」算邮箱）。
    // 不带的，字段名认得出是哪一类（微信、准考证号、姓名）就只按名字算，认不出的（自定义的「号码1」）才看分组名和值：
    // 手机号也是 8 到 18 位数字，纯数字的身份证号也像电话，按值算会让排在前面的那项填进另一个框；
    // 分组名同理，「证件信息」下的准考证号、「手机与微信」下的微信不是证件号码和手机。
    const byKeyName = (words, valueFits) => {
      if (words.some((word) => ownKey.includes(word))) return true;
      const type = keyType();
      return type ? type === semantic : words.some((word) => keyText.includes(word)) || valueFits();
    };
    // 按值猜时，明确是大陆手机号的不当证件号，明确是 18 位身份证号的不当电话：「号码1」「号码2」谁排前面都不互相顶替。
    const compact = value.replace(/[\s-]/g, "");

    switch (semantic) {
      case "name":
        // 分组名只给认不出的字段名用（分组「姓名」下的「中文」）；schoolName 这类认作别的类，不看分组。
        return (ownKey.includes("姓名") || (!keyType() && keyText.includes("姓名"))) && !keyText.includes("拼音");
      case "email":
        return /@/.test(value) || keyText.includes("邮箱") || keyText.includes("email");
      case "phone":
        return byKeyName(["手机", "电话"], () => /^(\+?\d[\d\s-]{7,})$/.test(value) && !CN_ID_VALUE.test(compact));
      case "gender":
        // 按值猜只收整个值就是性别的，带「女」字的经历描述不算。
        return byKeyName(["性别"], () => /^(男|女|男性|女性|male|female)$/i.test(value));
      case "birth_date":
        // 日期看不出是谁的：毕业时间、实习起止时间也是这个样子，出生日期只按名字认。
        return /出生|生日|birth/.test(ownKey) || keyType() === "birth_date";
      case "id_number":
        return byKeyName(["身份证", "证件"], () => /^[0-9xX]{8,18}$/.test(value.replace(/\s/g, "")) && !MOBILE_VALUE.test(compact));
      case "hometown":
        return isSameRegionTopic(resumeField, formField);
      case "region":
        return keyText.includes("国家") || keyText.includes("地区");
      default:
        return false;
    }
  }

  function hasRealOptions(field) {
    return Array.isArray(field?.options)
      && field.options.some((option) => !isPlaceholderOption(option) && String(typeof option === "object" && option !== null ? option.text ?? "" : option ?? "").trim());
  }

  // #429 英文表单的性别下拉只写首字母（M、F）：只在问性别的字段上，把「男」「女」换成选项里的 M、F。
  // 不放进 OPTION_SYNONYMS：「T 恤尺码」这类下拉也有 M，全局认了会把性别算成能填进去。
  const GENDER_LETTERS = [["M", ["男", "男性", "male"]], ["F", ["女", "女性", "female"]]];
  const EDUCATION_LEVEL = "博士研究生|硕士研究生|大学本科|本科|大学专科|大专|专科|中专|高中";
  const EDUCATION_LEVEL_WORD = new RegExp(EDUCATION_LEVEL);
  const PLAIN_EDUCATION_LEVEL = new RegExp(`^(?:${EDUCATION_LEVEL}|硕士|博士|研究生)$`);
  const SHORT_EDUCATION_LEVEL_WORD = /硕士|博士|研究生/;
  const EDUCATION_COMPLETION_NOTE = /在读|未毕业|未完成|未取得|肄业|结业|预计毕业/;
  const EDUCATION_QUALIFIER = "非全日制|全日制|统招|直博|普博|硕博连读|专升本|自考|成人教育";
  const QUALIFIED_EDUCATION = new RegExp(
    `^(?:(?:${EDUCATION_QUALIFIER})[,，、]?)*(${EDUCATION_LEVEL})(?:[,，、]?(?:${EDUCATION_QUALIFIER}))*$`
  );

  function isEducationLevelLabel(label) {
    return /^(?:最高|当前|在读|教育|(?:最高)?已(?:取得|获得|完成))?学历(?:层次)?$/.test(normalizeText(label));
  }

  function isEducationValue(text) {
    return PLAIN_EDUCATION_LEVEL.test(text) || EDUCATION_LEVEL_WORD.test(text)
      || (SHORT_EDUCATION_LEVEL_WORD.test(text) && EDUCATION_COMPLETION_NOTE.test(text));
  }

  function isQualifiedEducationValue(text) {
    return isEducationValue(text) && !PLAIN_EDUCATION_LEVEL.test(text);
  }

  function hasQualifiedEducationValue(field, value) {
    return inferFieldSemantic(field) === "degree" && isQualifiedEducationValue(normalizeText(value));
  }

  // 题目只问学历时，才从「全日制硕士研究生」这类写法里提取层次。
  function educationLevelWithoutQualifier(label, value) {
    if (!isEducationLevelLabel(label)) return "";
    const full = normalizeText(String(value ?? "").normalize("NFKC"));
    const level = QUALIFIED_EDUCATION.exec(full)?.[1];
    return level && level !== full ? level : "";
  }

  function choiceValue(field, value) {
    if (isEnglishLevelLabel(field?.label) || isEnglishScoreLabel(field?.label)) {
      const result = cetResult(value);
      if (result) return isEnglishScoreLabel(field.label) ? result.score : result.level;
    }
    const level = educationLevelWithoutQualifier(field?.label, value);
    if (level && hasRealOptions(field)) {
      const full = normalizeText(value);
      const available = field.options.filter(option => !isPlaceholderOption(option));
      const names = option => [option?.text ?? option, option?.value];
      if (available.some(option => names(option).some(text => normalizeText(text) === full))) return value;
      const equivalent = available.filter(option => names(option).some(text => isSameOptionText(text, level)));
      if (equivalent.length === 1) return level;
      if (equivalent.length > 1) return "";
    }
    if (inferFieldSemantic(field) !== "gender" || !hasRealOptions(field) || findSelectOptionIndex(field.options, value) >= 0) return value;
    const text = normalizeText(value);
    const letter = GENDER_LETTERS.find(([, words]) => words.includes(text))?.[0];
    return letter && findSelectOptionIndex(field.options, letter) >= 0 ? letter : value;
  }

  // 填写层（custom-controls.js、control-adapters.js）：选项这时才读到的下拉、单选，按扫描时的题目上下文再走一次 choiceValue。
  // 上下文和 content.js 发给 worker 的字段一样：字段名、占位文字，加上控件自己的 name、id、aria-label（英文表的题目可能只写在这些上）。
  function controlChoiceValue(binding, options, value) {
    if (!binding) return value;
    const attr = (name) => binding.element?.getAttribute?.(name) || "";
    return choiceValue({ label: binding.label, placeholder: binding.placeholder, name: attr("name"), idAttr: binding.element?.id || "",
      ariaLabel: attr("aria-label"), inputType: "select", options }, value);
  }

  function isValueValidForField(field, value) {
    const text = String(choiceValue(field, value) ?? "").trim();
    const semantic = inferFieldSemantic(field);

    if (!text) {
      return false;
    }

    // 只有「请选择」、选项还没加载出来的下拉框（没被识别成联动组的下一级）这里不判，
    // 交给页面填写时等选项出来再选；否则值在这里就被丢掉，页面上的重试拿不到东西。
    if ((field?.inputType === "select" || field?.inputType === "radio") && hasRealOptions(field) && field?.cascadeGroup === undefined) {
      // 和网页上实际选值用同一套规则，否则页面能选上的值会先在这里被丢掉。多选（#429）每一项都要对得上。
      const parts = field?.multiple === true ? splitMultipleValues(text, field.options) : [text];
      const englishLevel = isEnglishLevelLabel(field.label);
      if (!parts.length || parts.some((part) => findSelectOptionIndex(field.options, part, englishLevel) < 0)) {
        return false;
      }
    }

    // 手机号和纯数字的身份证号光看位数分不开，本地认错了框、AI 把两个值对调了都在这里拦下：
    // 手机框去掉空格和短横以后，不收像 18 位身份证号的值（带短横的身份证号也拦得下）；
    // 证件号码框只去空格，格式核对和排除像大陆手机号的值用同一个写法。带短横的不当证件号，
    // 去掉短横的话「010-12345678」「2001-05-07」都成了 8 到 18 位数字。
    const unspaced = text.replace(/\s/g, "");

    switch (semantic) {
      case "pinyin":
        return /^[A-Za-z\s]+$/.test(text);
      case "email":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
      case "phone":
        return /^[+\d][\d\s-]{6,}$/.test(text) && !CN_ID_VALUE.test(unspaced.replace(/-/g, ""));
      case "birth_date":
        return /(\d{4}[-/.年]\d{1,2}([-/.\月]\d{1,2}日?)?)/.test(text);
      case "gender":
        // 只写首字母的 M、F 只在选项里真有这一项时算（choiceValue 按选项换出来的）；选项要点开才看得到的，交给填写层。
        return /(男|女|male|female)/i.test(text)
          || (/^[mf]$/i.test(text) && hasRealOptions(field) && findSelectOptionIndex(field.options, text) >= 0);
      case "id_number":
        return /^[0-9xX]{8,18}$/.test(unspaced) && !MOBILE_VALUE.test(unspaced);
      case "name":
        return text.length <= 20 && !/@/.test(text) && !/\d{5,}/.test(text);
      case "hometown":
        return !/(硕|博|学位|专业|邮箱|电话|手机)/.test(text);
      default:
        return true;
    }
  }

  function parseGenericKey(groupName, key) {
    const match = String(key ?? "").trim().match(GENERIC_ENTITY_PATTERN);

    if (!match) {
      return null;
    }

    return {
      groupName,
      entityType: match[1],
      index: match[2],
      detail: match[3]
    };
  }

  function findAnchorValue(items, parsed, groupName) {
    const preferredKeywords = resolveAnchorKeywords(groupName, parsed.entityType);
    const preferredField = items.find((item) => preferredKeywords.some((keyword) => normalizeText(item.key).includes(normalizeText(keyword))) && item.value);

    if (preferredField) {
      return sanitizeAnchor(preferredField.value);
    }

    const fallbackField = items.find((item) => item.value);
    return fallbackField ? sanitizeAnchor(fallbackField.value) : "";
  }

  function resolveAnchorKeywords(groupName, entityType) {
    if (/教育/.test(groupName)) {
      return ["学校", "院校", "大学", "学院"];
    }

    if (/实习|工作/.test(groupName)) {
      return ["公司", "单位", "组织", "机构"];
    }

    if (/科研/.test(groupName)) {
      return ["课题", "实验室", "项目", "单位"];
    }

    if (/校园/.test(groupName)) {
      return ["组织", "社团", "部门", "单位"];
    }

    if (/项目/.test(groupName)) {
      return ["项目", "名称", "标题"];
    }

    if (/论文|专利|证书|奖励/.test(groupName)) {
      return ["标题", "名称", "奖项"];
    }

    return ["名称", "标题", "公司", "学校", "单位"];
  }

  function resolveEntityLabel(groupName, entityType) {
    return ENTITY_LABEL_BY_GROUP.find((item) => item.pattern.test(groupName))?.label || `${entityType}信息`;
  }

  function sanitizeDetail(parsed, originalKey) {
    return String(originalKey)
      .replace(GENERIC_ENTITY_PATTERN, "$3")
      .replace(/^(公司名|公司|单位|学校|院校|大学|学院|岗位名称|岗位|职位名称|职位|项目名称|项目|论文标题|标题|名称)/, (match) => match)
      .replace(/^[\s\-_:：]+/, "")
      .trim();
  }

  function sanitizeAnchor(value) {
    return String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 18);
  }

  function uniquifyKey(key, seenKeys) {
    const base = key || "未命名字段";
    const count = seenKeys.get(base) || 0;
    seenKeys.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  }

  function normalizeDateValue(rawValue, inputType) {
    const raw = String(rawValue ?? "").trim();

    const parsed = parseDateParts(raw);

    if (!parsed) {
      return raw;
    }

    const { year, month, day, hour, minute } = parsed;

    switch (inputType) {
      case "date":
        if (!year || !month || !day) return raw;
        return `${year}-${pad2(month)}-${pad2(day)}`;
      case "month":
        if (!year || !month) return raw;
        return `${year}-${pad2(month)}`;
      case "time":
        if (hour === null || minute === null) return raw;
        return `${pad2(hour)}:${pad2(minute)}`;
      case "datetime-local":
        if (!year || !month || !day) return raw;
        return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour ?? 0)}:${pad2(minute ?? 0)}`;
      default:
        return raw;
    }
  }

  // 日期题收到一段起止（「2019.09-2023.06」，#301 北森）：题目或占位提示写明开始还是结束，就取前一个或后一个日期。
  // 「2023.09-至今」的结束取「至今」（#429）。两样都写了（起止时间）、都没写，或不是一段起止的，原样交回，由日期控件报日期不对。
  const SPAN_DATE = /(?:19|20)\d{2}(?:\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\s*[\/\-.]\s*\d{1,2}(?!\d)(?:\s*[\/\-.]\s*\d{1,2}(?!\d))?|\s*年)?/g;
  // 「起」「止」单独成词才算（「在校时间（起）」「在校时间：止」）：「发起」「起薪」「禁止」里的不算。
  const SPAN_START = /开始|起始|入学|入职|(?:^|[\s(（【\[:：])起(?=$|[\s)）】\]:：])|\b(?:start|from|begin|enrol|admission)/i;
  const SPAN_END = /结束|截止|终止|毕业|离职|(?:^|[\s(（【\[:：])止(?=$|[\s)）】\]:：])|\b(?:end|until)\b|\bgraduat/i;
  function rangeDateValue(rawValue, hint) {
    const raw = String(rawValue ?? "").trim();
    const parts = rangeDateParts(raw);
    if (!parts) return raw;
    const side = spanSide(hint);
    return side ? parts[side === "start" ? 0 : 1] : raw;
  }

  // 判断题目要日期的哪一头、哪一部分时看的文字：题目、占位文字、aria-label、name、id（英文表常只写在 name、id 上，如 graduationMonth）。
  function questionHint(field) {
    return [field?.label, field?.placeholder, field?.ariaLabel, field?.name, field?.idAttr].filter(Boolean).join(" ");
  }

  // 题目要一段起止的哪一头：写明开始、入学这类的给 start，写明结束、毕业、离职这类的给 end；两样都写了、都没写给空串。
  function spanSide(hint) {
    const text = String(hint ?? "");
    const start = SPAN_START.test(text), end = SPAN_END.test(text);
    return start === end ? "" : start ? "start" : "end";
  }

  // #429 「至今」「现在」这类写法（和 custom-controls.js 日历认的一样）。
  const PRESENT_DATE = /^(?:至今|至今在读|今|现在|present|now|till now|to date)$/i;
  function isPresentDate(value) {
    return PRESENT_DATE.test(String(value ?? "").trim());
  }
  // 一段起止拆成开始、结束：正好两个日期（「2019.09-2023.06」），或一个日期后面跟着至今（「2023.09-至今」，结束取「至今」）。
  // 别的写法给 null。
  const SPAN_OPEN_END = /^\s*(?:(?:[\-~～—–到]|至(?!今))\s*)?(至今在读|至今|现在|今|present|now|till now|to date)\s*$/i;
  function rangeDateParts(rawValue) {
    const raw = String(rawValue ?? "").trim();
    // #481 预计毕业只是结束年月的备注。仅在两个日期的区间里忽略这一种明确尾注。
    const span = raw.replace(/\s*(?:（\s*预计毕业\s*）|\(\s*预计毕业\s*\)|预计毕业)$/, "");
    const dates = span.match(SPAN_DATE) || [];
    if (dates.length === 2 && !span.replace(SPAN_DATE, "").replace(/[\s\-~～—–至到]/g, "")) return [dates[0].trim(), dates[1].trim()];
    const open = dates.length === 1 && raw.startsWith(dates[0]) ? SPAN_OPEN_END.exec(raw.slice(dates[0].length)) : null;
    return open ? [dates[0].trim(), open[1]] : null;
  }

  function parseDateParts(raw) {
    if (/(19|20)\d{2}.+(19|20)\d{2}/.test(raw)) return null;

    const chineseMatch = raw.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?(?:[T\s](\d{1,2}):(\d{1,2}))?/);
    if (chineseMatch) {
      return {
        year: chineseMatch[1],
        month: chineseMatch[2],
        day: chineseMatch[3] || null,
        hour: chineseMatch[4] != null ? chineseMatch[4] : null,
        minute: chineseMatch[5] != null ? chineseMatch[5] : null
      };
    }

    // 分隔符两边可以带空格（「2019 - 09」「2019. 09」，#301 北森）。
    const separatorMatch = raw.match(/^(\d{4})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{1,2})(?!\d))?(?:[T\s](\d{1,2}):(\d{1,2}))?/);
    if (separatorMatch) {
      return {
        year: separatorMatch[1],
        month: separatorMatch[2],
        day: separatorMatch[3] || null,
        hour: separatorMatch[4] != null ? separatorMatch[4] : null,
        minute: separatorMatch[5] != null ? separatorMatch[5] : null
      };
    }

    const timeMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      return {
        year: null,
        month: null,
        day: null,
        hour: timeMatch[1],
        minute: timeMatch[2]
      };
    }

    return null;
  }

  function pad2(value) {
    return String(Number(value)).padStart(2, "0");
  }

  // #429 第 11 项：发给 AI 的资料目录不带值，只带按值算出的形态，字段名看不出意思（「号码1」）时 AI 靠它判断。
  // 只说形态：几位数字、邮箱、日期这类，认不出的给空串。
  function valueShape(value) {
    const text = String(value ?? "").trim();
    const compact = text.replace(/[\s-]/g, "");
    if (!text) return "";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "邮箱";
    if (MOBILE_VALUE.test(compact)) return "11 位数字";
    if (CN_ID_VALUE.test(compact)) return "18 位证件号";
    if (/^https?:\/\//i.test(text)) return "网址";
    if (rangeDateParts(text)) return "起止日期";
    if (cetResult(text)) return "大学英语考试等级及成绩";
    if (/^[\d\s年月日\/\-.:T]+$/.test(text) && parseDateParts(text)?.year) return "日期";
    if (/^\d+$/.test(compact)) return `${compact.length} 位数字`;
    return text.length > 60 ? "长文本" : "";
  }

  // 日期里的年、月或日（出生年份、毕业月份分开的下拉）。一段起止先按题目取开始或结束（rangeDateValue）。
  // 下拉读得到选项时按选项的写法给（「5」「05」「5月」），要和一个选项归一后完全相同：「9」不能靠「包含」落到「1999年」上。
  // 对不上给空串；没有选项给补零的数字。
  function datePart(value, part, field) {
    const hint = questionHint(field);
    const text = String(rangeDateValue(value, hint)).trim();
    const yearOnly = /^((?:19|20)\d{2})\s*年?$/.exec(text);
    const parsed = yearOnly ? { year: yearOnly[1] } : parseDateParts(text);
    const number = Number(parsed?.[part]);
    if (!["year", "month", "day"].includes(part) || !number) return "";
    const unit = { year: "年", month: "月", day: "日" }[part];
    const forms = part === "year" ? [String(number), `${number}${unit}`]
      : [pad2(number), String(number), `${number}${unit}`, `${pad2(number)}${unit}`];
    if (!hasRealOptions(field)) return forms[0];
    const written = field.options.filter((option) => !isPlaceholderOption(option))
      .flatMap((option) => (typeof option === "object" && option !== null ? [option.text, option.value] : [option]))
      .map(normalizeText).filter(Boolean);
    return forms.find((form) => written.includes(normalizeText(form))) || "";
  }

  // 比较字段名前缀和值时用：全角转半角（NFKC），去掉标点、符号和空格，英文不分大小写。
  function looseText(text) {
    return String(text ?? "").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  }

  // 逐字归一时的一个字：字母连同后面跟着的组合附加符（NFD 写法的「é」是「e」加一个附加符）算一个，
  // 这样逐字归一（NFKC）拼起来和整串归一的结果一样，资料值和字段名用的是同一种归一。
  const LOOSE_UNIT = /\P{M}\p{M}*|\p{M}+/gu;

  // 字段名逐字归一一次（looseText）：loose 是归一后的整串，ends[i] 是归一后第 i 个字在原字段名里结束的位置，
  // 紧跟着的标点、空格（归一后没有字）算进它。前缀比较只对 loose 做 startsWith，不再逐个前缀重新归一。
  function looseIndex(key) {
    let loose = "";
    const ends = [];
    let at = 0;
    for (const char of String(key ?? "").match(LOOSE_UNIT) || []) {
      at += char.length;
      const part = looseText(char);
      for (let i = 0; i < part.length; i += 1) ends.push(at);
      loose += part;
      if (!part && ends.length) ends[ends.length - 1] = at;
    }
    return { loose, ends };
  }

  // 桌面解析简历时，同一段经历的字段名起成「学校名或公司名 + 教育经历 - 专业」（semanticizeParsedFields），字段名里带着值。
  // 发给 AI 的目录换成「教育经历1-专业」：同一段的几项编号相同，值不出现。
  // 经历类分组里，字段名以这一组的某个值开头的，后面不管是什么，前缀都换成编号（「某校社团经历-职位」→「校园经历1-社团经历-职位」）；
  // 前缀对不上现在的值（解析以后改过学校名）时，「某某 + 教育经历」这样的也换掉，前面多长都算（英文全称常超过 18 个字）。别的字段名原样。
  // withPrefixes：同时给出编号前缀长度，以及仅供本地配对、尚未脱敏的字段名。
  function catalogKeys(resumeFields, { withPrefixes = false } = {}) {
    const labels = [...new Set(ENTITY_LABEL_BY_GROUP.map((item) => item.label))];
    const numbers = new Map();
    const made = (label, number, rest) => ({ key: `${label}${number}${rest}`, prefix: `${label}${number}`.length });
    const numberOf = (group, label, anchor) => {
      const slot = `${group}\u0000${label}`;
      if (!numbers.has(slot)) numbers.set(slot, new Map());
      const seen = numbers.get(slot);
      if (!seen.has(anchor)) seen.set(anchor, seen.size + 1);
      return seen.get(anchor);
    };
    // 每项资料的值只归一一次：完整的值（最多 80 个字）和截到 18 个字的值。
    const forms = resumeFields.map((field) => ({
      id: looseText(String(field?.value ?? "")),
      texts: [...new Set([looseText(sanitizeAnchor(field?.value)), looseText(String(field?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 80))])]
    }));
    const renamed = resumeFields.map((field) => {
      const key = String(field?.key ?? "");
      const group = String(field?.group ?? "");
      const groupLabel = ENTITY_LABEL_BY_GROUP.find((item) => item.pattern.test(group))?.label;
      // 前缀和值按 looseText 比：全角半角、标点、空格不同（「（南校区）」对「(南校区)」）也算同一个值。
      // 解析时字段名只带值的前 18 个字（sanitizeAnchor），改过的可能带着全名：两种都比，取对得上的最长一段。
      // 编号按这一项的完整值分：前 18 个字一样的两所学校不合成一段。字段名里看不出是哪一项时（只带前 18 个字），
      // 按桌面给重名字段名加的「 (2)」认：第 n 段就是这个前缀下的第 n 个值；同一所学校的两段经历也靠它分开。
      const suffix = Number(/\s\((\d+)\)$/.exec(key)?.[1] || 1);
      const index = looseIndex(key);
      const anchors = resumeFields.flatMap((other, at) => (other?.group !== field?.group ? [] : forms[at].texts.map((text) => ({
        id: forms[at].id, owner: String(other?.key ?? ""),
        length: text.length >= 2 && index.loose.startsWith(text) ? index.ends[text.length - 1] : 0
      }))))
        .filter((item) => item.length > 0)
        .sort((a, b) => b.length - a.length);
      const entryOf = (length) => {
        const ids = [...new Set(anchors.filter((item) => item.length === length).map((item) => item.id))];
        return `${ids[Math.min(ids.length, suffix) - 1]}#${suffix}`;
      };
      const tail = (text) => text.replace(/\s\(\d+\)$/, "");
      for (const { length, owner } of anchors) {
        const rest = key.slice(length);
        const label = labels.find((item) => rest.startsWith(item)) || /^[\u4e00-\u9fa5A-Za-z]+?信息(?=-|$|\s\()/.exec(rest)?.[0];
        if (!label) continue;
        // 经历类以外的分组只换同一段自己的前缀：给出这个值的那项，字段名也是这个前缀加同一个标签（解析出来的「某奖项名奖项信息」）；
        // 以别的字段的值开头的字段名原样留着。
        if (!groupLabel && !owner.startsWith(key.slice(0, length) + label)) continue;
        return made(label, numberOf(group, label, entryOf(length)), tail(rest.slice(label.length)));
      }
      if (!groupLabel) return { key, prefix: 0 };
      if (anchors.length) {
        const rest = tail(key.slice(anchors[0].length)).replace(/^[\s\-_:：]+/, "");
        return made(groupLabel, numberOf(group, groupLabel, entryOf(anchors[0].length)), rest ? `-${rest}` : "");
      }
      for (const label of labels) {
        const at = key.indexOf(label);
        if (at >= 1 && /^(?:-|$|\s\()/.test(key.slice(at + label.length))) {
          return made(label, numberOf(group, label, `${looseText(key.slice(0, at))}#${suffix}`), tail(key.slice(at + label.length)));
        }
      }
      return { key, prefix: 0 };
    });
    const prefixes = renamed.map((item) => item.prefix);
    const keys = maskResumeValues(renamed.map((item) => item.key), resumeFields,
      { labels: renamed.map((item) => item.key), groups: resumeFields.map((field) => field?.group), prefixes });
    return withPrefixes ? { keys, prefixes, recordKeys: renamed.map(item => item.key) } : keys;
  }

  // 人名类字段（本人、家庭成员、配偶、紧急联系人、推荐人的姓名，曾用名）：值 2 个字起就遮，出现在哪段文字里都换。
  const NAME_KEY = /姓名|名字|曾用名|(?:联系|推荐|介绍|证明)人(?!.*(?:关系|电话|手机|邮箱|单位|职务))|\b(?:(?:first|last|given|family|full|middle|maiden)\s*name|surname|name)\b/i;
  // 学校、公司、城市、地址、证件、联系方式这类字段（按字段名认），和人名类一样：值再短也能认出人。
  const IDENTIFYING_KEY = /学校|院校|大学|学院|公司|单位|企业|雇主|城市|省份|地区|所在地|居住|籍贯|户籍|户口所在|生源地|地址|住址|证件|身份证|护照|手机|电话|邮箱|微信|qq|联系方式|\b(?:school|university|college|company|employer|city|address|phone|mobile|email|wechat)\b/i;
  const PLACEHOLDER_LIMIT = 20;
  // #429 第 11 项：发给 AI 的目录文字（字段名、分组名）里能认出人的资料值，一律换成占位「〔那项资料的字段名〕」；
  // 那项资料的字段名自己带着资料值或超过 20 个字时用「〔资料值〕」。不按字段豁免，同样的字在哪段文字里都换。
  // 能认出人的值：带数字的、归一后 4 个字及以上的，或人名、学校、公司、城市、地址、证件、联系方式这类字段的值（NAME_KEY、IDENTIFYING_KEY）。
  // 别的是短常用词（是、否、男、本科、汉族、父亲、服从），留在题目里，「是否服从调剂」「父亲姓名」不会被弄坏。
  // 值按 looseText 比，至少 2 个字；只有数字、不到 5 位的（年龄、名次、年份）不算更长一串数字里的一段（「22」不算「2022届」里的）。
  // 几项资料的值都对得上时先换最长的；同样长的先认同一分组的那项（groups[i] 是第 i 段文字所在的分组）。
  // prefixes[i]：第 i 段开头这么多字是 catalogKeys 这次起的编号（「实习经历1」），不在里面找；
  // 原样的字段名、分组名没有这一段，从头找（以「实习经历」开头、后面跟着手机号的原样文字也遮）。
  // 资料值和要找的文字按同一种方式归一（looseText，逐字时字母连同组合附加符算一个字），记着归一后每个字在原文里的位置。
  // labels[i] 是第 i 项资料在目录里的字段名，做占位用。
  function maskResumeValues(texts, resumeFields, { labels = [], groups = [], prefixes = [] } = {}) {
    const values = resumeFields.flatMap((field, owner) => {
      const value = String(field?.value ?? "");
      const key = String(field?.key ?? "");
      const named = NAME_KEY.test(key) || IDENTIFYING_KEY.test(key);
      return [...new Set([looseText(value), looseText(sanitizeAnchor(value)), looseText(value.replace(/\s+/g, " ").trim().slice(0, 80))])]
        .filter((text) => text.length >= 2 && (named || /\d/.test(text) || text.length >= 4))
        .map((text) => ({ text, owner, group: field?.group, number: /^\d{2,4}$/.test(text) }));
    });
    const byGroup = new Map();
    const rankedFor = (group) => {
      if (!byGroup.has(group)) {
        byGroup.set(group, [...values].sort((a, b) => b.text.length - a.text.length || Number(b.group === group) - Number(a.group === group)));
      }
      return byGroup.get(group);
    };
    const hitsIn = (text, group, from = 0) => {
      const chars = [];
      let loose = "";
      let offset = 0;
      for (const char of text.match(LOOSE_UNIT) || []) {
        const part = looseText(char);
        for (let i = 0; i < part.length; i += 1) chars.push([offset, offset + char.length]);
        loose += part;
        offset += char.length;
      }
      const taken = [];
      for (const { text: value, owner, number } of rankedFor(group)) {
        for (let hit = loose.indexOf(value); hit >= 0; hit = loose.indexOf(value, hit + 1)) {
          const start = chars[hit][0];
          const end = chars[hit + value.length - 1][1];
          if (start < from || taken.some((span) => start < span.end && span.start < end)) continue;
          if (number && /\d/.test((loose[hit - 1] ?? "") + (loose[hit + value.length] ?? ""))) continue;
          taken.push({ start, end, owner });
        }
      }
      return taken.sort((a, b) => b.start - a.start);
    };
    const names = new Map();
    const nameOf = (owner) => {
      if (!names.has(owner)) {
        const label = String(labels[owner] ?? "");
        const clean = label && label.length <= PLACEHOLDER_LIMIT && !label.includes("〔") && !hitsIn(label, resumeFields[owner]?.group).length;
        names.set(owner, clean ? label : "资料值");
      }
      return names.get(owner);
    };
    const done = new Map();
    return texts.map((text, at) => {
      const slot = JSON.stringify([String(text ?? ""), groups[at] ?? null, prefixes[at] || 0]);
      if (!done.has(slot)) {
        done.set(slot, hitsIn(String(text ?? ""), groups[at], prefixes[at] || 0)
          .reduce((out, { start, end, owner }) => `${out.slice(0, start)}〔${nameOf(owner)}〕${out.slice(end)}`, String(text ?? "")));
      }
      return done.get(slot);
    });
  }
})(typeof self !== "undefined" ? self : globalThis);
