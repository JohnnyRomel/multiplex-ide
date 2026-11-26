import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { Environment, TransferDirection, TransferRequest, TransferTask } from '@shared/types'
import type { UnifiedVfs } from './vfs'

interface ActiveController {
  cancelled: boolean
  abort?: () => void
}

interface TransferItemPlan {
  sourcePath: string
  targetPath: string
  size: number
  isDirectory: boolean
  mode?: number
}

/** Owner-executable source files stay executable on the target; everything else lands as 0644. */
function modeFromPermissions(perms?: string): number | undefined {
  if (!perms || perms.length < 3) return undefined
  return perms[2] === 'x' ? 0o755 : 0o644
}

export class TransferManager {
  private tasks = new Map<string, TransferTask>()
  private controllers = new Map<string, ActiveController>()
  private queue: Array<{ taskId: string; sourceEnv: Environment; targetEnv: Environment; req: TransferRequest }> = []
  private activeCount = 0
  private readonly maxConcurrency = 3
  private counter = 0

  constructor(
    private vfs: UnifiedVfs,
    private onUpdate: (task: TransferTask) => void
  ) {}

  list(): TransferTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  clearFinished(): void {
    for (const [id, t] of this.tasks) {
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
        this.tasks.delete(id)
      }
    }
  }

  async enqueue(sourceEnv: Environment, targetEnv: Environment, req: TransferRequest): Promise<TransferTask> {
    const srcNorm = await this.vfs.normalizePath(sourceEnv, req.sourcePath)
    const dstDirNorm = await this.vfs.normalizePath(targetEnv, req.targetDir)
    const srcStat = await this.vfs.stat(sourceEnv, srcNorm)

    let direction: TransferDirection = 'cross-env'
    if (sourceEnv.kind === 'local' && targetEnv.kind === 'ssh') {
      direction = 'upload'
    } else if (sourceEnv.kind === 'ssh' && targetEnv.kind === 'local') {
      direction = 'download'
    }

    const id = `xfer-${++this.counter}-${Date.now().toString(36)}`
    const task: TransferTask = {
      id,
      direction,
      sourceEnvId: sourceEnv.id,
      sourcePath: srcNorm,
      targetEnvId: targetEnv.id,
      targetDir: dstDirNorm,
      itemName: srcStat.name,
      isDirectory: srcStat.isDirectory,
      status: 'queued',
      bytesTransferred: 0,
      totalBytes: srcStat.isDirectory ? 0 : srcStat.size,
      filesCompleted: 0,
      totalFiles: srcStat.isDirectory ? 0 : 1,
      speedBps: 0,
      createdAt: Date.now()
    }

    this.tasks.set(id, task)
    this.controllers.set(id, { cancelled: false })
    this.emit(task)

    this.queue.push({
      taskId: id,
      sourceEnv,
      targetEnv,
      req: { ...req, sourcePath: srcNorm, targetDir: dstDirNorm }
    })
    this.drainQueue()
    return task
  }

  cancel(taskId: string): void {
    const ctrl = this.controllers.get(taskId)
    if (ctrl) {
      ctrl.cancelled = true
      ctrl.abort?.()
    }
    const task = this.tasks.get(taskId)
    if (task && (task.status === 'queued' || task.status === 'running')) {
      task.status = 'cancelled'
      task.finishedAt = Date.now()
      this.emit(task)
    }
  }

  private emit(task: TransferTask): void {
    this.onUpdate({ ...task })
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!
      const ctrl = this.controllers.get(next.taskId)
      if (!ctrl || ctrl.cancelled) continue
      this.activeCount++
      this.executeTask(next.taskId, next.sourceEnv, next.targetEnv, next.req)
        .finally(() => {
          this.activeCount--
          this.controllers.delete(next.taskId)
          this.drainQueue()
        })
    }
  }

  private async collectPlan(
    sourceEnv: Environment,
    sourcePath: string,
    targetPath: string,
    ctrl: ActiveController,
    budget?: { maxBytes: number; used: number },
    depth = 0
  ): Promise<TransferItemPlan[]> {
    if (ctrl.cancelled) return []
    if (depth > 64) throw new Error(`Directory nesting too deep (symlink loop?) at ${sourcePath}`)
    const st = await this.vfs.stat(sourceEnv, sourcePath)
    if (!st.isDirectory) {
      if (budget) {
        budget.used += st.size
        if (budget.used > budget.maxBytes) throw new Error('SIZE_BUDGET_EXCEEDED')
      }
      return [{ sourcePath, targetPath, size: st.size, isDirectory: false, mode: modeFromPermissions(st.permissions) }]
    }
    // Never recurse through a symlinked directory (ancestor loops / pnpm trees would explode)
    if (st.isSymlink && depth > 0) return []

    const plan: TransferItemPlan[] = [{ sourcePath, targetPath, size: 0, isDirectory: true }]
    const entries = await this.vfs.readDir(sourceEnv, sourcePath)
    for (const child of entries) {
      if (ctrl.cancelled) break
      if (child.isSymlink && child.isDirectory) continue
      const childTarget = path.posix.join(targetPath, child.name)
      const sub = await this.collectPlan(sourceEnv, child.path, childTarget, ctrl, budget, depth + 1)
      plan.push(...sub)
    }
    return plan
  }

  private async executeTask(
    taskId: string,
    sourceEnv: Environment,
    targetEnv: Environment,
    req: TransferRequest
  ): Promise<void> {
    const task = this.tasks.get(taskId)
    const ctrl = this.controllers.get(taskId)
    if (!task || !ctrl || ctrl.cancelled) return

    task.status = 'running'
    this.emit(task)

    try {
      const destRoot = path.posix.join(req.targetDir, task.itemName)
      if (sourceEnv.id === targetEnv.id && req.sourcePath === destRoot) {
        throw new Error('Source and destination paths are identical')
      }

      const plan = await this.collectPlan(sourceEnv, req.sourcePath, destRoot, ctrl)
      if (ctrl.cancelled) return

      const fileItems = plan.filter((p) => !p.isDirectory)
      task.totalFiles = Math.max(1, fileItems.length)
      task.totalBytes = fileItems.reduce((sum, p) => sum + p.size, 0)
      this.emit(task)

      const startedAt = Date.now()
      let lastEmit = 0

      // Create all directories first
      for (const dirItem of plan.filter((p) => p.isDirectory)) {
        if (ctrl.cancelled) return
        await this.vfs.mkdir(targetEnv, dirItem.targetPath)
      }

      // Stream each file directly from source VFS to target VFS (constant memory!)
      for (const item of fileItems) {
        if (ctrl.cancelled) return
        await this.pipeSingleFile(
          sourceEnv,
          item.sourcePath,
          targetEnv,
          item.targetPath,
          ctrl,
          (chunkBytes) => {
            task.bytesTransferred += chunkBytes
            const now = Date.now()
            if (now - lastEmit >= 120) {
              const elapsedSec = Math.max(0.05, (now - startedAt) / 1000)
              task.speedBps = Math.round(task.bytesTransferred / elapsedSec)
              lastEmit = now
              this.emit(task)
            }
          },
          item.mode
        )
        task.filesCompleted++
        this.emit(task)
      }

      if (ctrl.cancelled) return
      task.status = 'completed'
      task.speedBps = 0
      task.finishedAt = Date.now()
      this.emit(task)
    } catch (err: any) {
      if (ctrl.cancelled) return
      task.status = 'failed'
      task.error = err?.message || String(err)
      task.speedBps = 0
      task.finishedAt = Date.now()
      this.emit(task)
    }
  }

  private async pipeSingleFile(
    sourceEnv: Environment,
    sourcePath: string,
    targetEnv: Environment,
    targetPath: string,
    ctrl: ActiveController,
    onProgress: (bytes: number) => void,
    newFileMode?: number
  ): Promise<void> {
    if (ctrl.cancelled) throw new Error('Transfer cancelled')

    // Create the (possibly slow, remote mkdir + open) write stream FIRST, then the read stream, and attach
    // listeners in the same tick: a local read stream that fails to open (EACCES) must never emit an
    // unhandled 'error' (main-process crash dialog) while we're still awaiting the remote side.
    const writeStream = await this.vfs.createWriteStream(targetEnv, targetPath, newFileMode)
    let readStream: Readable
    try {
      if (ctrl.cancelled) throw new Error('Transfer cancelled')
      readStream = await this.vfs.createReadStream(sourceEnv, sourcePath)
    } catch (err) {
      writeStream.destroy()
      throw err
    }

    readStream.on('data', (chunk: Buffer | string) => {
      onProgress(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk))
    })

    ctrl.abort = () => {
      const err = new Error('Transfer cancelled')
      readStream.destroy(err)
      writeStream.destroy(err)
    }
    try {
      if (ctrl.cancelled) throw new Error('Transfer cancelled')
      await pipeline(readStream, writeStream)
    } finally {
      ctrl.abort = undefined
      if (!readStream.destroyed) readStream.destroy()
      if (!writeStream.destroyed && !writeStream.writableFinished) writeStream.destroy()
    }
  }

  /**
   * Stages a remote file (or small folder) to a local temporary path so Electron's
   * native macOS `webContents.startDrag({ file })` can drop it directly into Finder/Desktop.
   */
  async stageForFinderDrag(env: Environment, remotePath: string, localEnv: Environment): Promise<string> {
    const normPath = await this.vfs.normalizePath(env, remotePath)
    if (env.kind === 'local') return normPath

    const st = await this.vfs.stat(env, normPath)
    const MAX_DRAG_STAGE_BYTES = 50 * 1024 * 1024 // 50MB guard for synchronous drag staging
    if (!st.isDirectory && st.size > MAX_DRAG_STAGE_BYTES) {
      throw new Error('File exceeds 50 MB drag-staging limit; use right-click "Download to..." or Dual-Explorer drag for large files.')
    }

    const stageDir = path.join(os.tmpdir(), 'multiplex-ide-drag', Date.now().toString(36))
    const localTarget = path.join(stageDir, st.name)

    const ctrl: ActiveController = { cancelled: false }
    let plan: TransferItemPlan[]
    try {
      // Stop walking as soon as the size budget is exceeded (never hang on a huge remote folder)
      plan = await this.collectPlan(env, normPath, localTarget, ctrl, { maxBytes: MAX_DRAG_STAGE_BYTES, used: 0 })
    } catch (err: any) {
      if (err?.message === 'SIZE_BUDGET_EXCEEDED') {
        throw new Error('Folder exceeds 50 MB drag-staging limit; use right-click "Download to..." or Dual-Explorer drag.')
      }
      throw err
    }

    // Clean up stale staging dirs from previous drags (older than 1 hour)
    try {
      const root = path.join(os.tmpdir(), 'multiplex-ide-drag')
      for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        const p = path.join(root, name)
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { recursive: true, force: true })
      }
    } catch {
      // ignore cleanup errors
    }
    fs.mkdirSync(stageDir, { recursive: true })

    for (const dir of plan.filter((p) => p.isDirectory)) {
      fs.mkdirSync(dir.targetPath, { recursive: true })
    }
    for (const file of plan.filter((p) => !p.isDirectory)) {
      await this.pipeSingleFile(env, file.sourcePath, localEnv, file.targetPath, ctrl, () => {})
    }

    return localTarget
  }
}
