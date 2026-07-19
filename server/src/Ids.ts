import { Effect } from "effect"
import * as NodeCrypto from "node:crypto"

export const newId = Effect.sync(() => NodeCrypto.randomUUID())

/** 6-char join code from an unambiguous alphabet (no 0/O/1/I/L/5/S). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789"

export const newJoinCode = Effect.sync(() => {
  const bytes = NodeCrypto.randomBytes(6)
  let code = ""
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return code
})

/** Teacher secret: URL-safe, unguessable. */
export const newSecret = Effect.sync(() => NodeCrypto.randomBytes(18).toString("base64url"))
