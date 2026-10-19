/**
 * 事件归一化 —— F3
 *
 * 上层（会话/LLM/UI）只面对内部模型，不判断 post_type 与消息段类型。
 */

/** 会话键严格形状：group:<数字> / private:<数字>（F5） */
const CONV_KEY_RE = /^(group|private):\d+$/;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isValidConvKey(key) {
  return typeof key === 'string' && CONV_KEY_RE.test(key);
}

/**
 * 消息段 → 纯文本 + 占位说明。
 *
 * 图片/表情/语音/文件等一律降级成占位文本（首版不收语音转写，见 F3 边界）。
 *
 * @param {Array<object>} segments
 * @param {{selfId?: string}} [opts]
 */
export function segmentsToText(segments, opts = {}) {
  if (!Array.isArray(segments)) return { text: '', atSelf: false, replyTo: null };

  let text = '';
  let atSelf = false;
  let replyTo = null;

  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') {
      text += String(data.text ?? '');
    } else if (type === 'at') {
      const qq = String(data.qq ?? '');
      if (opts.selfId && qq === String(opts.selfId)) {
        atSelf = true;
        text += '@你 ';
      } else {
        text += `@${qq} `;
      }
    } else if (type === 'reply') {
      replyTo = { messageId: data.id ?? null };
    } else if (type === 'image') {
      text += '[图片]';
    } else if (type === 'face') {
      text += `[表情:${data.id ?? ''}]`;
    } else if (type === 'record') {
      text += '[语音]';
    } else if (type === 'video') {
      text += '[视频]';
    } else if (type === 'file') {
      text += '[文件]';
    } else if (type === 'forward') {
      text += '[合并转发]';
    } else {
      text += `[${type ?? '未知段'}]`;
    }
  }

  return { text: text.trim(), atSelf, replyTo };
}

/**
 * 出站文本的 CQ 码转义（防注入）。
 * 与参考项目同口径：把 `[CQ:` 变成 `[CQ：`。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeCq(text) {
  return String(text).replaceAll('[CQ:', '[CQ：');
}

/**
 * 把一条 OneBot 事件归一化成内部模型。
 *
 * @param {object} raw
 * @param {{selfId?: string}} [opts]
 * @returns {object | null} 无法识别时返回 null（不抛，避免一条脏事件打断整条管线）
 */
export function normalizeEvent(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const postType = raw.post_type;

  if (postType === 'message') {
    const isGroup = raw.message_type === 'group';
    const key = isGroup ? `group:${raw.group_id}` : `private:${raw.user_id}`;
    if (!isValidConvKey(key)) return null;

    const { text, atSelf, replyTo } = segmentsToText(raw.message, opts);
    return {
      kind: 'message',
      convKey: key,
      isGroup,
      messageId: raw.message_id ?? null,
      time: raw.time ?? Math.floor(Date.now() / 1000),
      sender: {
        userId: String(raw.user_id ?? ''),
        nickname: raw.sender?.card || raw.sender?.nickname || String(raw.user_id ?? ''),
      },
      segments: raw.message ?? [],
      text,
      atSelf,
      replyTo,
      raw,
    };
  }

  if (postType === 'message_sent') {
    const isGroup = raw.message_type === 'group';
    const key = isGroup ? `group:${raw.group_id}` : `private:${raw.user_id}`;
    if (!isValidConvKey(key)) return null;
    return {
      kind: 'self-sent',
      convKey: key,
      messageId: raw.message_id ?? null,
      time: raw.time ?? Math.floor(Date.now() / 1000),
      raw,
    };
  }

  if (postType === 'notice') {
    if (raw.notice_type === 'notify' && raw.sub_type === 'poke') {
      return {
        kind: 'poke',
        convKey: `group:${raw.group_id}`,
        from: String(raw.user_id ?? ''),
        target: String(raw.target_id ?? ''),
        time: raw.time ?? Math.floor(Date.now() / 1000),
        raw,
      };
    }
    if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
      return {
        kind: 'recall',
        convKey: raw.notice_type === 'group_recall' ? `group:${raw.group_id}` : `private:${raw.user_id}`,
        messageId: raw.message_id ?? null,
        operator: String(raw.operator_id ?? ''),
        time: raw.time ?? Math.floor(Date.now() / 1000),
        raw,
      };
    }
    return null;
  }

  if (postType === 'request') {
    // 只展示，不自动同意（F3 边界）
    return {
      kind: 'request',
      requestType: raw.request_type,
      subType: raw.sub_type,
      userId: String(raw.user_id ?? ''),
      comment: String(raw.comment ?? ''),
      time: raw.time ?? Math.floor(Date.now() / 1000),
      raw,
    };
  }

  if (postType === 'meta_event') {
    return {
      kind: 'meta',
      metaType: raw.meta_event_type,
      time: raw.time ?? Math.floor(Date.now() / 1000),
      status: raw.status ?? null,
      interval: raw.interval ?? null,
      raw,
    };
  }

  return null;
}
