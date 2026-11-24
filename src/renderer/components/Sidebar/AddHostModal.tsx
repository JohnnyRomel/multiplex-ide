import React, { useEffect, useState } from 'react'
import { Settings, X } from 'lucide-react'
import type { SshConfigHostSummary } from '@shared/types'
import { useAppStore } from '@renderer/stores/useAppStore'

const COLORS = ['#a6e22e', '#66d9ef', '#fd971f', '#f92672', '#ae81ff', '#e6db74']

export const AddHostModal: React.FC = () => {
  const show = useAppStore((s) => s.showAddHostModal)
  const setShow = useAppStore((s) => s.setShowAddHostModal)
  const setEnvironments = useAppStore((s) => s.setEnvironments)
  const setActiveEnv = useAppStore((s) => s.setActiveEnv)
  const openConfigFile = useAppStore((s) => s.openConfigFile)
  const addToast = useAppStore((s) => s.addToast)

  const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigHostSummary[]>([])
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('22')
  const [proxyJump, setProxyJump] = useState('')
  const [defaultPath, setDefaultPath] = useState('~/workspace')
  const [useTmux, setUseTmux] = useState(false)
  const [color, setColor] = useState(COLORS[0])

  useEffect(() => {
    if (!show) return
    void window.multiplex.listSshConfigHosts().then(setSshConfigHosts).catch(() => {})
  }, [show])

  if (!show) return null

  const applyPreset = (alias: string) => {
    const found = sshConfigHosts.find((h) => h.alias === alias)
    if (!found) return
    setName(found.alias)
    setHost(found.alias)
    setUser(found.user || '')
    setPort(String(found.port || 22))
    setProxyJump(found.proxyJump || '')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!host.trim()) return

    const created = await window.multiplex.addCustomHost({
      name: name.trim() || host.trim(),
      host: host.trim(),
      user: user.trim() || undefined,
      port: parseInt(port, 10) || 22,
      proxyJump: proxyJump.trim() || undefined,
      defaultPath: defaultPath.trim() || '~',
      useTmux,
      color
    })

    const list = await window.multiplex.listEnvironments()
    setEnvironments(list)
    setActiveEnv(created.id)
    addToast('success', `Saved ${created.name} to config.json`)
    setName('')
    setHost('')
    setShow(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      onClick={() => setShow(false)}
    >
      <div
        className="w-[430px] rounded border shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--st-panel)', borderColor: 'var(--st-border-light)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b"
          style={{ backgroundColor: 'var(--st-titlebar)', borderColor: 'var(--st-border)' }}
        >
          <span className="text-[12px] font-semibold">Add Workspace to Config</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setShow(false)
                void openConfigFile()
              }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] hover:bg-white/10"
              style={{ color: 'var(--st-accent-blue)' }}
            >
              <Settings className="h-3 w-3" /> Edit config.json
            </button>
            <button onClick={() => setShow(false)} className="rounded p-1 hover:bg-white/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3 text-[12px]">
          {sshConfigHosts.length > 0 && (
            <div>
              <label className="block mb-1 text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                Pick from ~/.ssh/config (optional)
              </label>
              <select
                defaultValue=""
                onChange={(e) => applyPreset(e.target.value)}
                className="w-full rounded border px-2 py-1.5 font-mono text-[11.5px] outline-none"
                style={{
                  backgroundColor: 'var(--st-input)',
                  borderColor: 'var(--st-border-light)',
                  color: 'var(--st-text)'
                }}
              >
                <option value="">-- Select an existing SSH alias --</option>
                {sshConfigHosts.map((h) => (
                  <option key={h.alias} value={h.alias}>
                    {h.alias} {h.hostname && h.hostname !== h.alias ? `(${h.hostname})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block mb-1 text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                Sidebar Label
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="dev92"
                className="w-full rounded border px-2.5 py-1.5 outline-none font-mono text-[11.5px]"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              />
            </div>
            <div>
              <label className="block mb-1 text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                SSH Host Alias or IP *
              </label>
              <input
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="dev92 or 10.0.1.5"
                className="w-full rounded border px-2.5 py-1.5 outline-none font-mono text-[11.5px]"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block mb-1 text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                Default Directory
              </label>
              <input
                value={defaultPath}
                onChange={(e) => setDefaultPath(e.target.value)}
                placeholder="~/workspace"
                className="w-full rounded border px-2.5 py-1.5 outline-none font-mono text-[11.5px]"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              />
            </div>
            <div>
              <label className="block mb-1 text-[11px]" style={{ color: 'var(--st-text-muted)' }}>
                User (optional if in ssh_config)
              </label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="root / ubuntu"
                className="w-full rounded border px-2.5 py-1.5 outline-none font-mono text-[11.5px]"
                style={{ backgroundColor: 'var(--st-input)', borderColor: 'var(--st-border-light)' }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useTmux}
                onChange={(e) => setUseTmux(e.target.checked)}
              />
              <span className="text-[11.5px]">Auto-attach tmux session</span>
            </label>

            <div className="flex items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="h-3.5 w-3.5 rounded-full"
                  style={{
                    backgroundColor: c,
                    outline: color === c ? '2px solid white' : 'none'
                  }}
                />
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t" style={{ borderColor: 'var(--st-border)' }}>
            <button
              type="button"
              onClick={() => setShow(false)}
              className="rounded px-3 py-1 text-[11.5px] hover:bg-white/10"
              style={{ color: 'var(--st-text-muted)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded px-3.5 py-1 text-[11.5px] font-semibold text-[#111]"
              style={{ backgroundColor: 'var(--st-accent)' }}
            >
              Add Workspace
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
