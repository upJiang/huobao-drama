/**
 * 把项目里的尺寸/宽高比收敛到 Grok Imagine 接受的比例。
 * 入参可以是 "16:9"、"1920x1080" 或 Seedance 的 "adaptive"。
 */
export function snapAspectRatio(
  raw: string | null | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  const value = (raw || '').trim().toLowerCase()
  if (!value || value === 'adaptive' || value === 'auto') return fallback
  if (allowed.includes(value)) return value

  const colon = value.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  const wxh = value.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/)
  const w = colon ? Number(colon[1]) : wxh ? Number(wxh[1]) : 0
  const h = colon ? Number(colon[2]) : wxh ? Number(wxh[2]) : 0
  if (!w || !h) return fallback

  const target = Math.log(w / h)
  let best = fallback
  let bestDiff = Infinity
  for (const ratio of allowed) {
    const [rw, rh] = ratio.split(':').map(Number)
    if (!rw || !rh) continue
    const diff = Math.abs(target - Math.log(rw / rh))
    if (diff < bestDiff) {
      bestDiff = diff
      best = ratio
    }
  }
  return best
}
