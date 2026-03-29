import { describe, it, expect, afterAll } from "vitest";
import { loadOrCreateKeypair } from "../src/agentgate-client";
import fs from "fs";

const TEST_IDENTITY_FILE = "test-identity-client.json";

afterAll(() => {
  if (fs.existsSync(TEST_IDENTITY_FILE)) fs.unlinkSync(TEST_IDENTITY_FILE);
});

describe("agentgate-client — unit tests", () => {
  it("generates a valid Ed25519 keypair", () => {
    const keys = loadOrCreateKeypair(TEST_IDENTITY_FILE);
    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    // Ed25519 public key is 32 bytes = ~44 chars in base64
    const pubBytes = Buffer.from(keys.publicKey, "base64");
    expect(pubBytes.length).toBe(32);
    // Ed25519 private key is 32 bytes
    const privBytes = Buffer.from(keys.privateKey, "base64");
    expect(privBytes.length).toBe(32);
  });

  it("persists keypair to file", () => {
    const keys = loadOrCreateKeypair(TEST_IDENTITY_FILE);
    expect(fs.existsSync(TEST_IDENTITY_FILE)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(TEST_IDENTITY_FILE, "utf8"));
    expect(saved.publicKey).toBe(keys.publicKey);
    expect(saved.privateKey).toBe(keys.privateKey);
  });

  it("loads existing keypair on second call", () => {
    const first = loadOrCreateKeypair(TEST_IDENTITY_FILE);
    const second = loadOrCreateKeypair(TEST_IDENTITY_FILE);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });
});
