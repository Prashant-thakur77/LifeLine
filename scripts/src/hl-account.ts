/**
 * Hyperliquid user-signed actions for the mainnet rescue's account, by API. Real money:
 * run a step only after a human has agreed to that step. The key comes from .env
 * (HL_MAINNET_PRIVATE_KEY) and is never printed.
 *
 *   … hl-account.ts read                    the account's mode and balances (no signing)
 *   … hl-account.ts disable-unified         userSetAbstraction → "disabled" (standard mode)
 *   … hl-account.ts spot-to-perp <amount>   usdClassTransfer of that much USDC, spot to perps
 */
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

type Field = { name: string; type: string };
type Types = Record<string, Field[]>;

const enc = new TextEncoder();
const word = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** EIP-712's encodeType: the primary type, then every struct it uses, sorted by name. */
function encodeType(primary: string, types: Types): string {
  const deps = new Set<string>();
  const walk = (name: string) => {
    for (const f of types[name] ?? []) {
      const base = f.type.replace(/\[\]$/, "");
      if (types[base] && !deps.has(base) && base !== primary) {
        deps.add(base);
        walk(base);
      }
    }
  };
  walk(primary);
  return [primary, ...[...deps].sort()].map((name) => `${name}(${types[name]!.map((f) => `${f.type} ${f.name}`).join(",")})`).join("");
}

function encodeValue(type: string, value: unknown, types: Types): Uint8Array {
  if (types[type]) return hashStruct(type, value as Record<string, unknown>, types);
  if (type === "string") return keccak_256(enc.encode(value as string));
  if (type === "bytes") return keccak_256(hexToBytes((value as string).replace(/^0x/, "")));
  if (type === "address") return word(BigInt(value as string));
  if (type === "bool") return word(value ? 1n : 0n);
  if (/^uint\d+$/.test(type)) return word(BigInt(value as number | string));
  throw new Error(`unsupported EIP-712 type ${type}`);
}

export function hashStruct(primary: string, data: Record<string, unknown>, types: Types): Uint8Array {
  const typeHash = keccak_256(enc.encode(encodeType(primary, types)));
  return keccak_256(concat(typeHash, ...types[primary]!.map((f) => encodeValue(f.type, data[f.name], types))));
}

const DOMAIN_TYPE: Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** The 32 bytes an EIP-712 signature signs: keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)). */
export function typedDataDigest(domain: Record<string, unknown>, primary: string, types: Types, message: Record<string, unknown>): Uint8Array {
  const all = { ...types, EIP712Domain: DOMAIN_TYPE };
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), hashStruct("EIP712Domain", domain, all), hashStruct(primary, message, all)));
}

export function addressOf(secret: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(secret, false).slice(1)).slice(-20))}`;
}

/** An Ethereum-style signature: r, s and v = 27 + recovery bit, as Hyperliquid's API takes it. */
export function signDigest(digest: Uint8Array, secret: Uint8Array): { r: string; s: string; v: number } {
  const sig = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  return { r: `0x${bytesToHex(sig.slice(1, 33))}`, s: `0x${bytesToHex(sig.slice(33, 65))}`, v: 27 + sig[0]! };
}

export function recoverAddress(digest: Uint8Array, sig: { r: string; s: string; v: number }): string {
  const raw = concat(new Uint8Array([sig.v - 27]), hexToBytes(sig.r.slice(2)), hexToBytes(sig.s.slice(2)));
  const pub = secp256k1.recoverPublicKey(raw, digest, { prehash: false });
  return `0x${bytesToHex(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).slice(1)).slice(-20))}`;
}

/** Hyperliquid's user-signed action envelope, as its Python SDK builds it (sign_user_signed_action). */
export const SIGNATURE_CHAIN_ID = "0x66eee";
export const HL_DOMAIN = { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(SIGNATURE_CHAIN_ID, 16), verifyingContract: "0x0000000000000000000000000000000000000000" };
export const USER_SET_ABSTRACTION: Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "user", type: "address" },
  { name: "abstraction", type: "string" },
  { name: "nonce", type: "uint64" },
];
export const USD_CLASS_TRANSFER: Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "amount", type: "string" },
  { name: "toPerp", type: "bool" },
  { name: "nonce", type: "uint64" },
];

export function userSignedAction(primary: string, fields: Field[], action: Record<string, unknown>, secret: Uint8Array) {
  const full: Record<string, unknown> = { ...action, signatureChainId: SIGNATURE_CHAIN_ID, hyperliquidChain: "Mainnet" };
  const digest = typedDataDigest(HL_DOMAIN, primary, { [primary]: fields }, full);
  return { action: full, signature: signDigest(digest, secret), digest };
}

const API = "https://api.hyperliquid.xyz";
const info = async (body: unknown) => (await fetch(`${API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

async function read(user: string) {
  const c = (await info({ type: "clearinghouseState", user })) as { marginSummary: { accountValue: string }; withdrawable: string; crossMaintenanceMarginUsed: string; assetPositions: unknown[] };
  const s = (await info({ type: "spotClearinghouseState", user })) as { balances: { coin: string; total: string; hold: string }[] };
  const usdc = s.balances.find((b) => b.coin === "USDC");
  return {
    userAbstraction: await info({ type: "userAbstraction", user }),
    perpsAccountValue: c.marginSummary.accountValue,
    withdrawable: c.withdrawable,
    crossMaintenanceMarginUsed: c.crossMaintenanceMarginUsed,
    positions: c.assetPositions.length,
    spotUsdc: usdc?.total ?? "0",
    spotUsdcHold: usdc?.hold ?? "0",
  };
}

function secretFromEnv(): { secret: Uint8Array; user: string } {
  const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const raw = text.match(/^HL_MAINNET_PRIVATE_KEY=(.*)$/m)?.[1]?.trim().replace(/^0x/, "");
  const user = text.match(/^HL_MAINNET_ADDRESS=(.*)$/m)?.[1]?.trim().toLowerCase();
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw) || !user) throw new Error("HL_MAINNET_PRIVATE_KEY and HL_MAINNET_ADDRESS must be in .env");
  const secret = hexToBytes(raw);
  if (addressOf(secret) !== user) throw new Error("HL_MAINNET_PRIVATE_KEY doesn't derive to HL_MAINNET_ADDRESS");
  return { secret, user };
}

async function post(signed: ReturnType<typeof userSignedAction>, user: string) {
  // Never send a signature that doesn't recover to the account itself.
  if (recoverAddress(signed.digest, signed.signature) !== user) throw new Error("the signature doesn't recover to the account: not sending");
  const body = { action: signed.action, nonce: signed.action.nonce, signature: signed.signature };
  const response = await fetch(`${API}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log(`  ${String(signed.action.type)}: HTTP ${response.status} ${await response.text()}`);
}

if (process.argv[1]?.endsWith("hl-account.ts")) {
  const [command, arg] = process.argv.slice(2);
  (async () => {
    const { secret, user } = secretFromEnv();
    if (command === "read") {
      console.log(JSON.stringify(await read(user), null, 2));
    } else if (command === "disable-unified") {
      await post(userSignedAction("HyperliquidTransaction:UserSetAbstraction", USER_SET_ABSTRACTION, { type: "userSetAbstraction", user, abstraction: "disabled", nonce: Date.now() }, secret), user);
    } else if (command === "spot-to-perp") {
      const spot = Number((await read(user)).spotUsdc);
      if (!arg || !/^\d+(\.\d{1,6})?$/.test(arg) || Number(arg) <= 0 || Number(arg) > spot || Number(arg) > 2.531506) throw new Error(`amount must be at most the spot USDC (${spot}) and at most 2.531506`);
      await post(userSignedAction("HyperliquidTransaction:UsdClassTransfer", USD_CLASS_TRANSFER, { type: "usdClassTransfer", amount: arg, toPerp: true, nonce: Date.now() }, secret), user);
    } else {
      throw new Error("usage: hl-account.ts read | disable-unified | spot-to-perp <amount>");
    }
  })().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`  stopped: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
