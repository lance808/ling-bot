/**
 * 把 DSH 的交互请求（审批 / 提问）渲染成 QQ 里能按编号回答的形式
 *
 * ## 为什么选项必须"带过来"而不是写死
 *
 * DSH 有两类要人回答的东西，选项数量**不固定**：
 *
 * - **审批**：界面只有两个按钮，「允许一次」和「拒绝」。
 * - **提问**：`questions[].options[]` 是动态数组，可能 2 个、可能 5 个，
 *   还可能是多选、可能需要用户自己打字。
 *
 * 如果我在 QQ 端写死"1=同意 2=拒绝 3=都同意 4=中止"，
 * 那么某个提问给的第 1 项是「要求修改」时，用户回 1 就变成了同意——
 * 这是**方向性错误**，比不实现更危险。
 *
 * ## 协议的形状
 *
 * 每条推送都自带一份选项表，QQ 端只负责把数字映射回**当初发出去的那张表**：
 *
 *   编号 → 选项 key → 回传给 DSH
 *
 * 回复被接受后立刻销毁这张表：不允许对同一条推送回复两次，
 * 也不允许用旧编号去命中新请求（编号会复用）。
 *
 * ## 一条重要的取舍：不给"本会话都同意"
 *
 * DSH 的 `ApprovalOutcome` 里 **`'allowed-once'` 是唯一的授权**，
 * 没有"记住这个选择"的语义。硬造一个"以后都同意"会让我们
 * 自己维护一份 DSH 并不知情的放行状态——那等于绕过它的安全模型。
 * 所以这里只做"转述 + 回传"，不发明授权语义。
 */

/** @typedef {{key: string, label: string, detail?: string, recommended?: boolean}} Choice */

/**
 * 推荐后缀的识别规则。
 *
 * 与 DSH 界面**完全一致**（`parseRecommendedLabel`）：
 * 选项文案末尾的 `(推荐)` `（推荐）` `(recommended)` 表示推荐，
 * 中英文括号、大小写都认。
 *
 * ## 为什么不自己发明一个 recommended 字段
 *
 * `AskUserQuestionOption` 的类型里只有 `label` 和 `description`，
 * 没有推荐字段——推荐信息是**藏在 label 里的**。
 * 所以这里只能跟着解，不能另立一套。
 *
 * ## 一个必须守住的细节
 *
 * 显示时要去掉后缀（免得 QQ 里出现「只改 README (推荐) (推荐)」），
 * 但**回传时必须用原始 label**：DSH 的答案要和它发出的选项逐字相符，
 * 拿掉后缀会导致对不上。
 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

/**
 * 拆出「显示文案」和「是否推荐」。
 *
 * @param {string} label
 * @returns {{display: string, recommended: boolean}}
 */
export function splitRecommended(label) {
  const raw = String(label ?? '');
  if (RECOMMENDED_SUFFIX.test(raw)) {
    return { display: raw.replace(RECOMMENDED_SUFFIX, '').trim(), recommended: true };
  }
  return { display: raw, recommended: false };
}

/**
 * 审批 → 固定两项。
 *
 * 这两个 key 直接对应 DSH 的 `ApprovalOutcome`，
 * 也和它审批面板上的两个按钮一一对应（"允许一次" / "拒绝"）。
 *
 * ## 推荐是怎么来的
 *
 * DSH 的审批请求**不携带任何风险信息**（只有工具名和理由），
 * 界面也没有推荐按钮。所以这里的推荐只能由我们自己判断，
 * 依据是工具名——这也是唯一拿得到的信息。
 *
 * ## 判断的取向：宁可推荐"拒绝"
 *
 * 判错的代价不对称：
 *   - 该拒却推荐了允许 → 可能执行一次写文件/跑命令，不可逆
 *   - 该允却推荐了拒绝 → 用户多回一次数字，代价是几秒
 *
 * 所以只有明确属于"只读/无害"的才推荐允许，其余一律推荐拒绝。
 * 认不出来的工具也推荐拒绝（fail-safe 的方向是拒绝）。
 *
 * @param {string} [toolName]
 * @returns {{title: string, choices: Choice[]}}
 */
export function approvalChoices(toolName) {
  const risky = looksRisky(String(toolName ?? ''));
  return {
    title: '操作审批',
    choices: [
      { key: 'allowed-once', label: '允许一次', recommended: !risky },
      { key: 'rejected', label: '拒绝', recommended: risky },
    ],
  };
}

/** 明确只读、不改变任何状态的工具 */
const READ_ONLY_TOOLS = /^(?:.*(?:read|list|search|find|view|show|get|stat|head|tail|ping|query|grep|glob|ls|cat))$/i;

/**
 * 这个工具是否值得警惕。
 *
 * 规则很简单，但顺序重要：**先看不安全信号，再看只读信号**。
 * 因为一个叫 `read_and_delete` 的工具同时命中两边，
 * 先判只读就会把它当成安全的——那是最坏的误判。
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function looksRisky(toolName) {
  const name = String(toolName ?? '').trim();
  if (!name) return true; // 不知道是什么，按危险处理

  // 危险信号优先：写、删、执行、安装、上传、改权限……
  const DANGEROUS =
    /(?:write|delete|remove|rm|unlink|move|rename|exec|run|spawn|shell|command|install|upload|push|force|reset|drop|truncate|chmod|chown|kill|sudo|admin|patch|edit|create|mkdir|save|commit|apply|deploy)/i;
  if (DANGEROUS.test(name)) return true;

  // 明确只读的才放行
  if (READ_ONLY_TOOLS.test(name)) return false;

  // 认不出来：按危险处理
  return true;
}

/**
 * 一组提问 → 选项表。
 *
 * 单选题：每个选项一个编号。
 * 多选题：选项后面标「可多选」，允许回 `1,3` 这样的组合。
 * 有 `custom` 的情况：额外给一个"自己打字"的提示，但不占编号——
 * 因为用户直接回非数字内容就是自定义答案。
 *
 * @param {{questions: Array<{id: string, question: string, header?: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean}>}} req
 * @returns {{lines: string[], choices: Choice[], multiSelect: boolean, questionIds: string[]}}
 */
export function questionChoices(req) {
  const questions = Array.isArray(req?.questions) ? req.questions : [];
  const lines = [];
  /** @type {Choice[]} */
  const choices = [];

  // 号码在所有题目之间**连续编号**：用户不用记"第几题第几项"，
  // 只管回一个数字，后端按表查。
  let n = 0;
  for (const q of questions) {
    const head = String(q?.header ?? '').trim();
    if (head) lines.push(`【${head}】`);
    lines.push(String(q?.question ?? '').trim());
    const detail = String(q?.detail ?? '').trim();
    if (detail) lines.push(detail);

    // 选项**不写进 lines**：由 renderPrompt 统一渲染。
    // 这里只负责建表（编号 + 原始 label + 推荐标记）。
    const opts = Array.isArray(q?.options) ? q.options : [];
    for (const opt of opts) {
      n += 1;
      const rawLabel = String(opt?.label ?? '').trim() || `选项${n}`;
      const { recommended } = splitRecommended(rawLabel);
      const desc = String(opt?.description ?? '').trim();
      choices.push({
        key: String(n),
        // label 存**原始**文案（含后缀）：回传给 DSH 时要用它逐字匹配
        label: rawLabel,
        // detail 是给人看的补充说明
        detail: desc || undefined,
        recommended,
      });
    }
    if (q?.multiSelect) {
      lines.push('');
      lines.push('（可多选，例如回 1,3）');
    }
    lines.push('');
  }

  // 多选标记要跟着 spec 走，不能只留在 lines 里：
  // renderPrompt 未必拿得到 lines，而"能不能多选"是渲染必需要的。
  return {
    lines,
    choices,
    multiSelect: questions.some((q) => q?.multiSelect === true),
    questionIds: questions.map((q) => String(q?.id ?? '')),
  };
}

/**
 * 把一条推送渲染成完整的 QQ 文本。
 *
 * 选项**由这里统一渲染**，不从 lines 里抄。
 * 理由：推荐标记、编号、多选提示都要以 choices 为准，
 * 让两处各渲染一遍迟早会不一致（"界面有 3，后端不认 3"）。
 *
 * @param {object} req
 * @param {string} req.id 推送编号（"引用回复"就是回给它）
 * @param {string} [req.title] 标题（缺省用 spec.title）
 * @param {string} [req.kind] 'approval' | 'question'
 * @param {{title: string, choices: Choice[]}} req.spec
 * @param {string[]} [req.lines] 额外的说明性正文（**不含选项**）
 * @returns {string}
 */
export function renderPrompt(req) {
  const { id, spec } = req;
  const lines = [];

  lines.push(`【${req.title ?? spec.title ?? '待处理'}】#${id}`);

  for (const l of req.lines ?? []) {
    if (String(l).trim()) lines.push(String(l));
  }

  // 选项一律在这里渲染：编号、推荐标记、说明都取自 choices，
  // 保证"用户看到的"和"后端认的"是同一张表。
  lines.push('');
  spec.choices.forEach((c, i) => {
    const shown = splitRecommended(c.label).display;
    const mark = c.recommended ? '（推荐）' : '';
    lines.push(`${i + 1}. ${shown}${mark}${c.detail ? `　—　${c.detail}` : ''}`);
  });

  lines.push('');
  if (spec.multiSelect) {
    lines.push(`可多选：引用这条消息，回复 ${spec.choices.length > 1 ? '1,2' : '1'} 这样的组合`);
  } else {
    lines.push(
      spec.choices.length === 1
        ? `引用这条消息，回复 1`
        : `引用这条消息，回复 1~${spec.choices.length}`,
    );
  }

  return lines.join('\n');
}

/**
 * 解析用户的回复。
 *
 * 只看数字，且必须落在**当初发出的那张表**里。
 *
 * 支持的形式：
 *   - `1`            → 第 1 项
 *   - `１`           → 全角数字（手机输入法很常见）
 *   - `1,3` / `1、3` → 多选（仅 multiSelect 时接受）
 *   - `4.xxxx`       → 编号 + 补充说明（你说的「格式4.XXXX」）
 *
 * 中英文标点都要认。
 *
 * ## 逗号只能是分隔符，不能同时表示"后面是说明"
 *
 * 这里踩过一个真坑：最初把 `,` 和 `.` 一起当成"编号→说明"的分隔符，
 * 于是 `1,3`（两个选项）被解析成"选项 1，说明是 3"——
 * 单选场景下它会**默默丢掉用户选的第二项**，多选场景下更是全错。
 *
 * 两种含义挤在一个符号上，只能二选一。约定：
 *   - `,` `，` `、`  → 只作**选项分隔**
 *   - `.` `。` `:` `：` → 只作**说明分隔**
 *
 * 这样 `1,3` 是两项，`4.先备份` 是第 4 项加备注，互不干扰。
 *
 * @param {string} raw
 * @param {{choices: Choice[], multiSelect?: boolean}} spec
 * @returns {{ok: true, keys: string[], note: string} | {ok: false, reason: string}}
 */
export function parseReply(raw, spec) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: '空消息' };

  const choices = Array.isArray(spec?.choices) ? spec.choices : [];
  if (choices.length === 0) return { ok: false, reason: '这条已经没有可选的了' };

  // 全角数字 → 半角
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // 先看是不是"纯编号（可多个）"。这一步必须在前——
  // 否则 `1,3` 会被下面的说明规则吃掉。
  const pureNumbers = /^\d+(?:\s*[,，、]\s*\d+)*$/.test(normalized);

  let numberPart = normalized;
  let note = '';

  if (!pureNumbers) {
    // 编号 + 说明：只认句点/冒号，**不认逗号**
    const withNote = normalized.match(/^(\d+)\s*[.。:：]\s*([\s\S]+)$/);
    if (!withNote) {
      return { ok: false, reason: `请回复数字（1~${choices.length}）` };
    }
    numberPart = withNote[1];
    note = withNote[2].trim();
  }

  const picked = numberPart
    .split(/\s*[,，、]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (picked.length === 0) {
    return { ok: false, reason: `请回复数字（1~${choices.length}）` };
  }
  if (picked.length > 1 && spec?.multiSelect !== true) {
    return { ok: false, reason: '这一条只能选一个' };
  }

  /** @type {string[]} */
  const keys = [];
  for (const p of picked) {
    if (!/^\d+$/.test(p)) {
      return { ok: false, reason: `「${p}」不是数字` };
    }
    const idx = Number(p);
    if (idx < 1 || idx > choices.length) {
      return { ok: false, reason: `只有 1~${choices.length}，没有 ${idx}` };
    }
    const key = choices[idx - 1].key;
    if (!keys.includes(key)) keys.push(key);
  }

  return { ok: true, keys, note };
}
