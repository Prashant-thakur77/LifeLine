import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { handleApi, jsonResponse, type ApiDeps } from "./api";

function toRequest(message: IncomingMessage): Request {
  // Any client can send any path, and a throw outside the promise chain would kill the keeper.
  const url = new URL(message.url ?? "/", "http://keeper");
  const headers = new Headers();
  for (let i = 0; i + 1 < message.rawHeaders.length; i += 2) {
    headers.append(message.rawHeaders[i] as string, message.rawHeaders[i + 1] as string);
  }
  const method = message.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(message) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
}

/** Serves handleApi over node:http, for `--live` and `--sim` on a machine. */
export function createApi(deps: ApiDeps): Server {
  return createServer((message, response) => {
    const send = async (result: Response) => {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    };
    let request: Request;
    try {
      request = toRequest(message);
    } catch {
      void send(jsonResponse(400, { error: "badly formed path" }, deps.corsOrigin));
      return;
    }
    handleApi(request, deps).then(send, () => send(jsonResponse(500, { error: "internal error" }, deps.corsOrigin)));
  });
}
