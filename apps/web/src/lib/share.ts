const SHARE_URL = "https://lifeline-share.prashantthakur.dev";

/** The link whose preview card shows an address's storm test. */
export const shareCardUrl = (address: string) => `${SHARE_URL}/${address.trim().toLowerCase()}`;
export const shareOnXHref = (address: string) =>
  `https://x.com/intent/post?${new URLSearchParams({ text: "What market move liquidates this Hyperliquid account, with and without Lifeline:", url: shareCardUrl(address) })}`;
