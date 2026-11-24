import type { MultiplexAPI } from './index'

declare global {
  interface Window {
    multiplex: MultiplexAPI
  }
}

export {}
