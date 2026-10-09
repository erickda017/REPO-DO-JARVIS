import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const failure = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err).slice(0, 200) }] })
const guarded = (fn) => async (args) => {
  try {
    return text(await fn(args))
  } catch (err) {
    return failure(err)
  }
}

/**
 * The command centre as in-process MCP tools, so "Hey Jarvis, what is down?"
 * works by voice.
 *
 * Deliberately narrow. The model can read status, manage tasks and drive the
 * timer — all local, reversible bookkeeping. It cannot delete tasks, run
 * inference through the router, or change config: those spend money or destroy
 * data, so they exist only on the HTTP API behind an explicit `confirm`.
 */
export function commandServer({ health, services, projects, tasks, timer }) {
  return createSdkMcpServer({
    name: 'jarvis_command',
    version: '1.0.0',
    instructions:
      'Status of the user\'s AI providers, monitored services and projects, plus their task list and countdown timer. ' +
      'Report only what these tools return; if a status is "unknown", say it is unknown.',
    alwaysLoad: true,
    tools: [
      tool(
        'command_status',
        'Current state of AI providers, monitored services and local projects. Provider fields endpoint/auth/model/inference are separate; "unknown" or "skipped" means not verified, never "fine".',
        {},
        guarded(async () => ({ providers: health.snapshot(), services: services.list(), projects: await projects.list() })),
      ),
      tool(
        'command_check_service',
        'Run one fresh availability check against a configured service id.',
        { id: z.string().describe('Service id from command_status') },
        guarded(async ({ id }) => {
          if (!services.has(id)) throw new Error('unknown service')
          return services.checkOne(id)
        }),
      ),
      tool('command_list_tasks', 'List open tasks, highest priority first.', {}, guarded(() => tasks.list())),
      tool(
        'command_create_task',
        'Add a task to the user\'s list.',
        {
          title: z.string().describe('Short task title'),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          notes: z.string().optional(),
        },
        guarded((args) => tasks.create(args)),
      ),
      tool(
        'command_update_task',
        'Change a task\'s state, priority or recorded result.',
        {
          id: z.string(),
          state: z.enum(['todo', 'doing', 'blocked', 'done', 'cancelled']).optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          result: z.string().optional().describe('Outcome to record on the task'),
        },
        guarded(({ id, ...patch }) => tasks.update(id, patch)),
      ),
      tool(
        'command_timer',
        'Control the single countdown timer. "start" needs seconds.',
        {
          action: z.enum(['status', 'start', 'pause', 'resume', 'cancel']),
          seconds: z.number().optional(),
          label: z.string().optional(),
        },
        guarded(({ action, seconds, label }) => (action === 'start' ? timer.start({ seconds, label }) : action === 'status' ? timer.get() : timer[action]())),
      ),
    ],
  })
}
