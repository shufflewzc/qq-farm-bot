import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isYishuWindowOpen, normalizeYishuDailyTime, YISHU_ACTION_FLAGS as YISHU_AUTOMATION_KEYS } from '../config/yishuhuanfu-window';

const { ensureDataDir, getDataFile } = require('../config/runtime-paths');

// 以薯换福的自动任务，按本项目既有习惯挂在 worker 的 scheduler 上，并串进
// automation-lock 的同一把全局锁：不会和农场/牧场/节令/牧歌挤在同一秒发请求。
//
// 三件事的顺序是有讲究的：
//   1. 领种子（cmd 91）—— 服务端只有「今天还没领」时才允许，领完当日行情才会生成；
//   2. 分享（cmd 98 + ShareService 上报）—— 每日首次触发暴击涨价，会抬高自己铺子的收购价；
//   3. 卖蜜薯（cmd 93）—— 背包里有蜜薯（红薯成熟收获后才有）才动，先比价再卖。
// 前两步是幂等的：服务端状态里已经有「今日已领 / 今日已分享」就直接跳过，不发写请求。
//
// 卖薯是唯一会消耗别人额度的写操作，所以额外做了三件事控制频率与风控面：
//   - 比价（cmd 92 逐个查好友铺子）按配置的间隔节流，间隔内复用上一轮排序结果；
//   - 单轮最多切 3 家铺子，笔间隔 1200ms，剩下的留到下一轮；
//   - 好友铺子额度不足/查不到只换下一家，不算失败，也不会重试同一笔。
// 「好友当天收购超量就换第二高」就是按 totalPrice 降序贪心：一家额度不够就吃满再往下走。
// 10 分钟一轮：比卖薯快得多，但每轮只是读一次活动状态，真正花请求的是「有蜜薯才比价」。
const YISHU_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;

type DailyAction = 'yishu_claim_seed' | 'yishu_share';
type DailySlot = { minute: number; at: number };
// 错相位：节令 19min、神秘商人 37min、牧歌 11min，以薯换福挑 4min。
const YISHU_CHECK_PHASE_MS = 4 * 60 * 1000;
// 首跑 260s：牧歌是 210s，登录后第一波活动读取不叠在同一秒。
const YISHU_INITIAL_DELAY_MS = 260000;
// 相邻两笔写之间隔这么久：连着发会把活动页的读和写挤在同一根连接上。
const YISHU_STEP_SPACER_MS = 1200;
// 单轮最多切换几家铺子：每卖一家就是一次 cmd 93 写，铺子越多越像脚本。
const YISHU_MAX_SHOPS_PER_RUN = 3;
// 这两种错误说明「这家现在卖不进去」，换下一家即可，不当作本轮失败。
const YISHU_SKIP_SHOP_CODES = new Set([
    'YSHF_SHOP_QUOTA_INSUFFICIENT',
    'YSHF_SHOP_UNKNOWN',
    // can_sell = false：这家铺子当前不收蜜薯，换下一家，不算整轮失败。
    'YSHF_SHOP_CLOSED',
]);

const DEFAULT_FRIEND_LIMIT = 60;
const DEFAULT_SCAN_INTERVAL_MINUTES = 30;
const DEFAULT_SELL_MIN_COUNT = 1;
/** 自动任务沿用旧余额的上限：与 activity-center 的 AUTO_BALANCE_STALE_MAX_MS 对齐。 */
const YISHU_BALANCE_STALE_MAX_MS = 60 * 60 * 1000;

/**
 * 出售时间闸门：把 "HH:MM" 解析成当天的分钟数，空串 / 非法值返回 null（不限时段）。
 * 不做精准卡点——过了这个时刻之后，每一轮自动任务（10 分钟）都会按原逻辑卖，
 * 只是把「太早卖」这件事挡掉：那时好友还没分享触发暴击，价格排在后面。
 */
function parseSellAfterMinutes(value: any): number | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const match = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(raw);
    if (!match) return null;
    const hour = Math.max(0, Math.min(23, Number(match[1])));
    const minute = Math.max(0, Math.min(59, Number(match[2])));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
}

/** 服务器时间（北京时间固定 +8）当天的分钟数，与服务端日期用的是同一个偏移。 */
function currentMinutesOfDay(serverTimeSec: number): number {
    const shifted = new Date((Number(serverTimeSec) + 8 * 3600) * 1000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function formatMinutesOfDay(minutes: number): string {
    const safe = Math.max(0, Math.min(24 * 60 - 1, Math.floor(minutes)));
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function isYishuAutomationEnabled(automation: any = {}): boolean {
    return YISHU_AUTOMATION_KEYS.some(key => automation[key] === true);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toInt(value: any, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(String(value), 10);
    const base = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, base));
}

/**
 * 背包里的蜜薯数量。
 *
 * 服务端快照把它放在 `sweetPotato.balance`（与界面读的是同一个字段，item_id=1032 蜜薯）；
 * 早期这里读的是顶层 `sweetPotatoBalance`——那个字段在 DTO 里根本不存在，
 * 于是每轮都判成「没读到背包蜜薯数量」直接跳过卖薯。这就是「有蜜薯却几小时不卖」的真因，
 * 与红薯种子（20307）、红薯果实都无关：卖薯只认蜜薯。
 *
 * 顶层字段保留作兼容，避免别处传入旧形状快照时把自动任务直接打停。
 */
function readSweetPotatoCount(snapshot: any): { count: string | null; known: boolean } {
    const item = snapshot?.sweetPotato;
    if (item && typeof item === 'object') {
        const raw = item.balance;
        const known = item.balanceKnown !== false && raw !== null && raw !== undefined && raw !== '';
        return { count: known ? String(raw) : null, known };
    }
    const legacy = snapshot?.sweetPotatoBalance;
    const legacyKnown = legacy !== null && legacy !== undefined && legacy !== '';
    return { count: legacyKnown ? String(legacy) : null, known: legacyKnown };
}

function createYishuAutomation(deps: {
    getActivity: (options?: any) => Promise<any>;
    claimSeed: (options?: any) => Promise<any>;
    shareShop: (options?: any) => Promise<any>;
    claimCommission: (options?: any) => Promise<any>;
    scanFriends: (options?: any) => Promise<any>;
    sell: (friendGid: any, count: any, options?: any) => Promise<any>;
    getServerTimeSec: () => number;
    log: (module: string, message: string, meta?: any) => void;
}) {
    const { getActivity, claimSeed, shareShop, claimCommission, scanFriends, sell, getServerTimeSec, log } = deps;
    // 跳过原因按服务端日期去重：10 分钟一轮若每轮都记一行「今天已经领过」，日志会被刷满。
    const skipLoggedOn = new Map<string, string>();
    // 比价结果按「好友数上限 + 配置间隔」复用，避免每轮都把好友扫一遍。
    let scanCache: { at: number; limit: number; shops: any[] } | null = null;

    function todayKey(): string {
        return new Date((getServerTimeSec() + 8 * 3600) * 1000).toISOString().slice(0, 10);
    }

    function skip(action: string, text: string): void {
        const key = `${todayKey()}:${action}:${text}`;
        if (skipLoggedOn.get(action) === key) return;
        skipLoggedOn.set(action, key);
        log('活动', `以薯换福自动跳过 ${action}: ${text}`, { module: 'activity', event: '以薯换福自动', result: 'skip', action });
    }

    function done(action: string, text: string): void {
        log('活动', text, { module: 'activity', event: '以薯换福自动', result: 'success', action });
    }

    function failed(action: string, text: string): void {
        log('活动', text, { module: 'activity', event: '以薯换福自动', result: 'error', action });
    }

    /**
     * 好友铺子比价（cmd 92）。返回按成交价（基础价 + 加成）降序的铺子列表，
     * 里面也包含自己的铺子——「好友都收满就卖自己」是同一个贪心循环的尾部。
     */
    async function rankedShops(limit: number, intervalMinutes: number): Promise<any[]> {
        const now = Date.now();
        if (scanCache && scanCache.limit === limit && now - scanCache.at < intervalMinutes * 60 * 1000)
            return scanCache.shops;
        const result = await scanFriends({ limit, force: true });
        const shops = Array.isArray(result?.shops) ? result.shops : [];
        scanCache = { at: now, limit, shops };
        const candidateCount = result?.candidateCount ?? shops.filter(shop => !shop.own).length;
        const scannedCount = result?.scanned ?? shops.length;
        const pendingCount = result?.pendingCount ?? 0;
        const pending = pendingCount > 0 ? `（还有 ${pendingCount} 家待轮换）` : '';
        const topQuotes = shops.slice(0, 5).map((shop) => {
            const name = shop.own ? '自己' : (shop.name || shop.gid);
            return `${name}:${shop.totalPrice}`;
        }).join(' > ');
        log('活动', `以薯换福比价：候选好友 ${candidateCount} 家，本轮扫描 ${scannedCount} 家${pending}，前五报价 ${topQuotes || '无'}`, {
            module: 'activity',
            event: '以薯换福自动',
            result: 'ok',
            action: 'scan',
            candidateCount,
            scannedCount,
            pendingCount,
            limit,
        });
        return shops;
    }

    async function sellSweetPotatoes(snapshot: any, options: {
        friendLimit: number;
        scanIntervalMinutes: number;
        sellMinCount: number;
        fallbackOwn: boolean;
    }): Promise<void> {
        const bag = readSweetPotatoCount(snapshot);
        if (!bag.known) {
            // 带上后端记下的失败原因，否则线上只能看到「没读到」，无从判断是超时还是别的。
            const reason = String(snapshot?.balanceError || '').trim();
            skip('sell', `这次没读到背包蜜薯数量${reason ? `（${reason}）` : ''}，下一轮再试`);
            return;
        }
        let remaining = BigInt(bag.count || '0');
        if (remaining <= 0n) {
            skip('sell', '背包里还没有蜜薯，等红薯成熟收获后自动卖');
            return;
        }
        if (remaining < BigInt(options.sellMinCount)) {
            skip('sell', `背包只有 ${remaining} 个蜜薯，未达到自动卖出阈值 ${options.sellMinCount}`);
            return;
        }
        if (!snapshot?.shop?.priceKnown) {
            skip('sell', '今日收购价还没生成（先领一次红薯种子）');
            return;
        }

        let shops: any[];
        try {
            shops = await rankedShops(options.friendLimit, options.scanIntervalMinutes);
        }
        catch (e: any) {
            failed('scan', `好友铺子比价失败: ${e?.message || e}`);
            return;
        }
        const candidates = options.fallbackOwn ? shops : shops.filter((shop: any) => !shop.own);
        if (!candidates.length) {
            skip('sell', shops.length ? '只把自己的铺子留在候选里，但已关闭卖给自己' : '没有可卖的好友铺子');
            return;
        }

        let switched = 0;
        let wrote = false;
        const spacing = async (): Promise<void> => { if (wrote) await sleep(YISHU_STEP_SPACER_MS); };

        for (const shop of candidates) {
            if (remaining <= 0n || switched >= YISHU_MAX_SHOPS_PER_RUN) break;
            // can_sell 明确为 false 的铺子连请求都不用发，直接换下一家。
            if (shop.canSell === false) {
                skip('sell', `${shop.own ? '自己的铺子' : shop.name || shop.gid} 当前不收蜜薯，换下一家`);
                continue;
            }
            const quota = BigInt(shop.quota || '0');
            if (quota <= 0n) {
                skip('sell', `${shop.own ? '自己的铺子' : shop.name || shop.gid} 今日额度已用完，换下一家`);
                continue;
            }
            const count = quota < remaining ? quota : remaining;
            await spacing();
            try {
                const result = await sell(shop.own ? null : shop.gid, count.toString(), { withSnapshot: false });
                wrote = true;
                switched += 1;
                const sold = BigInt(result?.count || '0');
                remaining -= sold;
                // 服务端只回「该铺每日额度上限」，剩余额度要自己扣，别拿它当剩余值用。
                shop.quota = (quota - sold).toString();
                done('sell', `向${shop.own ? '自己的铺子' : `${shop.name || shop.gid} 的铺子`}卖出 ${sold} 个蜜薯，`
                    + `单价 ${result?.price}，共得 ${result?.income} 福气币`);
            }
            catch (e: any) {
                const code = String(e?.code || '');
                if (YISHU_SKIP_SHOP_CODES.has(code)) {
                    skip('sell', `${shop.own ? '自己的铺子' : shop.name || shop.gid} 现在卖不进去（${e?.message || code}），换下一家`);
                    shop.quota = '0';
                    continue;
                }
                // 回包不可信（数量/金额对不上）这类错误必须停手，绝不能重试猜结果。
                failed('sell', `卖薯失败: ${e?.message || e}`);
                return;
            }
        }

        if (remaining > 0n) {
            skip('sell', `还有 ${remaining} 个蜜薯没卖出去（${candidates.length} 家候选铺子：`
                + `${switched} 家已用过、其余额度不足），留到下一轮`);
        }
    }

    async function runYishuAutomation(automation: any = {}, canRunDailyAction?: (action: DailyAction, beforeWrite?: boolean) => boolean): Promise<void> {
        const claimSeedEnabled = automation.yishu_claim_seed === true;
        const shareEnabled = automation.yishu_share === true;
        const commissionEnabled = automation.yishu_claim_commission === true;
        const sellEnabled = automation.yishu_auto_sell === true;
        if (!claimSeedEnabled && !shareEnabled && !commissionEnabled && !sellEnabled) return;

        // 出售时间闸门：null = 不限时段（改造前的行为）。过了这个点，之后每一轮都卖。
        const sellAfterMinutes = parseSellAfterMinutes(automation.yishu_sell_after_time);
        const sellAfterLabel = sellAfterMinutes === null ? '' : formatMinutesOfDay(sellAfterMinutes);
        const sellGateOpen = sellAfterMinutes === null
            || currentMinutesOfDay(getServerTimeSec()) >= sellAfterMinutes;
        const sellGateSkipText = `还没到开始售卖时间 ${sellAfterLabel}，到点后每轮都会卖`;

        // 只开了卖薯、又还没到点：连活动状态都不用读，直接按天记一行跳过。
        if (sellEnabled && !sellGateOpen && !claimSeedEnabled && !shareEnabled && !commissionEnabled) {
            skip('sell', sellGateSkipText);
            return;
        }

        let snapshot: any;
        try {
            // 一轮只读一次：领种子 / 分享 / 卖薯的写操作自己会重新校验服务端状态。
            // 自动任务必须拿得到蜜薯数量：读背包失败时多试两次，并且允许沿用一小时内的
            // 成功值——轮询间隔（10 分钟）与界面的 stale 窗口一样长，只试一次几乎必然读到未知。
            snapshot = await getActivity({
                freshBalances: true,
                balanceRetries: 2,
                balanceStaleMaxMs: YISHU_BALANCE_STALE_MAX_MS,
            });
        }
        catch (e: any) {
            failed('read', `读取以薯换福状态失败: ${e?.message || e}`);
            return;
        }
        if (!snapshot?.active) {
            skip('read', '不在开放窗口（尚未开始或已经结束）');
            return;
        }

        // 每轮留一条摘要：蜜薯数是不是读到了、余额是不是沿用的旧值、行情有没有生成。
        // 这几项决定了后面会不会跳过卖薯，出问题时不用再靠猜。
        const bag = readSweetPotatoCount(snapshot);
        log('系统', '以薯换福自动本轮开始', {
            module: 'activity',
            event: '以薯换福自动',
            result: 'ok',
            sweetPotato: bag.count ?? 'unknown',
            sweetPotatoKnown: bag.known,
            luckCoin: snapshot.luckCoin?.balance ?? snapshot.luckCoinBalance ?? 'unknown',
            balanceStale: !!snapshot.balanceStale,
            balanceError: snapshot.balanceError || '',
            priceKnown: !!snapshot.shop?.priceKnown,
            price: snapshot.shop?.estimatedPrice || snapshot.shop?.price || '',
            // 出售时间闸门：知道配置值、当前是否放行，才能解释「有蜜薯为什么不卖」。
            sellAfter: sellAfterLabel || '不限',
            sellGateOpen,
        });

        let wrote = false;
        const spacing = async (): Promise<void> => { if (wrote) await sleep(YISHU_STEP_SPACER_MS); };

        if (claimSeedEnabled) {
            if (snapshot.daily?.seedClaimed) {
                skip('claimSeed', '今日红薯种子已经领过');
            }
            else {
                await spacing();
                try {
                    const shouldRun = canRunDailyAction && (() => canRunDailyAction('yishu_claim_seed', true));
                    if (canRunDailyAction?.('yishu_claim_seed') === false) {
                        skip('claimSeed', '自动条件已变化或今日定时任务已执行');
                    } else {
                        const result = await claimSeed(shouldRun ? { withSnapshot: false, shouldRun } : { withSnapshot: false });
                        wrote = true;
                        done('claimSeed', `领取红薯种子 ${result?.count} 个`);
                    }
                }
                catch (e: any) {
                    const code = String(e?.code || '');
                    if (code === 'YSHF_SEED_ALREADY_CLAIMED') skip('claimSeed', '今日红薯种子已经领过');
                    else if (code === 'YSHF_INACTIVE') skip('read', '不在开放窗口（尚未开始或已经结束）');
                    else if (code === 'YSHF_AUTOMATION_CANCELLED') skip('claimSeed', '自动条件已变化或今日定时任务已执行');
                    else failed('claimSeed', `领种子失败: ${e?.message || e}`);
                }
            }
        }

        if (shareEnabled) {
            if (snapshot.daily?.shared) {
                skip('share', '今日已经分享过铺子，暴击涨价每日只触发一次');
            }
            else {
                await spacing();
                try {
                    const shouldRun = canRunDailyAction && (() => canRunDailyAction('yishu_share', true));
                    if (canRunDailyAction?.('yishu_share') === false) {
                        skip('share', '自动条件已变化或今日定时任务已执行');
                    } else {
                        const result = await shareShop(shouldRun ? { withSnapshot: false, shouldRun } : { withSnapshot: false });
                        wrote = true;
                        const extra = result?.count && result.count !== '0' ? `，额外获得 ${result.count} 个红薯种子` : '';
                        const report = result?.shareReported === false
                            ? `（分享上报未生效：${result?.shareReportError || '未知原因'}，暴击加成可能没加上）`
                            : '';
                        done('share', `分享铺子完成${extra}${report}`);
                    }
                }
                catch (e: any) {
                    const code = String(e?.code || '');
                    if (code === 'YSHF_SHARE_ALREADY_DONE') skip('share', '今日已经分享过铺子');
                    else if (code === 'YSHF_INACTIVE') skip('read', '不在开放窗口（尚未开始或已经结束）');
                    else if (code === 'YSHF_AUTOMATION_CANCELLED') skip('share', '自动条件已变化或今日定时任务已执行');
                    else failed('share', `分享铺子失败: ${e?.message || e}`);
                }
            }
        }

        if (sellEnabled && !sellGateOpen) {
            // 到点前不卖，其余（领种子 / 分享 / 收提成）照常，不影响当天的准备动作。
            skip('sell', sellGateSkipText);
        }
        else if (sellEnabled) {
            await sellSweetPotatoes(snapshot, {
                friendLimit: toInt(automation.yishu_scan_friend_limit, DEFAULT_FRIEND_LIMIT, 1, 200),
                scanIntervalMinutes: toInt(automation.yishu_scan_interval_minutes, DEFAULT_SCAN_INTERVAL_MINUTES, 5, 720),
                sellMinCount: toInt(automation.yishu_sell_min_count, DEFAULT_SELL_MIN_COUNT, 1, 10000),
                fallbackOwn: automation.yishu_sell_fallback_own !== false,
            });
        }

        // 提成放在最后：好友把蜜薯卖进你的铺子才会产生，先卖完自己这一轮再看更划算；
        // 而且它是纯收钱动作，卖薯中途失败也不该漏掉。
        if (commissionEnabled) {
            const pending = BigInt(snapshot?.commission?.pending || '0');
            if (!snapshot?.commission?.claimable || pending <= 0n) {
                skip('commission', '当前没有可领取的收购提成');
            }
            else {
                await spacing();
                try {
                    const result = await claimCommission({ withSnapshot: false });
                    wrote = true;
                    const amount = String(result?.amount ?? '0');
                    const balance = result?.balance ? `，当前福气币 ${result.balance}` : '';
                    done('commission', amount === '0' ? '没有可领取的提成' : `领取收购提成 ${amount} 福气币${balance}`);
                }
                catch (e: any) {
                    const code = String(e?.code || '');
                    if (code === 'YSHF_NO_COMMISSION') skip('commission', '当前没有可领取的收购提成');
                    else if (code === 'YSHF_INACTIVE') skip('read', '不在开放窗口（尚未开始或已经结束）');
                    else failed('commission', `领取收购提成失败: ${e?.message || e}`);
                }
            }
        }
    }

    return { runYishuAutomation };
}

let yishuAutomation: any = null;

// ---------- 诊断与自愈 ----------
// 线上出现过「重启后跑一次，之后几小时不动」：定时器被清掉后没人重建，日志里又完全没有痕迹。
// 这里补三样东西：跳过原因节流记录、最近一次执行时间、独立看门狗（定时器丢了就重建并告警）。
const YISHU_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
// 周期 10 分钟，超过 25 分钟没动就认为卡住/丢了。
const YISHU_WATCHDOG_IDLE_MS = 25 * 60 * 1000;
const YISHU_SKIP_LOG_THROTTLE_MS = 30 * 60 * 1000;

let lastTickStartedAt = 0;
let lastTickFinishedAt = 0;
let lastSkipReason = '';
let lastSkipLogAt = 0;
let lastWatchdogWarnAt = 0;
let watchdogHandle: any = null;
let watchdogScheduler: any = null;
let scheduledDaily: DailySlot | null = null;

function yishuLog(message: string, meta: any = {}): void {
    try {
        require('../utils/utils').log(message, { module: 'activity', event: '以薯换福自动', ...meta });
    } catch {
        // 日志失败不影响主流程
    }
}

/** 同一原因 30 分钟只记一条，避免每 10 分钟刷一行。 */
function yishuSkipTick(reason: string): void {
    const now = Date.now();
    if (reason === lastSkipReason && now - lastSkipLogAt < YISHU_SKIP_LOG_THROTTLE_MS) return;
    lastSkipReason = reason;
    lastSkipLogAt = now;
    yishuLog(`以薯换福自动未执行：${reason}`, { result: 'skip', reason });
}

function registerYishuTasks(scheduler: any, isReady: () => boolean, source: string): void {
    scheduler.clear('yishu_initial');
    scheduler.clear('yishu_interval');
    scheduler.setTimeoutTask('yishu_initial', YISHU_INITIAL_DELAY_MS, () => {
        runYishuTick(isReady).catch(() => null);
    });
    scheduler.setIntervalTask('yishu_interval', YISHU_CHECK_INTERVAL_MS, () => {
        runYishuTick(isReady).catch(() => null);
    });
    yishuLog('以薯换福自动任务已挂载', {
        result: 'ok',
        source,
        intervalMinutes: Math.round(YISHU_CHECK_INTERVAL_MS / 60000),
        initialDelaySec: Math.round(YISHU_INITIAL_DELAY_MS / 1000),
    });
}

/**
 * 看门狗：每 5 分钟确认一次「开关开着、账号在线、定时器还在、最近 25 分钟动过」。
 * 任何一条不满足就重建定时器并记一条 warn —— 既自愈，也留下排查依据。
 */
function startYishuWatchdog(scheduler: any, isReady: () => boolean): void {
    watchdogScheduler = scheduler;
    if (watchdogHandle) return;
    watchdogHandle = setInterval(() => {
        try {
            if (!isYishuWindowOpen()) {
                stopYishuTimer(scheduler);
                return;
            }
            if (!isReady()) return;
            const { getAutomation } = require('../models/store');
            if (!hasPeriodicTasks(getAutomation() || {})) return;
            const hasInterval = typeof watchdogScheduler?.has === 'function'
                && watchdogScheduler.has('yishu_interval');
            const idleMs = lastTickStartedAt ? Date.now() - lastTickStartedAt : Number.POSITIVE_INFINITY;
            if (hasInterval && idleMs <= YISHU_WATCHDOG_IDLE_MS) return;
            if (watchdogScheduler) registerYishuTasks(watchdogScheduler, isReady, hasInterval ? 'watchdog-idle' : 'watchdog-missing');
            const now = Date.now();
            if (now - lastWatchdogWarnAt >= 60 * 60 * 1000) {
                lastWatchdogWarnAt = now;
                yishuLog('以薯换福定时器异常，已自动重建', {
                    result: 'error',
                    missing: !hasInterval,
                    idleMinutes: Number.isFinite(idleMs) ? Math.round(idleMs / 60000) : null,
                });
            }
        } catch {
            // 看门狗自身异常不向外抛
        }
    }, YISHU_WATCHDOG_INTERVAL_MS);
    if (typeof watchdogHandle?.unref === 'function') watchdogHandle.unref();
}

function hasDailyTasks(automation: any): boolean {
    return automation.yishu_claim_seed === true || automation.yishu_share === true;
}

function hasPeriodicTasks(automation: any): boolean {
    return automation.yishu_auto_sell === true || automation.yishu_claim_commission === true;
}

function dailyMinute(automation: any): number {
    const [hours, minutes] = normalizeYishuDailyTime(automation.yishu_daily_time).split(':').map(Number);
    return hours * 60 + minutes;
}

function reserveDailyRun(at: number): boolean {
    const accountId = process.env.FARM_ACCOUNT_ID;
    if (!accountId) return false;
    const account = createHash('sha256').update(accountId).digest('hex');
    const date = new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
    try {
        ensureDataDir();
        // 标记先于发请求写入，即使进程在收到回包前退出，当天也不会重发。
        writeFileSync(getDataFile(`yishu-daily-${account}-${date}.json`), '{}', { flag: 'wx', mode: 0o600 });
        return true;
    } catch (error: any) {
        if (error?.code !== 'EEXIST') {
            yishuLog('无法保存以薯换福定时执行记录，本次已跳过', { result: 'error', code: error?.code || '' });
        }
        return false;
    }
}

function scheduleDaily(scheduler: any, isReady: () => boolean, minute: number, now = Date.now()): void {
    const delay = (minute * MINUTE_MS - (now + BEIJING_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS;
    const task = { minute, at: now + delay };
    if (!isYishuWindowOpen(task.at)) {
        scheduler.clear('yishu_daily');
        scheduledDaily = null;
        return;
    }
    scheduledDaily = task;
    scheduler.setTimeoutTask('yishu_daily', Math.max(0, task.at - Date.now()), async () => {
        if (scheduledDaily !== task) return;
        const { getAutomation } = require('../models/store');
        const automation = getAutomation() || {};
        if (!isYishuWindowOpen() || !hasDailyTasks(automation)) {
            scheduledDaily = null;
            return;
        }
        const configuredMinute = dailyMinute(automation);
        const now = Date.now();
        scheduleDaily(scheduler, isReady, configuredMinute, now === task.at ? now + 1 : now);
        if (configuredMinute === task.minute && now >= task.at && now < task.at + MINUTE_MS) {
            await runYishuTick(isReady, task);
        }
    });
}

function isCurrentDailySlot(daily: DailySlot, automation: any): boolean {
    const now = Date.now();
    return now >= daily.at && daily.minute === dailyMinute(automation)
        && Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) === Math.floor((daily.at + BEIJING_OFFSET_MS) / DAY_MS);
}

async function runYishuTick(isReady: () => boolean, daily?: DailySlot): Promise<void> {
    if (!isYishuWindowOpen()) {
        if (watchdogScheduler) stopYishuTimer(watchdogScheduler);
        return;
    }
    if (!isReady()) {
        yishuSkipTick('账号未登录或连接未就绪');
        return;
    }
    const { getAutomation } = require('../models/store');
    const { runExclusiveAutomationTask } = require('./automation-lock');
    const hasTasks = daily ? hasDailyTasks : hasPeriodicTasks;
    if (!hasTasks(getAutomation() || {})) return;
    if (!daily) lastTickStartedAt = Date.now();
    await runExclusiveAutomationTask('yishuhuanfu', async () => {
        if (!isReady() || !isYishuWindowOpen()) {
            yishuSkipTick('排队期间连接断开');
            return;
        }
        const automation = getAutomation() || {};
        if (!hasTasks(automation)) return;
        if (daily && !isCurrentDailySlot(daily, automation)) return;

        if (!yishuAutomation) {
            const activity = require('./activity-center');
            const { getServerTimeSec, log } = require('../utils/utils');
            yishuAutomation = createYishuAutomation({
                getActivity: activity.getCurrentYishuHuanfuActivity,
                claimSeed: activity.claimYishuHuanfuSeeds,
                shareShop: activity.shareYishuHuanfuShop,
                claimCommission: activity.claimYishuHuanfuCommission,
                scanFriends: activity.scanYishuHuanfuFriendShops,
                sell: activity.sellYishuHuanfuSweetPotato,
                getServerTimeSec,
                log,
            });
        }
        if (daily) {
            let reserved = false;
            await yishuAutomation.runYishuAutomation({
                yishu_claim_seed: automation.yishu_claim_seed,
                yishu_share: automation.yishu_share,
            }, (action: DailyAction, beforeWrite = false) => {
                const current = getAutomation() || {};
                if (!isReady() || !isYishuWindowOpen() || !isCurrentDailySlot(daily, current) || current[action] !== true) return false;
                if (!beforeWrite) return true;
                if (!reserved) reserved = reserveDailyRun(daily.at);
                return reserved;
            });
        } else {
            await yishuAutomation.runYishuAutomation({ ...automation, yishu_claim_seed: false, yishu_share: false });
        }
        if (!daily) lastTickFinishedAt = Date.now();
    });
}

/**
 * 定时器挂在调用方（worker）的 scheduler 上，停表时随 clearAll() 一起清掉。
 *
 * 这里有三处曾经踩过的坑，改的时候别退回去：
 *   1. 必须先判断再清。老实现一进来就 clear 两个任务，只要有一次在「还没登录」
 *      或「配置尚未就绪」时被调用，定时器就被永久清掉，要等进程重启才恢复
 *      （线上表现就是：重启后 4 分钟跑一次，之后几小时一动不动）。
 *   2. 幂等注册。配置每变一次 applyRuntimeConfig 都会调过来，若每次都 clear 重建，
 *      带 phase 的首跑（phase 4min + interval 10min）永远等不到。
 *   3. 不叠加 phase。错相位的收益（别和其它活动撞在同一秒）比不上「首跑准时」重要，
 *      第一次已经由 initial 的 260s 承担。
 */
function startYishuTimer(scheduler: any, isReady: () => boolean): void {
    if (!isYishuWindowOpen()) {
        stopYishuTimer(scheduler);
        return;
    }
    if (!isReady()) {
        // 不清旧定时器：这一支可能是「掉线瞬间的配置同步」，清了就再也不会重建。
        yishuSkipTick('账号未登录或连接未就绪，保留已有定时器');
        return;
    }
    const { getAutomation } = require('../models/store');
    const automation = getAutomation() || {};
    if (!isYishuAutomationEnabled(automation)) {
        stopYishuTimer(scheduler);
        return;
    }
    if (hasDailyTasks(automation)) {
        const minute = dailyMinute(automation);
        if (scheduledDaily?.minute !== minute || !scheduler.has('yishu_daily')) {
            scheduleDaily(scheduler, isReady, minute);
        }
    } else if (scheduledDaily) {
        scheduler.clear('yishu_daily');
        scheduledDaily = null;
    }

    if (!hasPeriodicTasks(automation)) {
        if (watchdogHandle || scheduler.has('yishu_interval')) stopPeriodicTasks(scheduler);
        return;
    }
    // 已经在跑就别重建：重复 clear + setTimeout 会把首跑无限推后。
    if (typeof scheduler.has === 'function' && scheduler.has('yishu_interval')) {
        startYishuWatchdog(scheduler, isReady);
        return;
    }

    registerYishuTasks(scheduler, isReady, 'start');
    startYishuWatchdog(scheduler, isReady);
}

function stopPeriodicTasks(scheduler: any): void {
    scheduler.clear('yishu_initial');
    scheduler.clear('yishu_interval');
    if (watchdogHandle) clearInterval(watchdogHandle);
    watchdogHandle = null;
    watchdogScheduler = null;
}

function stopYishuTimer(scheduler: any): void {
    stopPeriodicTasks(scheduler);
    scheduler.clear('yishu_daily');
    scheduledDaily = null;
    yishuAutomation = null;
}

module.exports = {
    createYishuAutomation,
    isYishuAutomationEnabled,
    startYishuTimer,
    stopYishuTimer,
    YISHU_AUTOMATION_KEYS,
    YISHU_CHECK_INTERVAL_MS,
    YISHU_CHECK_PHASE_MS,
    YISHU_INITIAL_DELAY_MS,
    YISHU_STEP_SPACER_MS,
    YISHU_MAX_SHOPS_PER_RUN,
};
