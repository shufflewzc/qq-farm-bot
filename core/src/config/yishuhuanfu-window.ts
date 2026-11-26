// Registered activity window. The live group response further constrains actions.
export const YISHU_START_MS = 1795564800000;
export const YISHU_END_MS = 1796860800000;
export const YISHU_UPDATED_AT_SEC = Date.parse('2026-11-26T00:00:00+08:00') / 1000;

export const YISHU_DAILY_DEFAULT_TIME = '00:20';

export const YISHU_ACTION_FLAGS = [
    'yishu_claim_seed', 'yishu_share', 'yishu_auto_sell', 'yishu_claim_commission',
] as const;

export const YISHU_TUNING_KEYS: ReadonlySet<string> = new Set([
    'yishu_scan_friend_limit', 'yishu_scan_interval_minutes', 'yishu_sell_min_count', 'yishu_sell_after_time', 'yishu_daily_time',
]);

export function normalizeYishuDailyTime(value: unknown): string {
    const match = /^(\d{1,2})[:：](\d{2})$/.exec(String(value ?? '').trim());
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return YISHU_DAILY_DEFAULT_TIME;
    return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function isYishuWindowOpen(nowMs = Date.now()): boolean {
    return nowMs >= YISHU_START_MS && nowMs < YISHU_END_MS;
}

export function expiredYishuSwitches(automation: Partial<Record<typeof YISHU_ACTION_FLAGS[number], boolean>>, nowMs = Date.now()) {
    if (nowMs < YISHU_END_MS || !YISHU_ACTION_FLAGS.some(key => automation[key] === true)) return null;
    return Object.fromEntries(YISHU_ACTION_FLAGS.map(key => [key, false]));
}
