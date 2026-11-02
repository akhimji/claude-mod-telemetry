// session-telemetry: which line-kit builder draws which tab (the terminal's
// Agents and Overview have builders of their own under term/). Each builder
// is pure: plain data in (TabInput), lines out (TabView).
//
// Exports: buildTab(tab, input, overview)

import type { TelemetryUiTab } from '../../types'

import type { TelemetryOverview } from '../derive'

import { contextTab } from './context'
import { flowTab } from './flow'
import type { TabInput, TabView } from './layout'
import { liveTab } from './live'
import { overviewTab } from './overview'
import { tokensTab } from './tokens'
import { toolsTab } from './tools'

export function buildTab(tab: TelemetryUiTab, input: TabInput, o: TelemetryOverview): TabView {
  switch (tab) {
    case 'tokens':
      return tokensTab(input, o)
    case 'context':
      return contextTab(input)
    case 'tools':
      return toolsTab(input)
    case 'flow':
      return flowTab(input)
    case 'live':
      return liveTab(input)
    default:
      return overviewTab(input, o)
  }
}
