/** Bounded process-pipe framing. Storage validates and selects metadata fields. */
export function createUsageReceiver(record: (event: unknown) => void) {
  const decoder = new TextDecoder()
  let pending = ""
  let oversized = false
  return (bytes: Uint8Array) => {
    pending += decoder.decode(bytes, { stream: true })
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!oversized && line.length <= 16384) {
        try {
          record(JSON.parse(line))
        } catch {
          console.error("Invalid usage metadata")
        }
      }
      oversized = false
    }
    if (pending.length > 16384) {
      pending = ""
      oversized = true
    }
  }
}
