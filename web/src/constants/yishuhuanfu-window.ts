export const YISHU_START_MS = 1795564800000
export const YISHU_END_MS = 1796860800000

export function isYishuWindowOpen(now: number) {
  return now >= YISHU_START_MS && now < YISHU_END_MS
}
