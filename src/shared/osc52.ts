/**
 * Decodes an OSC 52 clipboard payload (`<selection>;<base64>`) into UTF-8 text.
 * Supports remote tmux / vim / neovim clipboard forwarding over SSH.
 * Returns null for query packets (`?`) or invalid base64.
 */
export function decodeOsc52Payload(payload: string): string | null {
  const semi = payload.indexOf(';')
  if (semi < 0) return null
  const b64 = payload.slice(semi + 1).trim()
  if (!b64 || b64 === '?') return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) return null
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return null
  }
}
