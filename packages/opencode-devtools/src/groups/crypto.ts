import { createHash, createHmac, generateKeyPairSync } from "node:crypto";

import { json, reqNumber, reqString, text, type ToolContext, type ToolSpec } from "../tool-spec.js";

const HASH_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"] as const;
const BYTE_ENCODINGS = ["utf8", "hex", "base64"] as const;
const OUT_ENCODINGS = ["hex", "base64", "base64url"] as const;

function asBuffer(value: string, encoding: string): Buffer {
  return Buffer.from(value, encoding as BufferEncoding);
}

// ─── UUID (v4 / v7) over injected randomness + clock ─────────────────────────
function uuidV4(ctx: ToolContext): string {
  const b = Buffer.from(ctx.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidV7(ctx: ToolContext): string {
  const ms = ctx.now().getTime();
  const b = Buffer.from(ctx.randomBytes(16));
  b.writeUIntBE(ms, 0, 6); // 48-bit big-endian unix-ms timestamp
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── ULID (Crockford base32, 48-bit time + 80-bit randomness) ────────────────
const MAX_COUNT = 1000;

/** Clamp a requested identifier count to [1, MAX_COUNT] so a caller can't ask for millions. */
function clampCount(raw: unknown): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return 1;
  }
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(raw)));
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(ctx: ToolContext): string {
  let ms = ctx.now().getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let bits = 0n;
  for (const byte of ctx.randomBytes(10)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

export const CRYPTO_TOOLS: readonly ToolSpec[] = [
  {
    name: "crypto_hash",
    group: "crypto",
    description: "Compute a cryptographic hash digest (md5, sha1, sha256, sha512) of some input.",
    input: {
      algorithm: { type: "string", enum: HASH_ALGORITHMS, description: "Digest algorithm." },
      input: { type: "string", description: "Data to hash." },
      inputEncoding: {
        type: "string",
        optional: true,
        enum: BYTE_ENCODINGS,
        description: "How to interpret `input` (default utf8)."
      },
      outputEncoding: {
        type: "string",
        optional: true,
        enum: OUT_ENCODINGS,
        description: "Digest encoding (default hex)."
      }
    },
    handler: (args) => {
      const algorithm = reqString(args, "algorithm");
      const input = reqString(args, "input");
      const inEnc = typeof args.inputEncoding === "string" ? args.inputEncoding : "utf8";
      const outEnc = (typeof args.outputEncoding === "string" ? args.outputEncoding : "hex") as
        | "hex"
        | "base64"
        | "base64url";
      const digest = createHash(algorithm).update(asBuffer(input, inEnc)).digest(outEnc);
      return text(digest);
    }
  },
  {
    name: "crypto_hmac",
    group: "crypto",
    description: "Compute a keyed HMAC (md5, sha1, sha256, sha512) over some input.",
    input: {
      algorithm: { type: "string", enum: HASH_ALGORITHMS, description: "Underlying hash." },
      key: { type: "string", description: "Secret key (utf8)." },
      input: { type: "string", description: "Data to authenticate (utf8)." },
      outputEncoding: {
        type: "string",
        optional: true,
        enum: OUT_ENCODINGS,
        description: "Digest encoding (default hex)."
      }
    },
    handler: (args) => {
      const algorithm = reqString(args, "algorithm");
      const key = reqString(args, "key");
      const input = reqString(args, "input");
      const outEnc = (typeof args.outputEncoding === "string" ? args.outputEncoding : "hex") as
        | "hex"
        | "base64"
        | "base64url";
      return text(createHmac(algorithm, key).update(input, "utf8").digest(outEnc));
    }
  },
  {
    name: "crypto_uuid",
    group: "crypto",
    description:
      "Generate a UUID. Version 4 is random; version 7 is time-ordered (sortable, good for database keys).",
    input: {
      version: {
        type: "string",
        optional: true,
        enum: ["4", "7"],
        description: "UUID version (default 4)."
      },
      count: { type: "number", optional: true, description: "How many to generate (default 1)." }
    },
    handler: (args, ctx) => {
      const version = args.version === "7" ? "7" : "4";
      const count = clampCount(args.count);
      const gen = version === "7" ? () => uuidV7(ctx) : () => uuidV4(ctx);
      const ids = Array.from({ length: count }, gen);
      return count === 1 ? text(ids[0]) : json({ version, ids }, ids.join("\n"));
    }
  },
  {
    name: "crypto_ulid",
    group: "crypto",
    description:
      "Generate a ULID — a 26-char, lexicographically-sortable, Crockford-base32 identifier (48-bit timestamp + 80-bit randomness).",
    input: {
      count: { type: "number", optional: true, description: "How many to generate (default 1)." }
    },
    handler: (args, ctx) => {
      const count = clampCount(args.count);
      const ids = Array.from({ length: count }, () => ulid(ctx));
      return count === 1 ? text(ids[0]) : json({ ids }, ids.join("\n"));
    }
  },
  {
    name: "crypto_random",
    group: "crypto",
    description:
      "Generate cryptographically-strong random bytes, encoded as hex, base64 or base64url.",
    input: {
      bytes: { type: "number", description: "Number of random bytes (1–4096)." },
      encoding: {
        type: "string",
        optional: true,
        enum: OUT_ENCODINGS,
        description: "Output encoding (default hex)."
      }
    },
    handler: (args, ctx) => {
      const bytes = reqNumber(args, "bytes");
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4096) {
        throw new Error('"bytes" must be an integer in 1–4096');
      }
      const encoding = (typeof args.encoding === "string" ? args.encoding : "hex") as
        | "hex"
        | "base64"
        | "base64url";
      return text(Buffer.from(ctx.randomBytes(bytes)).toString(encoding));
    }
  },
  {
    name: "crypto_keypair",
    group: "crypto",
    description:
      "Generate an asymmetric keypair (ed25519, rsa, or ec/P-256) and return the PEM-encoded public and private keys.",
    input: {
      type: {
        type: "string",
        optional: true,
        enum: ["ed25519", "rsa", "ec"],
        description: "Key type (default ed25519)."
      },
      modulusLength: {
        type: "number",
        optional: true,
        description: "RSA modulus bits (default 2048; rsa only)."
      }
    },
    handler: (args) => {
      const type = typeof args.type === "string" ? args.type : "ed25519";
      const pem = {
        publicKeyEncoding: { type: "spki" as const, format: "pem" as const },
        privateKeyEncoding: { type: "pkcs8" as const, format: "pem" as const }
      };
      let pair: { publicKey: string; privateKey: string };
      if (type === "rsa") {
        const modulusLength =
          typeof args.modulusLength === "number" ? Math.floor(args.modulusLength) : 2048;
        // generateKeyPairSync blocks the event loop; a huge modulus is a DoS.
        if (modulusLength < 1024 || modulusLength > 4096) {
          throw new Error('"modulusLength" must be between 1024 and 4096');
        }
        pair = generateKeyPairSync("rsa", {
          modulusLength,
          publicKeyEncoding: pem.publicKeyEncoding,
          privateKeyEncoding: pem.privateKeyEncoding
        });
      } else if (type === "ec") {
        pair = generateKeyPairSync("ec", {
          namedCurve: "P-256",
          publicKeyEncoding: pem.publicKeyEncoding,
          privateKeyEncoding: pem.privateKeyEncoding
        });
      } else {
        pair = generateKeyPairSync("ed25519", {
          publicKeyEncoding: pem.publicKeyEncoding,
          privateKeyEncoding: pem.privateKeyEncoding
        });
      }
      return json(
        { type, publicKey: pair.publicKey, privateKey: pair.privateKey },
        `${pair.publicKey}\n${pair.privateKey}`
      );
    }
  }
];
