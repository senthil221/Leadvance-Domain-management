import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Keys pasted in Settings are stored encrypted (AES-256-GCM). The key comes
// from CREDENTIALS_SECRET, or the Supabase service key every server already
// has, so a database dump alone never reveals them.

function key() {
  const secret = process.env.CREDENTIALS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
    || (process.env.NODE_ENV !== "production" ? "local development only" : "");
  if (!secret) throw new Error("Set CREDENTIALS_SECRET (or SUPABASE_SERVICE_ROLE_KEY) on the server to store registrar keys");
  return createHash("sha256").update(`domain-engine:credentials:${secret}`).digest();
}

export function seal(value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function open(sealed: string): Record<string, string> {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable saved keys");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Saved keys can't be read on this server (the encryption secret changed). Remove the account and add it again.");
  }
}
