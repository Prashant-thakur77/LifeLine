//! The vault on a local NEAR sandbox node, with a real NEP-141 token: deposits through
//! ft_transfer_call, rescues to a fresh 1Click-style deposit address, refunds of a
//! failed transfer, and withdrawals. src/tests.rs covers each rule on its own.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

const USDC_1: u128 = 1_000_000;
const HL: &str = "0xabcdef0123456789abcdef0123456789abcdef01";
const ATTACKER_HL: &str = "0x9999999999999999999999999999999999999999";
/// A real 1Click deposit address from a mainnet quote: a fresh implicit account.
const DEPOSIT_ADDRESS: &str = "ef0eeb5ba22b7da3ad34b9cf99c637dd4d81758b1d1e529125ab4f7240a16fbb";

static VAULT_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static TOKEN_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn vault_wasm() -> &'static [u8] {
    VAULT_WASM.get_or_init(|| async { near_workspaces::compile_project("./").await.expect("vault builds") }).await
}

async fn token_wasm() -> &'static [u8] {
    TOKEN_WASM
        .get_or_init(|| async { near_workspaces::compile_project("./tests/mock-ft").await.expect("mock token builds") })
        .await
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
        vault.call("new").args_json(json!({ "tokens": [usdc.id()] })).transact().await?.into_result()?;
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

    async fn rescue(&self, caller: &Account, amount: u128, recipient: &str, quote_id: &str) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.vault.id(), "rescue")
            .args_json(json!({
                "user": self.alice.id(),
                "token": self.usdc.id(),
                "amount": amount.to_string(),
                "deposit_address": DEPOSIT_ADDRESS,
                "recipient": recipient,
                "quote_id": quote_id,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
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
async fn a_rescue_pays_a_fresh_deposit_address_and_says_so() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let result = s.rescue(&s.keeper, 3 * USDC_1, HL, "corr-1").await?;
    assert!(result.is_success(), "{:?}", result.failures());
    let rescue = event(&result, "rescue").expect("a rescue event");
    assert!(result.json::<bool>()?, "rescue must resolve to true once the transfer lands");
    assert_eq!(s.balance(DEPOSIT_ADDRESS).await?, 3 * USDC_1);
    assert_eq!(s.reserve().await?, 27 * USDC_1);

    assert_eq!(
        rescue["data"][0],
        json!({
            "user": s.alice.id(),
            "token": s.usdc.id(),
            "amount": "3000000",
            "recipient": HL,
            "quote_id": "corr-1",
            "deposit_address": DEPOSIT_ADDRESS,
        })
    );
    assert_eq!(s.rescues().await?[0]["refunded"], false);
    Ok(())
}

#[tokio::test]
async fn a_rescue_to_the_attackers_address_fails_on_chain() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let result = s.rescue(&s.keeper, 3 * USDC_1, ATTACKER_HL, "corr-1").await?;
    let text = failure_text(result);
    assert!(text.contains("RECIPIENT_MISMATCH"), "{text}");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    assert_eq!(s.balance(DEPOSIT_ADDRESS).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_named_keeper_can_rescue() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    let stranger = s.worker.dev_create_account().await?;
    let text = failure_text(s.rescue(&stranger, 3 * USDC_1, HL, "corr-1").await?);
    assert!(text.contains("NOT_KEEPER"), "{text}");
    let text = failure_text(s.rescue(&s.alice, 3 * USDC_1, HL, "corr-1").await?);
    assert!(text.contains("NOT_KEEPER"), "{text}");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn a_failed_transfer_is_refunded_and_reported_as_false() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    s.usdc.call("set_fail_transfers").args_json(json!({ "fail": true })).transact().await?.into_result()?;

    let result = s.rescue(&s.keeper, 3 * USDC_1, HL, "corr-1").await?;
    assert!(event(&result, "rescue_refunded").is_some());
    assert!(!result.json::<bool>()?, "a refunded rescue must resolve to false");
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    assert_eq!(s.balance(s.vault.id().as_str()).await?, 30 * USDC_1);
    assert_eq!(s.rescues().await?[0]["refunded"], true);

    // Nothing moved, so the cooldown doesn't hold the retry back.
    s.usdc.call("set_fail_transfers").args_json(json!({ "fail": false })).transact().await?.into_result()?;
    let retry = s.rescue(&s.keeper, 3 * USDC_1, HL, "corr-2").await?;
    assert!(retry.json::<bool>()?);
    assert_eq!(s.balance(DEPOSIT_ADDRESS).await?, 3 * USDC_1);
    Ok(())
}

#[tokio::test]
async fn nobody_can_call_the_refund_callback_to_inflate_a_reserve() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    s.rescue(&s.keeper, 3 * USDC_1, HL, "corr-1").await?.into_result()?;
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
async fn a_keeper_key_limited_to_rescue_cant_withdraw() -> anyhow::Result<()> {
    let s = Setup::new().await?;
    // The keeper has no reserve of its own, and withdraw only ever pays the caller.
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
    assert_eq!(s.reserve().await?, 30 * USDC_1);
    Ok(())
}
