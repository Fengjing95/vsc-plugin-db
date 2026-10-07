import { describe, expect, it } from 'vitest';
import {
  filterSuggestions,
  initialDbSuggestState,
  reduceDbFetchFailure,
  reduceDbFetchStart,
  reduceDbFetchSuccess,
  shouldFetchDbOptions,
  suggestionFingerprint,
  suggestionsVisible,
} from './dbSuggest';

/** 连接表单动态建议状态机（M8-PG B5，交互稿 §3.2）：focus 触发、指纹去重、失败无感 */
describe('shouldFetchDbOptions', () => {
  it('idle：需要拉取', () => {
    expect(shouldFetchDbOptions(initialDbSuggestState, 'fp1')).toBe(true);
  });
  it('loading：在途不重复拉取', () => {
    expect(shouldFetchDbOptions({ status: 'loading', fingerprint: 'fp1', items: [] }, 'fp1')).toBe(false);
  });
  it('ready 同指纹：命中缓存不拉取；指纹变化：重新拉取', () => {
    const ready = { status: 'ready' as const, fingerprint: 'fp1', items: ['postgres'] };
    expect(shouldFetchDbOptions(ready, 'fp1')).toBe(false);
    expect(shouldFetchDbOptions(ready, 'fp2')).toBe(true);
  });
  it('failed 同指纹：下次聚焦允许重试（用户驱动不连击）', () => {
    expect(shouldFetchDbOptions({ status: 'failed', fingerprint: 'fp1', items: [] }, 'fp1')).toBe(true);
  });
});

describe('reduces', () => {
  it('start：进入 loading、清空候选、记录指纹', () => {
    const next = reduceDbFetchStart({ status: 'failed', fingerprint: 'fp1', items: [] }, 'fp2');
    expect(next).toEqual({ status: 'loading', fingerprint: 'fp2', items: [] });
  });
  it('success：就绪并缓存候选', () => {
    const loading = { status: 'loading' as const, fingerprint: 'fp1', items: [] };
    expect(reduceDbFetchSuccess(loading, 'fp1', ['postgres', 'app'])).toEqual({
      status: 'ready',
      fingerprint: 'fp1',
      items: ['postgres', 'app'],
    });
  });
  it('success 迟到回包：指纹已变则丢弃（防护过期候选）', () => {
    const loadingNew = { status: 'loading' as const, fingerprint: 'fp2', items: [] };
    expect(reduceDbFetchSuccess(loadingNew, 'fp1', ['stale'])).toBe(loadingNew);
  });
  it('failure：清空候选保持非 ready（下次聚焦重试）', () => {
    const next = reduceDbFetchFailure({ status: 'loading', fingerprint: 'fp1', items: [] }, 'fp1');
    expect(next).toEqual({ status: 'failed', fingerprint: 'fp1', items: [] });
  });
  it('failure 迟到回包：指纹已变则丢弃', () => {
    const loadingNew = { status: 'loading' as const, fingerprint: 'fp2', items: [] };
    expect(reduceDbFetchFailure(loadingNew, 'fp1')).toBe(loadingNew);
  });
});

describe('suggestionFingerprint', () => {
  it('null/undefined 归一为 null；数组序即指纹语义', () => {
    expect(suggestionFingerprint(['pg', '127.0.0.1', undefined])).toBe(
      suggestionFingerprint(['pg', '127.0.0.1', null]),
    );
    expect(suggestionFingerprint(['a'])).not.toBe(suggestionFingerprint(['b']));
  });
});

describe('filterSuggestions', () => {
  const items = ['postgres', 'PostgresX', 'app_db', 'reporting'];
  it('空输入给全量；子串大小写不敏感；无匹配为空数组', () => {
    expect(filterSuggestions(items, '')).toEqual(items);
    expect(filterSuggestions(items, '  ')).toEqual(items);
    expect(filterSuggestions(items, 'POST')).toEqual(['postgres', 'PostgresX']);
    expect(filterSuggestions(items, '_db')).toEqual(['app_db']);
    expect(filterSuggestions(items, 'zzz')).toEqual([]);
  });
});

describe('suggestionsVisible', () => {
  it('仅 ready 且指纹一致可见', () => {
    expect(suggestionsVisible({ status: 'ready', fingerprint: 'fp1', items: ['a'] }, 'fp1')).toBe(true);
    expect(suggestionsVisible({ status: 'ready', fingerprint: 'fp1', items: ['a'] }, 'fp2')).toBe(false);
    expect(suggestionsVisible({ status: 'loading', fingerprint: 'fp1', items: [] }, 'fp1')).toBe(false);
  });
});
