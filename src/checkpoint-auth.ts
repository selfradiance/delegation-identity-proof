import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface CheckpointSignerKeys {
  publicKey: string;
  privateKey: string;
}

export interface CheckpointSignableRequest {
  delegationId: string;
  delegateId: string;
  actionType: string;
  declaredExposureCents: number;
  payload: unknown;
  timestamp: string;
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildCheckpointSignedMessage(
  request: CheckpointSignableRequest
): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(request))
    .digest();
}

export function signCheckpointRequest(
  request: CheckpointSignableRequest,
  keys: CheckpointSignerKeys
): string {
  const publicKeyBytes = Buffer.from(keys.publicKey, "base64");
  const privateKeyBytes = Buffer.from(keys.privateKey, "base64");

  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: toBase64Url(publicKeyBytes),
      d: toBase64Url(privateKeyBytes),
    },
    format: "jwk",
  });

  return sign(null, buildCheckpointSignedMessage(request), privateKey).toString(
    "base64"
  );
}

export function verifyCheckpointRequestSignature(
  request: CheckpointSignableRequest,
  signatureBase64: string,
  publicKeyBase64: string
): boolean {
  try {
    const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: toBase64Url(publicKeyBytes),
      },
      format: "jwk",
    });

    return verify(
      null,
      buildCheckpointSignedMessage(request),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}
