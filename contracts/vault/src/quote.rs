//! Checks a 1Click quote on chain. The keeper passes the exact text 1Click signed (stable
//! JSON of the request, the quote and its timestamp) with 1Click's signature over the
//! base58 SHA-256 of that text. If the signature holds, every field read from the text is
//! what 1Click quoted, so the deposit address really is 1Click's, for this user's own
//! Hyperliquid account, this amount, and refunds to this user.

use near_sdk::serde_json::{self, Map, Value};
use near_sdk::{bs58, env};

/// Hyperliquid perps USDC as 1Click names it. The HyperEVM USDC adds no margin.
pub const HYPERLIQUID_USDC: &str = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";
/// Matches the keeper's 1% limit.
pub const MAX_SLIPPAGE_BPS: u64 = 100;
/// A quote older than this is refused, so a transaction that lands late can't use it.
pub const MAX_QUOTE_AGE_MS: u64 = 120_000;
/// 1Click's clock and NEAR's block time may disagree a little.
pub const MAX_CLOCK_SKEW_MS: u64 = 30_000;
/// The rescue token has 6 decimals and Hyperliquid USDC 8, so 1 unit in is worth 100 out.
pub const OUT_UNITS_PER_IN: u128 = 100;
/// 1Click's flat fee for delivering to Hyperliquid is about 0.32 USDC; more than 1 USDC is refused.
pub const MAX_WITHDRAW_FEE: u128 = 100_000_000;
/// Beyond the flat fee, what's delivered may be at most this far below what's sent. App fees
/// aren't in the signed text, but they lower amountOut, which is, so a keeper can't skim one.
pub const MAX_PRICE_LOSS_BPS: u128 = 30;
/// Fields that send money or refunds somewhere a quote's recipient and refundTo don't say.
const REDIRECTING_FIELDS: [&str; 4] = ["virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg", "depositMemo"];

/// What the quote must say for this rescue.
pub struct Expected<'a> {
    pub user: &'a str,
    pub token: &'a str,
    pub amount: u128,
    pub deposit_address: &'a str,
    pub hl_address: &'a str,
    pub now_ms: u64,
}

/// `ed25519:<base58>` or bare base58, into the key's 32 bytes.
pub fn parse_public_key(text: &str) -> Option<[u8; 32]> {
    let bytes = bs58::decode(text.strip_prefix("ed25519:").unwrap_or(text)).into_vec().ok()?;
    bytes.try_into().ok()
}

fn parse_signature(text: &str) -> Option<[u8; 64]> {
    let bytes = bs58::decode(text.strip_prefix("ed25519:").unwrap_or(text)).into_vec().ok()?;
    bytes.try_into().ok()
}

/// 1Click signs the base58 text of the payload's SHA-256, not the hash's bytes.
pub fn signed_message(payload: &str) -> String {
    bs58::encode(env::sha256_array(payload.as_bytes())).into_string()
}

pub fn is_signed(payload: &str, signature: &str, signer: &[u8; 32]) -> bool {
    match parse_signature(signature) {
        Some(signature) => env::ed25519_verify(&signature, signed_message(payload), signer),
        None => false,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// "2026-11-08T13:13:49.310Z" in ms since the epoch. Anything else is None.
pub fn iso_to_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if !text.ends_with('Z') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        if part.bytes().all(|b| b.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let millis = match &text[19..text.len() - 1] {
        "" => 0,
        fraction if fraction.starts_with('.') && fraction.len() > 1 && fraction[1..].bytes().all(|b| b.is_ascii_digit()) => {
            format!("{:0<3}", &fraction[1..])[..3].parse::<i64>().ok()?
        }
        _ => return None,
    };
    let ms = ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis;
    u64::try_from(ms).ok()
}

fn text<'a>(fields: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    fields.get(name).and_then(Value::as_str)
}

/// A base-unit amount: digits only.
fn units(fields: &Map<String, Value>, name: &str) -> Option<u128> {
    text(fields, name).filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())).and_then(|t| t.parse().ok())
}

/// Every reason the quote doesn't fit the rescue, as one message, or Ok.
pub fn check(payload: &str, expected: &Expected) -> Result<(), String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| "the quote isn't JSON".to_string())?;
    let Some(fields) = value.as_object() else {
        return Err("the quote isn't a JSON object".into());
    };
    let amount = expected.amount.to_string();
    let mut problems: Vec<&str> = Vec::new();

    if fields.get("dry") != Some(&Value::Bool(false)) {
        problems.push("it's a dry run, with no deposit address 1Click will honour");
    }
    if text(fields, "swapType") != Some("EXACT_INPUT")
        || text(fields, "depositType") != Some("ORIGIN_CHAIN")
        || text(fields, "recipientType") != Some("DESTINATION_CHAIN")
    {
        problems.push("it isn't a deposit on NEAR paid out on the destination chain");
    }
    if text(fields, "originAsset") != Some(format!("nep141:{}", expected.token).as_str()) {
        problems.push("it doesn't take this token");
    }
    if text(fields, "destinationAsset") != Some(HYPERLIQUID_USDC) {
        problems.push("it doesn't pay Hyperliquid perps USDC");
    }
    if text(fields, "amount") != Some(amount.as_str()) || text(fields, "amountIn") != Some(amount.as_str()) {
        problems.push("its amount isn't this rescue's");
    }
    if text(fields, "refundTo") != Some(expected.user) {
        problems.push("a failed swap wouldn't refund this user");
    }
    if text(fields, "refundType") != Some("ORIGIN_CHAIN") {
        problems.push("it refunds somewhere other than the user's own NEAR account");
    }
    if REDIRECTING_FIELDS.iter().any(|name| fields.contains_key(*name)) {
        problems.push("it carries a field that could redirect the money");
    }
    let value = expected.amount.saturating_mul(OUT_UNITS_PER_IN);
    match (units(fields, "amountOut"), units(fields, "minAmountOut"), units(fields, "withdrawFee")) {
        (Some(out), Some(min), Some(fee)) => {
            if fee > MAX_WITHDRAW_FEE {
                problems.push("its flat fee is over 1 USDC");
            }
            if fee.saturating_mul(5) > value {
                problems.push("its flat fee would eat more than a fifth of the rescue");
            }
            if out.saturating_add(fee) < value / 10_000 * (10_000 - MAX_PRICE_LOSS_BPS) {
                problems.push("it delivers too little for the amount sent");
            }
            if out.saturating_sub(min) > value / 10_000 * MAX_SLIPPAGE_BPS as u128 {
                problems.push("its slippage floor is more than 1% below its price");
            }
        }
        _ => problems.push("its amounts can't be read"),
    }
    if text(fields, "recipient").map(str::to_ascii_lowercase).as_deref() != Some(expected.hl_address) {
        problems.push("it pays someone other than this user's Hyperliquid address");
    }
    if text(fields, "depositAddress") != Some(expected.deposit_address) {
        problems.push("its deposit address isn't the one this rescue pays");
    }
    if fields.get("slippageTolerance").and_then(Value::as_u64).is_none_or(|bps| bps > MAX_SLIPPAGE_BPS) {
        problems.push("its slippage is over 1%");
    }
    match text(fields, "timestamp").and_then(iso_to_ms) {
        None => problems.push("its time can't be read"),
        Some(at) if expected.now_ms > at && expected.now_ms - at > MAX_QUOTE_AGE_MS => problems.push("it's more than 2 minutes old"),
        Some(at) if at > expected.now_ms && at - expected.now_ms > MAX_CLOCK_SKEW_MS => problems.push("it's dated in the future"),
        Some(_) => {}
    }

    if problems.is_empty() { Ok(()) } else { Err(problems.join("; ")) }
}
