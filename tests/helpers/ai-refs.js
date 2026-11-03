// #429 第 11 项：AI 只回资料编号，不回值。测试里的桌面替身照旧按值写回答，这里按发出去的资料目录把值换成编号；
// 值在资料里找不到的条目原样留着（worker 会丢掉带值的条目）。
function catalogOf(user) {
  const lines = String(user ?? "").split("\n");
  const at = lines.findIndex((line) => line.startsWith("简历资料目录"));
  return at >= 0 ? JSON.parse(lines[at + 1]) : [];
}

function refsFor(user, resumeFields, text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return text; }
  if (!Array.isArray(payload)) return text;
  const catalog = catalogOf(user);
  return JSON.stringify(payload.map((item) => {
    if (!item || typeof item !== "object" || item.value === undefined) return item;
    const source = (resumeFields || []).find((field) => String(field?.value) === String(item.value));
    const entry = source && catalog.find((candidate) => candidate.group === String(source.group ?? "") && candidate.key === source.key);
    if (!entry) return item;
    const { value, ...rest } = item;
    return { ...rest, ref: entry.ref };
  }));
}

// 按字段名找编号（测试直接写「这一题用哪项资料」时用）。
function refOf(user, key, group) {
  return catalogOf(user).find((entry) => entry.key === key && (group === undefined || entry.group === group))?.ref;
}

module.exports = { catalogOf, refsFor, refOf };
