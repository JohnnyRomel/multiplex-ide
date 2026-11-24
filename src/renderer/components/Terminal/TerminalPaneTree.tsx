import React from 'react'
import { Allotment } from 'allotment'
import { Plus, Terminal } from 'lucide-react'
import { type TerminalSplitNode, useAppStore } from '@renderer/stores/useAppStore'
import { TerminalInstance } from './TerminalInstance'

const RecursiveSplit: React.FC<{
  envId: string
  node: TerminalSplitNode
  isVisible: boolean
}> = ({ envId, node, isVisible }) => {
  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        envId={envId}
        paneId={node.paneId}
        terminalId={node.terminalId}
        title={node.title}
        isVisible={isVisible}
      />
    )
  }

  return (
    <Allotment vertical={node.direction === 'vertical'} proportionalLayout>
      {node.children.map((child) => (
        <Allotment.Pane key={child.type === 'leaf' ? child.paneId : child.id} minSize={110}>
          <RecursiveSplit envId={envId} node={child} isVisible={isVisible} />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

export const TerminalWorkspaceArea: React.FC = () => {
  const environments = useAppStore((s) => s.environments)
  const activeEnvId = useAppStore((s) => s.activeEnvId)
  const terminalTrees = useAppStore((s) => s.terminalTrees)
  const ensureTerminalForEnv = useAppStore((s) => s.ensureTerminalForEnv)

  const activeEnv = environments.find((e) => e.id === activeEnvId)
  const activeTree = terminalTrees[activeEnvId]

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: 'var(--st-terminal)' }}>
      {/* Keep every environment's terminal tree mounted so switching workspaces preserves 100% scrollback */}
      {Object.entries(terminalTrees).map(([envId, tree]) => {
        if (!tree) return null
        const visible = envId === activeEnvId
        return (
          <div
            key={envId}
            className={visible ? 'h-full w-full' : 'hidden'}
          >
            <RecursiveSplit envId={envId} node={tree} isVisible={visible} />
          </div>
        )
      })}

      {/* Empty state if user closed all terminals in current env */}
      {!activeTree && activeEnv && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 text-[12px]">
          <Terminal className="h-7 w-7 opacity-40" />
          <div style={{ color: 'var(--st-text-muted)' }}>
            No active terminal in <span className="font-mono font-semibold">{activeEnv.name}</span>
          </div>
          <button
            onClick={() => void ensureTerminalForEnv(activeEnv.id)}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[11.5px] font-medium text-[#111]"
            style={{ backgroundColor: 'var(--st-accent)' }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Terminal
          </button>
        </div>
      )}
    </div>
  )
}
