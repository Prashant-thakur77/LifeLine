// Read-only chain calls over plain JSON-RPC (https://docs.near.org/api/rpc/contracts):
// one fetch per view, no SDK in the bundle. Writes go through the wallet instead. Views
// use optimistic finality, so a balance read right after a transaction already shows it.

export class RpcError extends Error {
  constructor(
    message: string,
    /** "UNKNOWN_ACCOUNT" or "CONTRACT_ERROR" when the RPC said which. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** UTF-8 JSON, base64-encoded, as call_function wants its arguments. */
export function encodeArgs(args: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A view's result arrives as an array of bytes holding UTF-8 JSON. */
export function decodeResult(bytes: readonly number[]): unknown {
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return JSON.parse(text);
}

type RpcBody = {
  result?: { result?: number[]; error?: string };
  error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown };
};

/**
 * The value a view returned, or an RpcError. An account that doesn't exist (like a vault
 * that isn't deployed yet) comes back as cause "UNKNOWN_ACCOUNT"; a contract error, such
 * as a missing method, as cause "CONTRACT_ERROR".
 */
export function parseViewResponse(body: RpcBody): unknown {
  if (body.error) {
    const cause = body.error.cause?.name;
    const data = typeof body.error.data === "string" ? body.error.data : body.error.message ?? "RPC error";
    throw new RpcError(cause === "UNKNOWN_ACCOUNT" ? "That account doesn't exist on this network." : data, cause);
  }
  if (body.result?.error) throw new RpcError(body.result.error, "CONTRACT_ERROR");
  if (!body.result?.result) throw new RpcError("The RPC answer had no result.");
  return decodeResult(body.result.result);
}

export async function viewFunction<T>(rpcUrl: string, contractId: string, method: string, args: unknown = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "lifeline",
        method: "query",
        params: { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: encodeArgs(args) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RpcError("Couldn't reach the NEAR RPC. Check your connection and try again.");
  }
  if (!response.ok) throw new RpcError(`The NEAR RPC answered with HTTP ${response.status}.`);
  return parseViewResponse((await response.json()) as RpcBody) as T;
}

// ---- Transaction outcomes from the wallet ----

/** The parts of a FinalExecutionOutcome the dashboard reads. */
export type Outcome = {
  status?: { SuccessValue?: string; Failure?: unknown } | string;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
};

/** True once the outcome says how the transaction ended: a value or a failure. */
export function outcomeSettled(outcome: Outcome | null | undefined): boolean {
  const status = outcome?.status;
  return typeof status === "object" && status !== null && (status.SuccessValue !== undefined || status.Failure !== undefined);
}

export function outcomeHash(outcome: Outcome | null | undefined): string | null {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null;
}

/** null when the transaction succeeded, otherwise what went wrong in a sentence. */
export function outcomeFailure(outcome: Outcome | null | undefined): string | null {
  const status = outcome?.status;
  if (!status || typeof status === "string" || status.Failure === undefined) return null;
  const text = JSON.stringify(status.Failure);
  const panic = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  return panic ? panic.replace(/^Smart contract panicked: /, "") : "The transaction failed on chain.";
}

/** The JSON a successful call returned, decoded from SuccessValue (base64). */
export function outcomeValue(outcome: Outcome | null | undefined): unknown {
  const status = outcome?.status;
  if (!status || typeof status === "string" || !status.SuccessValue) return null;
  const binary = atob(status.SuccessValue);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
