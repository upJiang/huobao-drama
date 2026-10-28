/**
 * Grsai / MiniMax H3 请求整形。
 *
 * H3 只接受 portrait|landscape、480p|768p|1080p，以及「时长｜风格｜0-3秒…」这种时间轴提示词。
 * 参考图没有单独的首尾帧角色，全部放进 images（最多 9 张）。
 * 上一镜末帧放在数组最前，用来接戏；其后是调用方排好的参考图（角色优先）。
 */
import { snapAspectRatio } from './grok-aspect'

const IMAGE_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '5:4', '4:5', '21:9', '9:21', '2:1', '1:2',
] as const

const PORTRAIT_RATIOS = new Set([
  '9:16', '3:4', '2:3', '4:5', '9:19.5', '9:20', '9:21', '1:2', '1:3', 'portrait',
])

const CONTINUITY = '连贯约束：画面中已经出现的角色必须留在镜头里，除非这一段明确写他们离开或被切出；禁止旁人无故消失，禁止无故换人，禁止突然多出出场名单以外的人。人物的脸、发型、服装和体态锁定参考图，前后不要变样。'
const CONTINUITY_FRAME = '开场必须接上上一镜末帧（参考图第1张）：机位、人物位置和场景连续，不要跳到无关空间，也不要让末帧里的人消失。'
const OPENING_HOOK = '若这是一条新的开场而不是接上一镜，前 3 秒要有一个可见钩子（动作、表情或关键物件），不要用空镜慢摇把开头耗掉。'
const VISUAL = '视觉要求：动作有起势和跟随，肢体自然不僵硬，镜头运动稳定，段与段可以换景别但场景连续，口型与台词同步。'
const NEGATIVE = '负面提示词：人物变形、多余手指、多余肢体、脸部崩坏、口型不同步、人物无故消失、旁人突然消失、多余人物突然出现、人物外观变化、场景跳变、画面闪烁、动作僵硬、低清晰度、卡顿、文字、水印、Logo。'

export interface ShotFrameRef {
  id: number
  number: number
  lastFrame?: string | null
  deleted?: boolean
}

export function pickPreviousLastFrame(shots: ShotFrameRef[], currentId: number): string | null {
  const current = shots.find((shot) => shot.id === currentId)
  if (!current) return null
  const prev = shots
    .filter((shot) => shot.id !== currentId && !shot.deleted && shot.number < current.number && String(shot.lastFrame || '').trim())
    .sort((a, b) => b.number - a.number)[0]
  return prev ? String(prev.lastFrame).trim() : null
}

export function grsaiVideoResolution(resolution?: string | null): '480p' | '768p' | '1080p' {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p') return '480p'
  if (value === '1080p' || value === '2k') return '1080p'
  return '768p'
}

/** H3：1-15 秒；1080p 最多 10 秒。缺省用短剧建议的 10 秒。 */
export function grsaiVideoDuration(duration: number | null | undefined, resolution: '480p' | '768p' | '1080p'): number {
  const parsed = Math.round(Number(duration))
  let value = Number.isFinite(parsed) && parsed > 0 ? parsed : 10
  value = Math.min(15, Math.max(1, value))
  if (resolution === '1080p') value = Math.min(10, value)
  return value
}

export function grsaiVideoAspect(aspect?: string | null): 'portrait' | 'landscape' {
  const value = String(aspect || '').trim().toLowerCase()
  if (PORTRAIT_RATIOS.has(value)) return 'portrait'
  const pair = value.match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/)
  if (pair && Number(pair[2]) > Number(pair[1])) return 'portrait'
  return 'landscape'
}

export function grsaiImageAspect(size?: string | null): string {
  return snapAspectRatio(size, IMAGE_RATIOS, '16:9')
}

export function collectGrsaiImages(input: {
  firstFrame?: string | null
  lastFrame?: string | null
  references?: string[] | null
}, limit = 9): string[] {
  const out: string[] = []
  const push = (url?: string | null) => {
    const value = String(url || '').trim()
    if (!value || out.includes(value) || out.length >= limit) return
    out.push(value)
  }
  push(input.firstFrame)
  for (const url of input.references || []) push(url)
  push(input.lastFrame)
  return out
}

export function collectGrsaiAudios(urls?: string[] | null): string[] {
  const out: string[] = []
  for (const url of urls || []) {
    const value = String(url || '').trim()
    if (!value || out.includes(value)) continue
    out.push(value)
    if (out.length >= 3) break
  }
  return out
}

function stripRefMarks(text: string): string {
  return text.replace(/@图片\d*/g, '').replace(/@/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}

function parseTimedLine(line: string): { start: number; end: number; text: string } | null {
  const matched = line.match(/^(\d+)\s*[-~～到至]\s*(\d+)\s*秒\s*[：:.]?\s*(.*)$/)
  if (!matched) return null
  const start = Number(matched[1])
  const end = Number(matched[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end, text: matched[3].trim() }
}

function fitTimed(
  segments: { start: number; end: number; text: string }[],
  duration: number,
): { start: number; end: number; text: string }[] {
  const origin = segments[0].start
  const span = Math.max(1, segments[segments.length - 1].end - origin)
  const scaled = segments.map((segment) => {
    const start = Math.round(((segment.start - origin) / span) * duration)
    const end = Math.max(start + 1, Math.round(((segment.end - origin) / span) * duration))
    return { start, end, text: segment.text }
  })
  scaled[0].start = 0
  for (let i = 1; i < scaled.length; i++) {
    scaled[i].start = scaled[i - 1].end
    if (scaled[i].end <= scaled[i].start) scaled[i].end = Math.min(duration, scaled[i].start + 1)
  }
  scaled[scaled.length - 1].end = duration
  return scaled
}

function linesToSegments(lines: string[], duration: number): { start: number; end: number; text: string }[] {
  const usable = lines.length ? lines : ['人物按参考图入画，动作连续。']
  return usable.map((text, index) => {
    const start = Math.round((duration * index) / usable.length)
    const end = index === usable.length - 1 ? duration : Math.max(start + 1, Math.round((duration * (index + 1)) / usable.length))
    return { start, end, text }
  })
}

function formatSegments(segments: { start: number; end: number; text: string }[]): string {
  return segments.map((segment) => `${segment.start}-${segment.end}秒：${segment.text}`).join('\n')
}

/**
 * 把已有分镜提示词收成 H3 示例那种时间轴，并补上角色不无故消失的连贯约束。
 * 已经包过一层的提示词只更新时长头，避免重复叠约束。
 */
export function buildMinimaxTimelinePrompt(opts: {
  prompt?: string | null
  duration: number
  portrait: boolean
  hasContinuityFrame?: boolean
}): string {
  const orientation = opts.portrait ? '竖屏' : '横屏'
  const header = `视频时长：${opts.duration}秒｜电影级短剧｜${orientation}连续镜头`
  const raw = stripRefMarks(opts.prompt || '')
  if (raw.includes('连贯约束') && /视频时长：\d+秒/.test(raw)) {
    let next = raw.replace(/视频时长：\d+秒｜[^\n]*/, header)
    if (opts.hasContinuityFrame && !next.includes('上一镜末帧')) next = `${next}\n\n${CONTINUITY_FRAME}`
    if (!opts.hasContinuityFrame && !next.includes('可见钩子')) next = `${next}\n\n${OPENING_HOOK}`
    return next
  }

  const lines = (raw || '人物按参考图入画，动作连续。')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('视频时长：') && !line.startsWith('负面提示词') && !line.startsWith('视觉要求') && !line.startsWith('连贯约束') && !line.startsWith('开场必须接上'))
  const cast = lines.filter((line) => /^出场/.test(line))
  const body = lines.filter((line) => !/^出场/.test(line))
  const timed = body.map(parseTimedLine).filter((line): line is { start: number; end: number; text: string } => !!line)
  const notes = timed.length ? body.filter((line) => !parseTimedLine(line)) : []
  const segments = timed.length ? fitTimed(timed, opts.duration) : linesToSegments(body, opts.duration)

  const parts = [header]
  if (notes.length) parts.push(`风格：${notes.join(' ')}`)
  if (cast.length) parts.push(cast.join('\n'))
  parts.push(formatSegments(segments))
  parts.push(CONTINUITY)
  parts.push(opts.hasContinuityFrame ? CONTINUITY_FRAME : OPENING_HOOK)
  parts.push(VISUAL)
  parts.push(NEGATIVE)
  return parts.join('\n\n')
}
