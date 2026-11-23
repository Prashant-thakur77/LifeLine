import { DEPLOYED, type KeeperReader, type Network, type VaultReader } from "./tools";

// Every address here is fixed: nothing a caller sends ever becomes a URL.
const TIMEOUT_MS = 8000;

const post = (send: typeof fetch) => async (url: string, body: unknown): Promise<unknown> => {
  const response = await send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.json();
};

export const infoReader = (send: typeof fetch) => (body: Record<string, unknown>) => post(send)("https://api.hyperliquid.xyz/info", body);

export const keeperReader = (send: typeof fetch): KeeperReader => async (path) => {
  const response = await send(`https://lifeline-sim.prashantthakur.dev${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.json();
};

export const vaultReader = (send: typeof fetch): VaultReader => async (network: Network, method, args) => {
  const body = (await post(send)(DEPLOYED[network].rpc, {
    jsonrpc: "2.0",
    id: "lifeline",
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: DEPLOYED[network].vault, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  })) as { result?: { result?: number[]; error?: string } };
  const bytes = body.result?.result;
  if (!Array.isArray(bytes) || body.result?.error) throw new Error("the view failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
};
