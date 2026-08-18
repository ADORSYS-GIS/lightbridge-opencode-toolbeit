import { createHash, randomBytes } from "node:crypto";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
}

export function generateStateToken(): string {
  return toBase64Url(randomBytes(24));
}
