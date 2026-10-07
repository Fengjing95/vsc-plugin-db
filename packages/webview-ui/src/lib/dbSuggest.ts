/**
 * 连接表单「默认库」动态建议状态机（M8-PG B5，交互稿 §3.2 动态建议字段）。
 * 契约（驱动规范 §3.1 @since v0.1.4）：字段聚焦触发拉取、按参数指纹缓存去重、
 * 失败无感降级——不显示任何错误，输入与保存不受影响。纯函数，有单测。
 */

export interface DbSuggestState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  /** 本次状态对应的参数指纹（host/port/用户名/密码/驱动/连接 id） */
  fingerprint: string;
  /** 候选库列表（仅 status=ready 且指纹匹配当前表单时对用户可见） */
  items: string[];
}

export const initialDbSuggestState: DbSuggestState = { status: 'idle', fingerprint: '', items: [] };

/** 参数指纹：任一影响列库结果的输入变化后，下一次聚焦才重新拉取 */
export function suggestionFingerprint(parts: Array<string | null | undefined>): string {
  return JSON.stringify(parts.map((p) => p ?? null));
}

/** 是否需要拉取：在途不重复；同指纹已就绪不重复；失败后再次聚焦允许重试（用户驱动，不连击） */
export function shouldFetchDbOptions(state: DbSuggestState, fingerprint: string): boolean {
  if (state.status === 'loading') {
    return false;
  }
  return !(state.status === 'ready' && state.fingerprint === fingerprint);
}

export function reduceDbFetchStart(state: DbSuggestState, fingerprint: string): DbSuggestState {
  return { status: 'loading', fingerprint, items: [] };
}

export function reduceDbFetchSuccess(
  state: DbSuggestState,
  fingerprint: string,
  items: string[],
): DbSuggestState {
  // 迟到回包防护：请求发出后指纹已变 → 丢弃（下次聚焦按新指纹重拉）
  if (state.status === 'loading' && state.fingerprint !== fingerprint) {
    return state;
  }
  return { status: 'ready', fingerprint, items };
}

export function reduceDbFetchFailure(state: DbSuggestState, fingerprint: string): DbSuggestState {
  if (state.status === 'loading' && state.fingerprint !== fingerprint) {
    return state;
  }
  // 失败不缓存候选：保持非 ready，下次聚焦重试；items 清空避免展示过时建议
  return { status: 'failed', fingerprint, items: [] };
}

/** 建议过滤：按当前输入子串大小写不敏感匹配；输入为空给全量 */
export function filterSuggestions(items: string[], input: string): string[] {
  const kw = input.trim().toLowerCase();
  if (kw === '') {
    return items;
  }
  return items.filter((name) => name.toLowerCase().includes(kw));
}

/** 建议是否对用户可见：状态就绪且指纹与当前表单一致（迟到/过期回包不展示） */
export function suggestionsVisible(state: DbSuggestState, fingerprint: string): boolean {
  return state.status === 'ready' && state.fingerprint === fingerprint;
}
