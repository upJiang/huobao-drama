/**
 * 用环境变量写入 Grok 文本 / 图片 / 视频三条配置。
 * 只在 GROK_API_KEY 与 GROK_BASE_URL（或 GROK_API_BASE）都存在时生效。
 * 启动时按固定名称更新这三条；已有行会刷新地址、密钥和模型并保持启用。
 * 首次插入时优先级设为同类型最高，这样只配 Grok 就能走通制作流程。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

const CONFIG_NAMES = {
  text: 'Grok 文本',
  image: 'Grok 图片',
  video: 'Grok 视频',
} as const

const DEFAULTS = {
  text: 'grok-4.20-non-reasoning',
  image: 'grok-imagine-image',
  video: 'grok-imagine-video-1.5',
} as const

const MODEL_EXTRAS: Record<keyof typeof CONFIG_NAMES, string[]> = {
  text: ['grok-4.7', 'grok-3-mini'],
  image: ['grok-imagine-image-2.0', 'grok-imagine-image-quality'],
  video: ['grok-imagine-video'],
}

export interface GrokEnvConfig {
  apiKey: string
  baseUrl: string
  models: Record<keyof typeof CONFIG_NAMES, string>
}

export function readGrokEnv(): GrokEnvConfig | null {
  const apiKey = (process.env.GROK_API_KEY || '').trim()
  const baseUrl = (process.env.GROK_BASE_URL || process.env.GROK_API_BASE || '').trim().replace(/\/+$/, '')
  if (!apiKey || !baseUrl) return null
  return {
    apiKey,
    baseUrl,
    models: {
      text: (process.env.GROK_TEXT_MODEL || '').trim() || DEFAULTS.text,
      image: (process.env.GROK_IMAGE_MODEL || '').trim() || DEFAULTS.image,
      video: (process.env.GROK_VIDEO_MODEL || '').trim() || DEFAULTS.video,
    },
  }
}

function modelList(kind: keyof typeof CONFIG_NAMES, primary: string): string[] {
  const extras = MODEL_EXTRAS[kind].filter((name) => name !== primary)
  return [primary, ...extras]
}

export async function bootstrapGrokConfigs(): Promise<void> {
  const env = readGrokEnv()
  if (!env) return

  const kinds = Object.keys(CONFIG_NAMES) as (keyof typeof CONFIG_NAMES)[]
  for (const kind of kinds) {
    const name = CONFIG_NAMES[kind]
    const rows = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.serviceType, kind))
    const existing = rows.find((row) => row.name === name && (row.provider || '').toLowerCase() === 'grok')
    const ts = now()
    const model = JSON.stringify(modelList(kind, env.models[kind]))

    if (existing) {
      await db.update(schema.aiServiceConfigs).set({
        provider: 'grok',
        baseUrl: env.baseUrl,
        apiKey: env.apiKey,
        model,
        isActive: true,
        updatedAt: ts,
      }).where(eq(schema.aiServiceConfigs.id, existing.id))
      continue
    }

    const maxPriority = rows.reduce((max, row) => Math.max(max, row.priority || 0), 0)
    await db.insert(schema.aiServiceConfigs).values({
      serviceType: kind,
      provider: 'grok',
      name,
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model,
      priority: maxPriority + 1,
      isActive: true,
      createdAt: ts,
      updatedAt: ts,
    })
  }

  console.log(`🤖 已从环境变量同步 Grok 文本/图片/视频配置（${env.baseUrl}）`)
}
