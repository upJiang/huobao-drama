/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

/**
 * 部分模型会把格式化剧本直接写在回复里，却不调用 save_script。
 * 回复以场景头开头时，按保存工具的同样字段落库，避免改写结果丢失。
 */
async function saveScriptFromAssistantText(episodeId: number, text: string, toolCalls: { toolName?: string | null }[]) {
  const alreadySaved = toolCalls.some((tc) => /savescript/i.test(String(tc.toolName || '').replace(/[_\-\s]/g, '')))
  if (alreadySaved) return null
  const match = text.match(/^##\s*S\d+[\s\S]*$/m)
  const content = match?.[0]?.trim()
  if (!content || content.length < 12) return null
  await db.update(schema.episodes)
    .set({ scriptContent: content, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  return content
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()

  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: 20, requestContext },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    if (agentType === 'script_rewriter') {
      const saved = await saveScriptFromAssistantText(Number(episode_id), result.text || '', normalizedToolCalls)
      if (saved) {
        normalizedToolCalls.push({ toolName: 'saveScript', args: { content: saved } })
        normalizedToolResults.push({ toolName: 'saveScript', result: JSON.stringify({ message: 'Script saved', word_count: saved.length, source: 'assistant_text' }) })
        logTaskProgress('Agent', 'script-saved-from-text', { episodeId: episode_id, wordCount: saved.length })
      }
    }

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
