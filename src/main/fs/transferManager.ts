import fs from 'fs'
import os from 'os'
import path from 'path'
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
    ctrl: ActiveController
  ): Promise<TransferItemPlan[]> {
    if (ctrl.cancelled) return []
    const st = await this.vfs.stat(sourceEnv, sourcePath)
    if (!st.isDirectory) {
      return [{ sourcePath, targetPath, size: st.size, isDirectory: false }]
    }

    const plan: TransferItemPlan[] = [{ sourcePath, targetPath, size: 0, isDirectory: true }]
    const entries = await this.vfs.readDir(sourceEnv, sourcePath)
    for (const child of entries) {
      if (ctrl.cancelled) break
      const childTarget = path.posix.join(targetPath, child.name)
      const sub = await this.collectPlan(sourceEnv, child.path, childTarget, ctrl)
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
        await this.pipeSingleFile(sourceEnv, item.sourcePath, targetEnv, item.targetPath, ctrl, (chunkBytes) => {
          task.bytesTransferred += chunkBytes
          const now = Date.now()
          if (now - lastEmit >= 120) {
            const elapsedSec = Math.max(0.05, (now - startedAt) / 1000)
            task.speedBps = Math.round(task.bytesTransferred / elapsedSec)
            lastEmit = now
            this.emit(task)
          }
        })
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
    onProgress: (bytes: number) => void
  ): Promise<void> {
    const readStream = await this.vfs.createReadStream(sourceEnv, sourcePath)
    const writeStream = await this.vfs.createWriteStream(targetEnv, targetPath)

    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err?: Error) => {
        if (settled) return
        settled = true
        ctrl.abort = undefined
        if (err) reject(err)
        else resolve()
      }

      ctrl.abort = () => {
        readStream.destroy()
        writeStream.destroy()
        done(new Error('Transfer cancelled'))
      }

      readStream.on('data', (chunk: Buffer | string) => {
        onProgress(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk))
      })
      readStream.on('error', (err) => {
        writeStream.destroy()
        done(err)
      })
      writeStream.on('error', (err) => {
        readStream.destroy()
        done(err)
      })
      writeStream.on('finish', () => done())
      writeStream.on('close', () => done())

      readStream.pipe(writeStream)
    })
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
    fs.mkdirSync(stageDir, { recursive: true })
    const localTarget = path.join(stageDir, st.name)

    const ctrl: ActiveController = { cancelled: false }
    const plan = await this.collectPlan(env, normPath, localTarget, ctrl)
    const totalBytes = plan.reduce((s, p) => s + p.size, 0)
    if (totalBytes > MAX_DRAG_STAGE_BYTES) {
      throw new Error('Folder exceeds 50 MB drag-staging limit; use right-click "Download to..." or Dual-Explorer drag.')
    }

    for (const dir of plan.filter((p) => p.isDirectory)) {
      fs.mkdirSync(dir.targetPath, { recursive: true })
    }
    for (const file of plan.filter((p) => !p.isDirectory)) {
      await this.pipeSingleFile(env, file.sourcePath, localEnv, file.targetPath, ctrl, () => {})
    }

    return localTarget
  }
}
