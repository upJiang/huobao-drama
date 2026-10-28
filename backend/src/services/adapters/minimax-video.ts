/**
 * MiniMax H3 视频生成 Adapter
 * 端点: POST /v2/video_generation -> { task_id }
 * 轮询: GET  /v2/query/video_generation/{task_id} -> { task: { status, content.url, error } }
 *
 * 仅支持 MiniMax-H3 系列模型。content[] 多模态结构:
 * - text           提示词（必填，≤7000 字符）
 * - image_url      role: first_frame / last_frame / reference_image（参考图 ≤9）
 * - video_url      role: reference_video（≤3）
 * - audio_url      参考音频（≤3），混合总数 ≤12
 *
 * 注意:
 * - 文生视频 ratio 必填且不能为 adaptive；有首帧图（图生视频）时恒为 adaptive，省略 ratio
 * - H3 原生音画同步生成，官方文档无独立 generate_audio 开关，该字段忽略
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

/** 仅支持 MiniMax-H3 系列（前缀匹配，兼容未来 H3.x 变体） */
const H3_MODEL_PREFIX = 'minimax-h3'
const DEFAULT_MODEL = 'MiniMax-H3'

/** 多模态参考素材上限：图片 9、视频 3、音频 3，混合总数 12 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 } as const

const PROMPT_MAX_CHARS = 7000

/**
 * H3 会把英文祈使句当台词念出来，所以硬约束用中文短句。
 * non_diegetic_music 是官方配乐字段，单独成行，不写进对白。
 * 称呼锁只写「牛牛 / 牛妹」，不写 Niuniu / Niumei。
 */
export const HARD_BLOCK_MARK = '【制作约束，不要念出】'
export const HARD_NO_BGM = '无背景音乐，只保留环境声与对白。'
export const HARD_NO_BGM_FIELD = 'non_diegetic_music: N/A'
export const HARD_NO_BURNED_SUBTITLES = '画面不出现字幕、台词条、标题、水印或任何烧录文字。'
export const HARD_NARRATION = '旁白只作为画外音：旁白角色不出镜，旁白文字不上画面。'
export const HARD_ADDRESS_NIUNIU = '牛妹称呼对方时嘴里只说牛牛，禁止把对方叫成牛妹。'
export const HARD_CLEANUP_CALM = '收拾时保持平静，不要表演惊讶、愣住或包落地。'

const NARRATION_LINE = '画外音（不出镜、不上字幕）'
/** 牛妹念错对方时的近音。只替换她自己的台词，不改她的角色名。 */
const WRONG_ADDRESS_SOURCE = '牛美|妞妹|牛梅|妞美|妞梅|牛媚|牛妹'
const SELF_NAME_SOURCE = '我的名字是牛妹|我就是牛妹|我名叫牛妹|人家是牛妹|叫我牛妹|喊我牛妹|我是牛妹|我叫牛妹'

/** MiniMax 支持的宽高比 */
const VALID_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

function stripHardBlock(text: string): string {
  const idx = text.indexOf(HARD_BLOCK_MARK)
  if (idx === -1) return text
  return text.slice(0, idx).trimEnd()
}

function mapOutsideQuotes(text: string, fn: (outside: string) => string): string {
  const re = /「[^」]*」|“[^”]*”|"[^"\n]*"/g
  let out = ''
  let last = 0
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0
    out += fn(text.slice(last, index))
    out += match[0]
    last = index + match[0].length
  }
  out += fn(text.slice(last))
  return out
}

function rewriteAddressInSpeech(speech: string): string {
  const normalized = speech.replace(
    /(我的名字是|我就是|我名叫|人家是|叫我|喊我|我是|我叫)\s*niu[\s_-]*mei/gi,
    '$1牛妹',
  )
  const holds: string[] = []
  const protectedSpeech = normalized.replace(new RegExp(SELF_NAME_SOURCE, 'g'), (token) => {
    holds.push(token)
    return `\u0001${holds.length - 1}\u0001`
  })
  const replaced = protectedSpeech
    .replace(/niu[\s_-]*niu/gi, '牛牛')
    .replace(/niu[\s_-]*mei/gi, '牛牛')
    .replace(new RegExp(WRONG_ADDRESS_SOURCE, 'g'), '牛牛')
  const restored = replaced.replace(/\u0001(\d+)\u0001/g, (_, index) => holds[Number(index)] ?? '')
  const stripped = restored
    .replace(/\b(?:please\s+)?(?:do not|don't|never)\s+(?:say|call|address)\b[^。！？!?\n]*/gi, '')
    .replace(/\b(?:must|should)\s+address\b[^。！？!?\n]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!stripped && /牛牛|牛妹/.test(restored)) return '牛牛'
  return stripped || restored
}

/** 只改牛妹自己的引语，牛牛叫她「牛妹」保持不变。 */
function rewriteHerQuotedSpeech(text: string): string {
  const intro = /(?<![A-Za-z0-9\u4e00-\u9fff@])(?:@图片\d+)?@?牛妹[:：]?\s*(?:[（(][^）)\n]{0,30}[）)])?\s*(?:(?:叫道|说道|开口|回答|说|喊|问|道)了?)?\s*(?:[（(][^）)\n]{0,30}[）)])?\s*[:：]?\s*$/
  let out = ''
  let cursor = 0
  const openRe = /[「“"]/g
  for (const match of text.matchAll(openRe)) {
    const start = match.index ?? 0
    const open = match[0]
    const close = open === '「' ? '」' : open === '“' ? '”' : '"'
    const end = text.indexOf(close, start + 1)
    if (end === -1) break
    const window = text.slice(Math.max(cursor, start - 48), start)
    out += text.slice(cursor, start)
    if (intro.test(window)) {
      out += `${open}${rewriteAddressInSpeech(text.slice(start + 1, end))}${close}`
    } else {
      out += text.slice(start, end + 1)
    }
    cursor = end + 1
  }
  out += text.slice(cursor)
  return out
}

/** 剧本行「牛妹：（情绪）台词」没有引号时，只改句号前的那句台词。 */
function rewriteHerScriptSpeech(text: string): string {
  return mapOutsideQuotes(text, (part) => part.replace(
    /((?<![A-Za-z0-9\u4e00-\u9fff@])(?:@图片\d+)?@?牛妹[:：]\s*[（(][^）)\n]{0,30}[）)]\s*)([^。！？!?\n]{0,40}[。！？!?]?)/g,
    (_full, prefix: string, speech: string) => `${prefix}${rewriteAddressInSpeech(speech)}`,
  ))
}

function sanitizeNarration(text: string): string {
  const quoted = text
    .replace(/旁白(?:说|道|朗读)?\s*[:：]\s*「([^」]*)」/g, `${NARRATION_LINE}：$1`)
    .replace(/旁白(?:说|道|朗读)?\s*[:：]\s*“([^”]*)”/g, `${NARRATION_LINE}：$1`)
    .replace(/旁白(?:说|道|朗读)?\s*[:：]\s*"([^"\n]*)"/g, `${NARRATION_LINE}：$1`)
  const unquoted = mapOutsideQuotes(quoted, (part) => part.replace(
    /旁白(?:说|道|朗读)?\s*[:：]\s*([^\n]+)/g,
    `${NARRATION_LINE}：$1`,
  ))
  return mapOutsideQuotes(unquoted, (part) => part
    .replace(/(?:画面[^。\n]{0,12})?(?:烧录|叠加|打上|出现)?字幕[:：][^。\n]*/g, '')
    .replace(/\b(?:burned[-\s]?in\s+)?subtitles?\b[^.\n]*/gi, '')
    .replace(/\bon-screen\s+text\b[^.\n]*/gi, ''))
}

function neutralizeBgm(text: string): string {
  return mapOutsideQuotes(text, (part) => part
    .replace(/(?:背景音乐|配乐|BGM)\s*[:：][^\n]*/gi, '环境声')
    .replace(/(?<!无)(?:轻快|舒缓|紧张|欢快|悲伤)?的?背景音乐/g, '环境声')
    .replace(/\bBGM\b/g, '环境声'))
}

function stripEnglishInstructionLines(text: string): string {
  return mapOutsideQuotes(text, (part) => part
    .replace(/^[^\n]*\b(?:do not call|don't call|never say|never call|must address|address (?:him|her|them) as)\b[^\n]*\n?/gim, '')
    .replace(/^[^\n]*\bHARD(?:[\s_]+)(?:LOCK|NO|ADDRESS|NAME)\b[^\n]*\n?/gim, ''))
}

function foldRomanizedNames(text: string): string {
  return text.replace(/https?:\/\/\S+|niu[\s_-]*niu|niu[\s_-]*mei/gi, (token) => {
    if (/^https?:/i.test(token)) return token
    return /niu[\s_-]*niu/i.test(token) ? '牛牛' : '牛妹'
  })
}

function calmCleanupActing(text: string): string {
  return mapOutsideQuotes(text, (part) => part
    .replace(/惊讶/g, '平静')
    .replace(/愣住/g, '照常动作')
    .replace(/包包落地|包掉在地上|包掉地上|包落地/g, '把包拿稳'))
}

function needsAddressLock(text: string): boolean {
  return /牛妹|niu[\s_-]*mei/i.test(text)
}

/**
 * 送进 MiniMax 之前整理表演和对白：
 * - 牛妹称呼对方时改成牛牛，禁止把对方叫成牛妹（其他剧没有牛妹则不加这句）
 * - 旁白改成不出镜、不上字幕的画外音
 * - 去掉配乐要求和烧录字幕指令
 * - 收拾场面里的惊讶 / 愣住 / 包落地改成平静动作
 * 硬约束附在末尾，且称呼锁不含英文，避免被念出来。
 */
export function sanitizeActingAndDialogue(prompt: string): string {
  const trimmed = stripHardBlock(prompt.trim())
  if (!trimmed) return ''

  let body = sanitizeNarration(trimmed)
  body = stripEnglishInstructionLines(body)
  // 先把引号外的 Niumei/Niuniu 折成中文角色名，引号里的错称留给台词改写。
  body = mapOutsideQuotes(body, foldRomanizedNames)
  body = rewriteHerQuotedSpeech(body)
  body = rewriteHerScriptSpeech(body)
  body = foldRomanizedNames(body)
  body = neutralizeBgm(body)
  const cleanup = /收拾|收场/.test(body)
  if (cleanup) body = calmCleanupActing(body)
  body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  const lines = [
    HARD_BLOCK_MARK,
    HARD_NO_BGM,
    HARD_NO_BGM_FIELD,
    HARD_NO_BURNED_SUBTITLES,
    HARD_NARRATION,
  ]
  if (needsAddressLock(body)) lines.push(HARD_ADDRESS_NIUNIU)
  if (cleanup) lines.push(HARD_CLEANUP_CALM)
  return `${body}\n${lines.join('\n')}`
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class MiniMaxVideoAdapter implements VideoProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    if (!model.toLowerCase().startsWith(H3_MODEL_PREFIX)) {
      throw new Error(`仅支持 MiniMax H3 系列模型（MiniMax-H3*），当前: ${model}`)
    }

    const rawPrompt = (record.prompt || '').trim()
    if (!rawPrompt) throw new Error('MiniMax H3 要求必须提供提示词（text content）')
    const prompt = sanitizeActingAndDialogue(rawPrompt)
    if (!prompt) throw new Error('MiniMax H3 要求必须提供提示词（text content）')
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()

    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new Error(`提示词超长：MiniMax H3 上限 ${PROMPT_MAX_CHARS} 字符，当前 ${prompt.length}`)
    }

    const totalRefs = refImages.length + refVideos.length + refAudios.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0)
    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios || totalRefs > REF_LIMITS.total) {
      throw new Error(`参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}、总数≤${REF_LIMITS.total}`)
    }

    const content: any[] = [{ type: 'text', text: prompt }]
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url } })
    }

    const body: any = {
      model,
      content,
      duration: this.normalizeDuration(record.duration),
      resolution: this.normalizeResolution(record.resolution),
    }

    // 图生视频（有首帧）ratio 恒为 adaptive，省略；文生视频 ratio 必填
    if (!firstFrame) {
      const ratio = (record.aspectRatio || '').trim()
      body.ratio = VALID_RATIOS.has(ratio) ? ratio : '16:9'
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v2', '/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.task_id) {
      return { isAsync: true, taskId: String(result.task_id) }
    }
    const videoUrl = result.task?.content?.url || result.content?.url || result.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v2', `/query/video_generation/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    // 官方响应为 { task: { status, content: { url }, error } }，兼容顶层平铺
    const task = result.task && typeof result.task === 'object' ? result.task : result
    const status = task.status

    if (status === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: task.content?.url || task.video_url,
      }
    }
    if (status === 'failed' || status === 'cancelled') {
      const err = task.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const task = result.task && typeof result.task === 'object' ? result.task : result
    return task.content?.url || task.video_url || null
  }

  private normalizeDuration(duration?: number | null): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    // MiniMax H3 支持 4-15 秒
    return Math.min(15, Math.max(4, parsed))
  }

  /** MiniMax 仅 768P / 2K 两档；项目侧 480p/720p 统一归到 768P，1080p/2K 归到 2K */
  private normalizeResolution(resolution?: string | null): string {
    const r = (resolution || '').toLowerCase()
    if (r === '2k' || r === '1080p') return '2K'
    return '768P'
  }
}
