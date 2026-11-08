export const SANDBOX_VERSION: string;
export function platformDir(platform?: string, arch?: string): string | null;
export function sandboxUrl(platform: string, version?: string): string;
export function byteRanges(size: number, parts: number): [number, number][];
export function s3Etag(data: Buffer, multipart: boolean, partBytes?: number): string;
export function sandboxPath(platform: string, home?: string, version?: string): string;
export function ensureSandbox(options?: { log?: (line: string) => void }): Promise<string | null>;
