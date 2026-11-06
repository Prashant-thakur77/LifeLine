import { postInfo, type InfoOptions } from "./info";
import { isRecord, toNumber } from "./parse";

/** A coin's current mid price. Throws rather than returning nothing, so a demo can't run on a made-up price. */
export async function getMidPrice(coin: string, options: InfoOptions = {}): Promise<number> {
  const mids = await postInfo({ type: "allMids" }, options);
  if (!isRecord(mids)) throw new Error("Malformed allMids response: not an object");
  const price = toNumber(mids[coin]);
  if (price === null || !(price > 0)) throw new Error(`No usable price for ${coin}`);
  return price;
}
