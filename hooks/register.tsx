// session-telemetry: the hooks module. Observes the session and hands each event
// to collect.ts; every hook passes the event on unchanged (`next(e)`, its result
// returned as it came), and the telemetry work around it runs inside `guard`, so
// a failure there is logged to the debug log and never reaches the session.
//
// `$` goes nowhere but `ioOf($)` (state.ts) and `startUi($)` (ui/pane.tsx), both named imports: the engine's scan
// follows `$` into named imports of the module's own files, not into `import *`).
//
// Hooked: session.start, session.end, turn.start, turn.step (streaming),
// turn.complete, tool.call (two registrations, see below), agent.spawn,
// session.compact, session.measure, classic.PostToolUse,
// classic.PostToolUseFailure, classic.PostModelSwitch; and in ui/pane.tsx
// (registerUi) command.run, ui.scroll, ui.render (Pane, AbovePrompt),
// session.attach, session.detach, ui.close and prompt.submit.
//
// `register(on, options)`: `options` are the manifest's userConfig values (the
// alert rules: collect.configure). The alert engine runs inside collect's
// handlers (after a step, a turn end, a measure, session start) and on its own
// timer; it toasts and sets the status line through ioOf($).
//
// Exports: register.

import type { Register } from 'claude-code'

import * as collect from './collect'
import { ioOf } from './state'
import { registerUi, startUi } from './ui/pane'

export const register: Register = (on, options) => {
  // the alert rules from the manifest's userConfig (a change in /config reloads the module with new options)
  try {
    collect.configure(options)
  } catch {
    // the defaults stay
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'session.start', () => collect.onSessionStart(io, e))
    await startUi($, e.surface)
    return result
  })

  on('session.end', async ($, e, next) => {
    const io = ioOf($)
    await collect.guard(io, 'session.end', () => collect.onSessionEnd(io, e))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const io = ioOf($)
    await collect.guard(io, 'turn.start', () => collect.onTurnStart(io, e))
    return next(e)
  })

  // One model request: the response streams through untouched (`yield*`), and the
  // step is recorded from its result once it is whole.
  on('turn.step', async function* ($, e, next) {
    const io = ioOf($)
    let startedAt: number | null = null
    try {
      startedAt = await $.clock.now()
    } catch {
      startedAt = null
    }
    const result = yield* next(e)
    await collect.guard(io, 'turn.step', () => collect.onStep(io, e, result, startedAt))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'turn.complete', () => collect.onTurnComplete(io, e))
    return result
  })

  // Tool calls. The Agent tool has a registration of its own, so the hook whose
  // `next` a foreground subagent runs inside is never the one that must hear that
  // subagent's own tool calls (a hook does not hear what its own frame raised).
  on('tool.call', { tool: /^(?!Agent$)/ }, async ($, e, next) => {
    const io = ioOf($)
    await collect.guard(io, 'tool.call start', () => collect.onToolStart(io, e))
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await collect.guard(io, 'tool.call end', () => collect.onToolEnd(io, e, undefined))
      throw err
    }
    await collect.guard(io, 'tool.call end', () => collect.onToolEnd(io, e, ran))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const io = ioOf($)
    await collect.guard(io, 'Agent call start', () => collect.onToolStart(io, e))
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await collect.guard(io, 'Agent call end', () => collect.onAgentToolEnd(io, e, undefined))
      throw err
    }
    await collect.guard(io, 'Agent call end', () => collect.onAgentToolEnd(io, e, ran))
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'agent.spawn', () => collect.onAgentSpawn(io, e, result))
    return result
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'session.compact', () => collect.onCompact(io, e, result))
    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'session.measure', () => collect.onMeasure(io, e))
    return result
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'PostToolUse', () => collect.onToolExec(io, e))
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'PostToolUseFailure', () => collect.onToolExec(io, e))
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    const io = ioOf($)
    await collect.guard(io, 'PostModelSwitch', () => collect.onModelSwitch(io, e))
    return result
  }).catch(($, e, next) => next(e))

  // ── UI ────────────────────────────────────────────────────────────────────
  // The pane, its `/telemetry` command, its `ui.render` and `ui.scroll` hooks:
  // hooks/ui/pane.tsx (see NOTES.md, "UI").
  // ──────────────────────────────────────────────────────────────────────────
  registerUi(on)
}
