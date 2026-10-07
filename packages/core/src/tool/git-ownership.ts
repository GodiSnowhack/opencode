import { contentHash } from "./workspace-files"

const writes = new Map<string, { before?: string; after: string }>()
const key = (session: string, target: string) =>
  `${session}:${process.platform === "win32" ? target.toLowerCase() : target}`

/** Bounded process-local evidence from successful canonical filesystem writes only. */
export function recordGitWrite(session: string, target: string, before: Uint8Array | undefined, after: Uint8Array) {
  const id = key(session, target)
  const previous = writes.get(id)
  writes.set(id, {
    before:
      previous && previous.after === (before ? contentHash(before) : undefined)
        ? previous.before
        : before
          ? contentHash(before)
          : undefined,
    after: contentHash(after),
  })
  if (writes.size > 2048) writes.delete(writes.keys().next().value!)
}

export const gitWriteEvidence = (session: string, target: string) => writes.get(key(session, target))
