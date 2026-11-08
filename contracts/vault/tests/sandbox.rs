//! The vault on a local NEAR sandbox node, with a real NEP-141 token: deposits through
//! ft_transfer_call, rescues paid to the deposit address in a signed quote, attacks by a
//! keeper that changes where the money goes, refunds of a failed transfer, and
//! withdrawals. src/tests.rs covers each rule on its own, and a real 1Click quote.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::bs58;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::OnceCell;

const USDC_1: u128 = 1_000_000;
const HL: &str = "0xabcdef0123456789abcdef0123456789abcdef01";
const ATTACKER_HL: &str = "0x9999999999999999999999999999999999999999";
const PERPS_USDC: &str = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";

static VAULT_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static TOKEN_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static NEXT_ADDRESS: AtomicU64 = AtomicU64::new(1);

async fn vault_wasm() -> &'static [u8] {
    VAULT_WASM.get_or_init(|| async { near_workspaces::compile_project("./").await.expect("vault builds") }).await
}

async fn token_wasm() -> &'static [u8] {
    TOKEN_WASM
        .get_or_init(|| async { near_workspaces::compile_project("./tests/mock-ft").await.expect("mock token builds") })
        .await
}

/// Stands in for 1Click's quote-signing key: the vault here is set up to trust it.
fn quote_signer() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

/// 1Click signs the base58 text of the quote's SHA-256.
fn sign(key: &SigningKey, payload: &str) -> String {
    let message = bs58::encode(Sha256::digest(payload.as_bytes())).into_string();
    format!("ed25519:{}", bs58::encode(key.sign(message.as_bytes()).to_bytes()).into_string())
}

/// A fresh implicit account, as 1Click hands out for each quote.
fn fresh_address() -> String {
    let n = NEXT_ADDRESS.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{:x}", Sha256::digest(format!("{n}-{nanos}")))
}

fn iso_now_minus(seconds: u64) -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 - seconds * 1000;
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

struct Quote {
    payload: String,
    signature: String,
    deposit: String,
}

struct Setup {
    worker: Worker<Sandbox>,
    vault: Contract,
    usdc: Contract,
    alice: Account,
    keeper: Account,
}

impl Setup {
    /// Alice has 100 USDC, a policy naming `keeper`, and 30 USDC in her reserve.
    async fn new() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let usdc = worker.dev_deploy(token_wasm().await).await?;
        usdc.call("new").transact().await?.into_result()?;
        let vault = worker.dev_deploy(vault_wasm().await).await?;
        vault
            .call("new")
            .args_json(json!({ "tokens": [usdc.id()], "quote_signer": public_key(&quote_signer()) }))
            .transact()
            .await?
            .into_result()?;
        let alice = worker.dev_create_account().await?;
        let keeper = worker.dev_create_account().await?;

        usdc.call("mint").args_json(json!({ "account_id": alice.id(), "amount": (100 * USDC_1).to_string() })).transact().await?.into_result()?;
        usdc.call("mint").args_json(json!({ "account_id": vault.id(), "amount": "0" })).transact().await?.into_result()?;

        let setup = Self { worker, vault, usdc, alice, keeper };
        setup.set_policy(NearToken::from_millinear(50)).await?.into_result()?;
        setup.deposit(30 * USDC_1).await?.into_result()?;
        Ok(setup)
    }

    async fn set_policy(&self, deposit: NearToken) -> anyhow::Result<ExecutionFinalResult> {
        let policy = json!({
            "hl_address": HL,
            "keeper": self.keeper.id(),
            "warn": 1.8,
            "trigger": 1.5,
            "target": 2.0,
            "max_per_rescue": (25 * USDC_1).to_string(),
            "max_per_day": (50 * USDC_1).to_string(),
            "cooldown_sec": 120,
        });
        Ok(self.alice.call(self.vault.id(), "set_policy").args_json(json!({ "policy": policy })).deposit(deposit).transact().await?)
    }

    async fn deposit(&self, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .alice
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.vault.id(), "amount": amount.to_string(), "msg": "" }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// What 1Click would sign for a rescue of Alice's: `amount` to `recipient` via a fresh deposit address.
    fn quote(&self, key: &SigningKey, amount: u128, recipient: &str) -> Quote {
        let deposit = fresh_address();
        let payload = json!({
            "amount": amount.to_string(),
            "amountIn": amount.to_string(),
            "depositAddress": deposit,
            "depositType": "ORIGIN_CHAIN",
            "destinationAsset": PERPS_USDC,
            "dry": false,
            "originAsset": format!("nep141:{}", self.usdc.id()),
            "recipient": recipient,
            "recipientType": "DESTINATION_CHAIN",
            "refundTo": self.alice.id(),
            "refundType": "ORIGIN_CHAIN",
            "slippageTolerance": 100,
            "swapType": "EXACT_INPUT",
            "timestamp": iso_now_minus(2),
        })
        .to_string();
        let signature = sign(key, &payload);
        Quote { payload, signature, deposit }
    }

    /// Calls rescue as `caller`, paying `deposit_address`, with the quote `quote`.
    async fn rescue_with(&self, caller: &Account, amount: u128, recipient: &str, deposit_address: &str, quote: &Quote) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.vault.id(), "rescue")
            .args_json(json!({
                "user": self.alice.id(),
                "token": self.usdc.id(),
                "amount": amount.to_string(),
                "deposit_address": deposit_address,
                "recipient": recipient,
                "quote_id": "corr-1",
                "quote": quote.payload,
                "signature": quote.signature,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// An honest rescue: a genuine quote for Alice's address, paid to its own deposit address.
    async fn rescue(&self, amount: u128) -> anyhow::Result<(ExecutionFinalResult, String)> {
        let quote = self.quote(&quote_signer(), amount, HL);
        let result = self.rescue_with(&self.keeper, amount, HL, &quote.deposit, &quote).await?;
        Ok((result, quote.deposit))
    }

    async fn balance(&self, account: &str) -> anyhow::Result<u128> {
        let raw: String = self.usdc.view("ft_balance_of").args_json(json!({ "account_id": account })).await?.json()?;
        Ok(raw.parse()?)
    }

    async fn reserve(&self) -> anyhow::Result<u128> {
        let reserve: Value = self.vault.view("get_reserve").args_json(json!({ "user": self.alice.id() })).await?.json()?;
        Ok(reserve[self.usdc.id().as_str()].as_str().unwrap().parse()?)
    }

    async fn rescues(&self) -> anyhow::Result<Value> {
        Ok(self.vault.view("get_rescues").args_json(json!({ "user": self.alice.id(), "from": 0, "limit": 100 })).await?.json()?)
    }
}

fn event(result: &ExecutionFinalResult, name: &str) -> Option<Value> {
    result
        .logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str::<Value>(json).unwrap())
        .find(|event| event["event"] == name)
}

fn failure_text(result: ExecutionFinalResult) -> String {
    format!("{:?}", result.into_result().expect_err("the call should have failed"))
}

#[tokio::test]
async fn a_deposit_through_ft_transfer_call_lands_in_the_reserve() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let result = s.deposit(5 * USDC_1).await?;
    assert!(result.is_success());
    let deposit = event(&result, "deposit").expect("a deposit event");
    assert_eq!(deposit["data"][0]["user"], s.alice.id().as_str());
    assert_eq!(deposit["data"][0]["amount"], "5000000");
    assert_eq!(s.reserve().await?, 35 * USDC_1);
    assert_eq!(s.balance(s.vault.id().as_str()).await?, 35 * USDC_1);
    assert_eq!(s.balance(s.alice.id().as_str()).await?, 65 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn a_token_not_on_the_list_goes_straight_back() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let other = s.worker.dev_deploy(token_wasm().await).await?;
    other.call("new").transact().await?.into_result()?;
    other.call("mint").args_json(json!({ "account_id": s.alice.id(), "amount": "1000000" })).transact().await?.into_result()?;
    other.call("mint").args_json(json!({ "account_id": s.vault.id(), "amount": "0" })).transact().await?.into_result()?;

    let outcome = s
        .alice
        .call(other.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.vault.id(), "amount": "1000000", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(format!("{:?}", outcome.receipt_failures()).contains("UNKNOWN_TOKEN"));
    assert_eq!(outcome.json::<String>()?, "0", "the vault must have used none of it");
    let kept: String = other.view("ft_balance_of").args_json(json!({ "account_id": s.alice.id() })).await?.json()?;
    assert_eq!(kept, "1000000", "the token's own refund must return everything");
    Ok(())
}

#[tokio::test]
async fn a_rescue_pays_the_quotes_fresh_deposit_address_and_says_so() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let (result, deposit) = s.rescue(3 * USDC_1).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let rescue = event(&result, "rescue").expect("a rescue event");
    assert!(result.json::<bool>()?, "rescue must resolve to true once the transfer lands");
    assert_eq!(s.balance(&deposit).await?, 3 * USDC_1);
    assert_eq!(s.reserve().await?, 27 * USDC_1);
    assert_eq!(
        rescue["data"][0],
        json!({
            "user": s.alice.id(),
            "token": s.usdc.id(),
            "amount": "3000000",
            "recipient": HL,
            "quote_id": "corr-1",
            "deposit_address": deposit,
        })
    );
    assert_eq!(s.rescues().await?[0]["refunded"], false);
    Ok(())
}

#[tokio::test]
async fn a_rescue_naming_the_attackers_address_fails_on_chain() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let quote = s.quote(&quote_signer(), 3 * USDC_1, ATTACKER_HL);
    let text = failure_text(s.rescue_with(&s.keeper, 3 * USDC_1, ATTACKER_HL, &quote.deposit, &quote).await?);
    assert!(text.contains("RECIPIENT_MISMATCH"), "{text}");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn a_genuine_quote_cant_be_redirected_to_the_attackers_account() -> anyhow::Result<()> {
    // The right recipient and a quote 1Click really signed, but the money pointed elsewhere.
    let s = Setup::new().await?;
    let attacker = s.worker.dev_create_account().await?;
    let quote = s.quote(&quote_signer(), 3 * USDC_1, HL);
    let text = failure_text(s.rescue_with(&s.keeper, 3 * USDC_1, HL, attacker.id().as_str(), &quote).await?);
    assert!(text.contains("BAD_QUOTE") && text.contains("deposit address"), "{text}");
    assert_eq!(s.balance(attacker.id().as_str()).await?, 0);
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn a_quote_the_keeper_wrote_itself_is_refused() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let forged = s.quote(&SigningKey::from_bytes(&[9u8; 32]), 3 * USDC_1, HL);
    let text = failure_text(s.rescue_with(&s.keeper, 3 * USDC_1, HL, &forged.deposit, &forged).await?);
    assert!(text.contains("1Click didn't sign this quote"), "{text}");
    assert_eq!(s.balance(&forged.deposit).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_named_keeper_can_rescue() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let stranger = s.worker.dev_create_account().await?;
    for caller in [&stranger, &s.alice] {
        let quote = s.quote(&quote_signer(), 3 * USDC_1, HL);
        let text = failure_text(s.rescue_with(caller, 3 * USDC_1, HL, &quote.deposit, &quote).await?);
        assert!(text.contains("NOT_KEEPER"), "{text}");
    }
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn a_failed_transfer_is_refunded_and_reported_as_false() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    s.usdc.call("set_fail_transfers").args_json(json!({ "fail": true })).transact().await?.into_result()?;

    let (result, _) = s.rescue(3 * USDC_1).await?;
    assert!(event(&result, "rescue_refunded").is_some());
    assert!(!result.json::<bool>()?, "a refunded rescue must resolve to false");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    assert_eq!(s.balance(s.vault.id().as_str()).await?, 30 * USDC_1);
    assert_eq!(s.rescues().await?[0]["refunded"], true);

    // Nothing moved, so the cooldown doesn't hold back a retry with a new quote.
    s.usdc.call("set_fail_transfers").args_json(json!({ "fail": false })).transact().await?.into_result()?;
    let (retry, deposit) = s.rescue(3 * USDC_1).await?;
    assert!(retry.json::<bool>()?);
    assert_eq!(s.balance(&deposit).await?, 3 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn nobody_can_call_the_refund_callback_to_inflate_a_reserve() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    s.rescue(3 * USDC_1).await?.0.into_result()?;
    for caller in [&s.keeper, &s.alice] {
        let result = caller
            .call(s.vault.id(), "on_rescue_transfer")
            .args_json(json!({ "user": s.alice.id(), "index": 0 }))
            .transact()
            .await?;
        let text = failure_text(result);
        assert!(text.contains("is private"), "{text}");
    }
    assert_eq!(s.reserve().await?, 27 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn withdraw_returns_the_reserve_to_the_user() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let result = s
        .alice
        .call(s.vault.id(), "withdraw")
        .args_json(json!({ "token": s.usdc.id(), "amount": (10 * USDC_1).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    let failures = format!("{:?}", result.failures());
    assert!(result.json::<bool>()?, "{failures}");
    assert_eq!(s.reserve().await?, 20 * USDC_1);
    assert_eq!(s.balance(s.alice.id().as_str()).await?, 80 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn the_keeper_cant_withdraw_and_nobody_can_set_the_vault_up_again() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let result = s
        .keeper
        .call(s.vault.id(), "withdraw")
        .args_json(json!({ "token": s.usdc.id(), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    let text = failure_text(result);
    assert!(text.contains("INSUFFICIENT_RESERVE"), "{text}");

    let attacker_key = SigningKey::from_bytes(&[9u8; 32]);
    let again = s
        .keeper
        .call(s.vault.id(), "new")
        .args_json(json!({ "tokens": [s.usdc.id()], "quote_signer": public_key(&attacker_key) }))
        .transact()
        .await?;
    assert!(again.is_failure(), "re-initialising must fail");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}
