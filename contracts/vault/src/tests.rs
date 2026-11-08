//! Unit tests: every rule, on a mocked chain. tests/sandbox.rs runs the real transfers.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::panic::{catch_unwind, AssertUnwindSafe};

const VAULT: &str = "vault.lifeline.near";
const USDC: &str = "usdc.near";
const WNEAR: &str = "wrap.near";
const KEEPER: &str = "keeper.lifeline.near";
const ALICE: &str = "alice.near";
const ATTACKER: &str = "attacker.near";
const HL: &str = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const OTHER_HL: &str = "0x9999999999999999999999999999999999999999";
/// An account the attacker controls, to send a rescue's money to.
const ATTACKER_DEPOSIT: &str = "ef0eeb5ba22b7da3ad34b9cf99c637dd4d81758b1d1e529125ab4f7240a16fbb";
/// 1Click's quote-signing key, from its SDK. Only the real-quote tests use it.
const ONE_CLICK_KEY: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const MAINNET_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_1: u128 = 1_000_000;
const MINUTE_NS: u64 = 60 * SEC_NS;
const START: u64 = 1_794_000_000 * SEC_NS;
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

/// Signs test quotes; the vault in these tests trusts it as it trusts 1Click on mainnet.
fn test_signer() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn test_signer_key() -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(test_signer().verifying_key().to_bytes()).into_string())
}

fn sign_with(key: &SigningKey, payload: &str) -> String {
    let signature = key.sign(quote::signed_message(payload).as_bytes());
    format!("ed25519:{}", near_sdk::bs58::encode(signature.to_bytes()).into_string())
}

fn sign(payload: &str) -> String {
    sign_with(&test_signer(), payload)
}

/// A fresh implicit account per quote, as 1Click hands out.
fn deposit_for(quote_id: &str) -> String {
    env::sha256_array(quote_id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// ms since the epoch as "2026-11-08T13:13:49.310Z".
fn iso(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// 1Click's flat fee for delivering to Hyperliquid, in 8-decimal units: 0.3153 USDC.
const WITHDRAW_FEE: u128 = 31_530_000;

/// What 1Click would sign for Alice's rescue, priced as 1Click prices it: the input in
/// 8 decimals, less the flat fee and a 1 bp fee, with a 1% slippage floor. Quoted 5 s before `now`.
fn quote_json(now: u64, token: &str, amount: u128, recipient: &str, deposit: &str) -> Value {
    let value = amount * 100;
    let amount_out = value.saturating_sub(WITHDRAW_FEE).saturating_sub(value / 10_000);
    json!({
        "amount": amount.to_string(),
        "amountIn": amount.to_string(),
        "amountOut": amount_out.to_string(),
        "withdrawFee": WITHDRAW_FEE.to_string(),
        "deadline": iso(now / 1_000_000 + 300_000),
        "depositAddress": deposit,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": quote::HYPERLIQUID_USDC,
        "dry": false,
        "minAmountOut": amount_out.saturating_sub(amount).to_string(),
        "originAsset": format!("nep141:{token}"),
        "recipient": recipient,
        "recipientType": "DESTINATION_CHAIN",
        "refundTo": ALICE,
        "refundType": "ORIGIN_CHAIN",
        "slippageTolerance": 100,
        "swapType": "EXACT_INPUT",
        "timestamp": iso(now / 1_000_000 - 5_000),
    })
}

fn context(who: &str, deposit: NearToken, now: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc(VAULT))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(10))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(100));
    builder
}

/// The mocked chain keeps its storage between testing_env! calls; this starts it empty.
fn fresh_chain() {
    testing_env!(context(VAULT, ZERO, START).build());
    near_sdk::mock::with_mocked_blockchain(|chain| drop(chain.take_storage()));
}

fn as_(who: &str, deposit: NearToken, now: u64) {
    testing_env!(context(who, deposit, now).build());
}

/// Runs a callback as the vault itself, with the transfer's result.
fn callback(result: PromiseResult, now: u64) {
    testing_env!(
        context(VAULT, ZERO, now).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn policy() -> PolicyInput {
    PolicyInput {
        hl_address: HL.into(),
        keeper: acc(KEEPER),
        warn: 1.8,
        trigger: 1.5,
        target: 2.0,
        max_per_rescue: U128(25 * USDC_1),
        max_per_day: U128(50 * USDC_1),
        cooldown_sec: 120,
    }
}

/// A vault with Alice registered under the default policy and `reserve` USDC deposited.
fn vault_with(reserve: u128) -> Vault {
    fresh_chain();
    let mut vault = Vault::new(vec![acc(USDC), acc(WNEAR)], test_signer_key());
    as_(ALICE, REGISTRATION_DEPOSIT, START);
    vault.set_policy(policy());
    if reserve > 0 {
        as_(USDC, ZERO, START);
        let _ = vault.ft_on_transfer(acc(ALICE), U128(reserve), String::new());
    }
    vault
}

fn rescue(vault: &mut Vault, now: u64, amount: u128, quote_id: &str) {
    rescue_with(vault, KEEPER, now, USDC, amount, HL, quote_id);
}

/// A rescue with an honest quote for exactly these arguments.
fn rescue_with(vault: &mut Vault, caller: &str, now: u64, token: &str, amount: u128, recipient: &str, quote_id: &str) {
    as_(caller, ZERO, now);
    let deposit = deposit_for(quote_id);
    let payload = quote_json(now, token, amount, recipient, &deposit).to_string();
    let signature = sign(&payload);
    let _ = vault.rescue(acc(ALICE), acc(token), U128(amount), acc(&deposit), recipient.into(), quote_id.into(), payload, signature);
}

/// A 3 USDC rescue to `deposit`, with whatever quote and signature the caller brings.
fn rescue_quoted(vault: &mut Vault, now: u64, deposit: &str, payload: &str, signature: &str) {
    as_(KEEPER, ZERO, now);
    let _ = vault.rescue(
        acc(ALICE),
        acc(USDC),
        U128(3 * USDC_1),
        acc(deposit),
        HL.into(),
        "corr-q".into(),
        payload.into(),
        signature.into(),
    );
}

/// The panic message of `work`, or None if it didn't panic.
fn refusal(work: impl FnOnce()) -> Option<String> {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let result = catch_unwind(AssertUnwindSafe(work));
    std::panic::set_hook(previous);
    result.err().map(|payload| {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    })
}

fn reserve(vault: &Vault) -> u128 {
    vault.get_reserve(acc(ALICE))[&acc(USDC)].0
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|json| near_sdk::serde_json::from_str(json).unwrap())
        .collect()
}

// Setup and policy

#[test]
fn lists_each_token_once() {
    as_(VAULT, ZERO, START);
    let vault = Vault::new(vec![acc(USDC), acc(WNEAR), acc(USDC)], test_signer_key());
    assert_eq!(vault.get_tokens(), vec![acc(USDC), acc(WNEAR)]);
}

#[test]
#[should_panic(expected = "attach 0.05 NEAR the first time")]
fn first_policy_needs_the_registration_deposit() {
    as_(VAULT, ZERO, START);
    let mut vault = Vault::new(vec![acc(USDC)], test_signer_key());
    as_(ALICE, NearToken::from_millinear(49), START);
    vault.set_policy(policy());
}

#[test]
#[should_panic(expected = "attach 1 yoctoNEAR: only a full-access key may change a policy")]
fn changing_a_policy_needs_a_full_access_key() {
    let mut vault = vault_with(0);
    as_(ALICE, ZERO, START);
    vault.set_policy(PolicyInput { hl_address: OTHER_HL.into(), ..policy() });
}

#[test]
fn stores_the_address_in_lower_case_and_keeps_the_pause() {
    let mut vault = vault_with(0);
    as_(ALICE, ZERO, START);
    vault.pause();
    as_(ALICE, NearToken::from_yoctonear(1), START);
    vault.set_policy(PolicyInput { trigger: 1.4, ..policy() });
    let saved = vault.get_policy(acc(ALICE)).unwrap();
    assert_eq!(saved.hl_address, HL.to_ascii_lowercase());
    assert_eq!(saved.trigger, 1.4);
    assert!(saved.paused, "setting a policy must not unpause");
    assert_eq!(saved.keeper, acc(KEEPER));
    assert_eq!(saved.max_per_rescue, U128(25 * USDC_1));
}

#[test]
fn refuses_every_policy_out_of_range() {
    let bad: Vec<(&str, PolicyInput)> = vec![
        ("hl_address", PolicyInput { hl_address: "0x1234".into(), ..policy() }),
        ("hl_address", PolicyInput { hl_address: format!("1x{}", &HL[2..]), ..policy() }),
        ("hl_address", PolicyInput { hl_address: format!("0x{}g", &HL[2..41]), ..policy() }),
        ("warn", PolicyInput { warn: 1.29, ..policy() }),
        ("warn", PolicyInput { warn: 3.01, ..policy() }),
        ("warn", PolicyInput { warn: f64::NAN, ..policy() }),
        ("trigger must be from", PolicyInput { trigger: 1.19, ..policy() }),
        ("trigger must be from", PolicyInput { warn: 3.0, trigger: 2.51, ..policy() }),
        ("trigger must be below warn", PolicyInput { warn: 1.5, trigger: 1.5, ..policy() }),
        ("target", PolicyInput { target: 1.5, ..policy() }),
        ("target", PolicyInput { target: 4.01, ..policy() }),
        ("target", PolicyInput { target: f64::INFINITY, ..policy() }),
        ("max_per_rescue", PolicyInput { max_per_rescue: U128(0), ..policy() }),
        ("max_per_day", PolicyInput { max_per_day: U128(24 * USDC_1), ..policy() }),
        ("cooldown_sec", PolicyInput { cooldown_sec: 29, ..policy() }),
        ("cooldown_sec", PolicyInput { cooldown_sec: 3_601, ..policy() }),
    ];
    for (field, input) in bad {
        fresh_chain();
        let mut vault = Vault::new(vec![acc(USDC)], test_signer_key());
        as_(ALICE, REGISTRATION_DEPOSIT, START);
        let message = refusal(|| vault.set_policy(input.clone())).unwrap_or_else(|| panic!("accepted {input:?}"));
        assert!(message.contains(field), "{input:?} was refused with {message:?}, expected {field}");
    }
}

#[test]
fn accepts_the_edges_of_every_range() {
    let edges = [
        PolicyInput { warn: 3.0, trigger: 2.5, target: 4.0, cooldown_sec: 3_600, ..policy() },
        PolicyInput { warn: 1.3, trigger: 1.2, target: 1.21, cooldown_sec: 30, ..policy() },
        PolicyInput { max_per_day: U128(25 * USDC_1), ..policy() },
    ];
    for input in edges {
        fresh_chain();
        let mut vault = Vault::new(vec![acc(USDC)], test_signer_key());
        as_(ALICE, REGISTRATION_DEPOSIT, START);
        vault.set_policy(input.clone());
        assert_eq!(vault.get_policy(acc(ALICE)).unwrap().warn, input.warn);
    }
}

#[test]
fn lists_users_once_each_in_sign_up_order() {
    let mut vault = vault_with(0);
    as_(ALICE, NearToken::from_yoctonear(1), START);
    vault.set_policy(policy());
    as_("bob.near", REGISTRATION_DEPOSIT, START);
    vault.set_policy(policy());
    assert_eq!(vault.get_users(None, None), vec![acc(ALICE), acc("bob.near")]);
    assert_eq!(vault.get_users(Some(1), Some(5)), vec![acc("bob.near")]);
    assert_eq!(vault.get_users(Some(5), None), Vec::<AccountId>::new());
}

#[test]
fn logs_policy_set() {
    as_(VAULT, ZERO, START);
    let mut vault = Vault::new(vec![acc(USDC)], test_signer_key());
    as_(ALICE, REGISTRATION_DEPOSIT, START);
    vault.set_policy(policy());
    let event = &events()[0];
    assert_eq!(event["standard"], "lifeline");
    assert_eq!(event["version"], "1.0.0");
    assert_eq!(event["event"], "policy_set");
    assert_eq!(event["data"][0]["user"], ALICE);
    assert_eq!(event["data"][0]["hl_address"], HL.to_ascii_lowercase());
    assert_eq!(event["data"][0]["keeper"], KEEPER);
}

// Deposits

#[test]
fn credits_a_deposit_and_logs_it() {
    let mut vault = vault_with(10 * USDC_1);
    as_(USDC, ZERO, START);
    let unused = vault.ft_on_transfer(acc(ALICE), U128(5 * USDC_1), String::new());
    assert!(matches!(unused, PromiseOrValue::Value(U128(0))));
    assert_eq!(reserve(&vault), 15 * USDC_1);
    let event = &events()[0];
    assert_eq!(event["event"], "deposit");
    assert_eq!(event["data"][0], json!({ "user": ALICE, "token": USDC, "amount": "5000000" }));
}

#[test]
#[should_panic(expected = "UNKNOWN_TOKEN")]
fn refuses_a_token_not_on_the_list() {
    let mut vault = vault_with(0);
    as_("fake-usdc.near", ZERO, START);
    let _ = vault.ft_on_transfer(acc(ALICE), U128(USDC_1), String::new());
}

#[test]
#[should_panic(expected = "NO_POLICY: set a policy before depositing")]
fn refuses_a_deposit_from_someone_without_a_policy() {
    let mut vault = vault_with(0);
    as_(USDC, ZERO, START);
    let _ = vault.ft_on_transfer(acc("bob.near"), U128(USDC_1), String::new());
}

// Rescue

#[test]
fn rescue_takes_the_reserve_and_records_it() {
    let mut vault = vault_with(30 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    assert_eq!(reserve(&vault), 27 * USDC_1);
    let rescues = vault.get_rescues(acc(ALICE), None, None);
    assert_eq!(
        rescues,
        vec![RescueView {
            token: acc(USDC),
            amount: U128(3 * USDC_1),
            at: U64(START),
            quote_id: "corr-1".into(),
            deposit_address: acc(&deposit_for("corr-1")),
            recipient: HL.to_ascii_lowercase(),
            refunded: false,
        }]
    );
}

#[test]
fn rescue_logs_every_field_an_auditor_needs() {
    let mut vault = vault_with(30 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    let event = &events()[0];
    assert_eq!(event["event"], "rescue");
    assert_eq!(
        event["data"][0],
        json!({
            "user": ALICE,
            "token": USDC,
            "amount": "3000000",
            "recipient": HL.to_ascii_lowercase(),
            "quote_id": "corr-1",
            "deposit_address": deposit_for("corr-1"),
            "quote_hash": quote::signed_message(&quote_json(START, USDC, 3 * USDC_1, HL, &deposit_for("corr-1")).to_string()),
        })
    );
}

#[test]
fn only_the_users_own_keeper_can_rescue() {
    for caller in [ATTACKER, ALICE, VAULT] {
        let mut vault = vault_with(30 * USDC_1);
        let message = refusal(|| rescue_with(&mut vault, caller, START, USDC, 3 * USDC_1, HL, "corr-1")).unwrap();
        assert!(message.contains("NOT_KEEPER"), "{caller}: {message}");
        assert_eq!(reserve(&vault), 30 * USDC_1);
    }
}

#[test]
#[should_panic(expected = "RECIPIENT_MISMATCH")]
fn refuses_a_recipient_that_isnt_the_users_address() {
    let mut vault = vault_with(30 * USDC_1);
    rescue_with(&mut vault, KEEPER, START, USDC, 3 * USDC_1, OTHER_HL, "corr-1");
}

#[test]
fn compares_the_recipient_in_lower_case() {
    let mut vault = vault_with(30 * USDC_1);
    rescue_with(&mut vault, KEEPER, START, USDC, 3 * USDC_1, &HL.to_ascii_uppercase().replace("0X", "0x"), "corr-1");
    assert_eq!(reserve(&vault), 27 * USDC_1);
}

#[test]
#[should_panic(expected = "OVER_PER_RESCUE")]
fn refuses_more_than_the_per_rescue_cap() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 25 * USDC_1 + 1, "corr-1");
}

#[test]
fn refuses_more_than_the_daily_cap() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 25 * USDC_1, "corr-1");
    rescue(&mut vault, START + 3 * MINUTE_NS, 25 * USDC_1, "corr-2");
    let message = refusal(|| rescue(&mut vault, START + 6 * MINUTE_NS, 2 * USDC_1, "corr-3")).unwrap();
    assert!(message.contains("OVER_DAILY"), "{message}");
    assert_eq!(reserve(&vault), 50 * USDC_1);
}

#[test]
fn the_daily_window_rolls_over() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 25 * USDC_1, "corr-1");
    rescue(&mut vault, START + 3 * MINUTE_NS, 25 * USDC_1, "corr-2");
    // 24 h after the first, only the second still counts.
    let message = refusal(|| rescue(&mut vault, START + DAY_NS - 1, 25 * USDC_1, "corr-3")).unwrap();
    assert!(message.contains("OVER_DAILY"), "{message}");
    rescue(&mut vault, START + DAY_NS, 25 * USDC_1, "corr-3");
    assert_eq!(reserve(&vault), 25 * USDC_1);
}

#[test]
fn enforces_the_cooldown() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    let message = refusal(|| rescue(&mut vault, START + 120 * SEC_NS - 1, 3 * USDC_1, "corr-2")).unwrap();
    assert!(message.contains("COOLDOWN"), "{message}");
    rescue(&mut vault, START + 120 * SEC_NS, 3 * USDC_1, "corr-2");
    assert_eq!(reserve(&vault), 94 * USDC_1);
}

#[test]
fn a_paused_user_cant_be_rescued_until_they_unpause() {
    let mut vault = vault_with(30 * USDC_1);
    as_(ALICE, ZERO, START);
    vault.pause();
    let message = refusal(|| rescue(&mut vault, START, 3 * USDC_1, "corr-1")).unwrap();
    assert!(message.contains("PAUSED"), "{message}");

    as_(ALICE, ZERO, START);
    let message = refusal(|| vault.unpause()).unwrap();
    assert!(message.contains("yocto"), "unpausing must need a full-access key: {message}");

    as_(ALICE, NearToken::from_yoctonear(1), START);
    vault.unpause();
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    assert_eq!(reserve(&vault), 27 * USDC_1);
}

#[test]
fn logs_pause_and_unpause() {
    let mut vault = vault_with(0);
    as_(ALICE, ZERO, START);
    vault.pause();
    assert_eq!(events()[0]["data"][0], json!({ "user": ALICE, "paused": true }));
    as_(ALICE, NearToken::from_yoctonear(1), START);
    vault.unpause();
    assert_eq!(events()[0]["data"][0], json!({ "user": ALICE, "paused": false }));
}

#[test]
#[should_panic(expected = "INSUFFICIENT_RESERVE")]
fn refuses_more_than_the_reserve_holds() {
    let mut vault = vault_with(2 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
}

#[test]
#[should_panic(expected = "UNKNOWN_TOKEN")]
fn refuses_to_rescue_with_a_token_not_on_the_list() {
    let mut vault = vault_with(30 * USDC_1);
    rescue_with(&mut vault, KEEPER, START, "fake-usdc.near", 3 * USDC_1, HL, "corr-1");
}

#[test]
fn refuses_a_reused_deposit_address_or_a_missing_quote_id() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    // The same quote again: same deposit address, so paying it twice is refused.
    let message = refusal(|| rescue(&mut vault, START + DAY_NS, 3 * USDC_1, "corr-1")).unwrap();
    assert!(message.contains("DEPOSIT_REUSED"), "{message}");
    let message = refusal(|| rescue(&mut vault, START + DAY_NS, 3 * USDC_1, "")).unwrap();
    assert!(message.contains("BAD_QUOTE_ID"), "{message}");
    let message = refusal(|| rescue(&mut vault, START + DAY_NS, 3 * USDC_1, &"x".repeat(129))).unwrap();
    assert!(message.contains("BAD_QUOTE_ID"), "{message}");
}

#[test]
#[should_panic(expected = "NO_POLICY")]
fn refuses_a_user_with_no_policy() {
    let mut vault = vault_with(0);
    as_(KEEPER, ZERO, START);
    let _ = vault.rescue(acc("bob.near"), acc(USDC), U128(USDC_1), acc(&deposit_for("corr-1")), HL.into(), "corr-1".into(), "{}".into(), "x".into());
}

#[test]
#[should_panic(expected = "attach at least 60 Tgas")]
fn refuses_too_little_gas_to_refund_a_failed_transfer() {
    let mut vault = vault_with(30 * USDC_1);
    let mut low = context(KEEPER, ZERO, START);
    low.prepaid_gas(Gas::from_tgas(59));
    testing_env!(low.build());
    let _ = vault.rescue(acc(ALICE), acc(USDC), U128(USDC_1), acc(&deposit_for("corr-1")), HL.into(), "corr-1".into(), "{}".into(), "x".into());
}

// The transfer's outcome

#[test]
fn a_transfer_that_lands_keeps_the_rescue() {
    let mut vault = vault_with(30 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    callback(PromiseResult::Successful(vec![]), START);
    assert!(vault.on_rescue_transfer(acc(ALICE), 0));
    assert_eq!(reserve(&vault), 27 * USDC_1);
    assert!(!vault.get_rescues(acc(ALICE), None, None)[0].refunded);
}

#[test]
fn a_failed_transfer_is_refunded_and_frees_the_limits() {
    let mut vault = vault_with(100 * USDC_1);
    rescue(&mut vault, START, 25 * USDC_1, "corr-1");
    callback(PromiseResult::Failed, START);
    assert!(!vault.on_rescue_transfer(acc(ALICE), 0));
    assert_eq!(reserve(&vault), 100 * USDC_1);
    assert!(vault.get_rescues(acc(ALICE), None, None)[0].refunded);
    assert_eq!(
        events()[0]["data"][0],
        json!({ "user": ALICE, "token": USDC, "amount": "25000000", "quote_id": "corr-1" })
    );
    assert_eq!(events()[0]["event"], "rescue_refunded");

    // No money moved, so neither the cooldown nor the daily cap holds the next one back.
    rescue(&mut vault, START + SEC_NS, 25 * USDC_1, "corr-2");
    rescue(&mut vault, START + 3 * MINUTE_NS, 25 * USDC_1, "corr-3");
    assert_eq!(reserve(&vault), 50 * USDC_1);
}

#[test]
#[should_panic(expected = "already refunded")]
fn a_rescue_can_only_be_refunded_once() {
    let mut vault = vault_with(30 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    callback(PromiseResult::Failed, START);
    vault.on_rescue_transfer(acc(ALICE), 0);
    callback(PromiseResult::Failed, START);
    vault.on_rescue_transfer(acc(ALICE), 0);
}

// Withdraw

#[test]
fn withdraw_takes_from_the_reserve_and_a_failed_transfer_puts_it_back() {
    let mut vault = vault_with(30 * USDC_1);
    as_(ALICE, NearToken::from_yoctonear(1), START);
    let _ = vault.withdraw(acc(USDC), U128(10 * USDC_1));
    assert_eq!(reserve(&vault), 20 * USDC_1);
    assert_eq!(events()[0]["data"][0], json!({ "user": ALICE, "token": USDC, "amount": "10000000" }));

    callback(PromiseResult::Failed, START);
    assert!(!vault.on_withdraw_transfer(acc(ALICE), acc(USDC), U128(10 * USDC_1)));
    assert_eq!(reserve(&vault), 30 * USDC_1);
    assert_eq!(events()[0]["event"], "withdraw_refunded");

    callback(PromiseResult::Successful(vec![]), START);
    assert!(vault.on_withdraw_transfer(acc(ALICE), acc(USDC), U128(10 * USDC_1)));
    assert_eq!(reserve(&vault), 30 * USDC_1);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_a_full_access_key() {
    let mut vault = vault_with(30 * USDC_1);
    as_(ALICE, ZERO, START);
    let _ = vault.withdraw(acc(USDC), U128(USDC_1));
}

#[test]
#[should_panic(expected = "INSUFFICIENT_RESERVE")]
fn withdraw_cant_take_more_than_the_reserve() {
    let mut vault = vault_with(30 * USDC_1);
    as_(ALICE, NearToken::from_yoctonear(1), START);
    let _ = vault.withdraw(acc(USDC), U128(30 * USDC_1 + 1));
}

#[test]
fn a_user_can_only_withdraw_their_own_reserve() {
    let mut vault = vault_with(30 * USDC_1);
    as_(ATTACKER, NearToken::from_yoctonear(1), START);
    let message = refusal(|| {
        let _ = vault.withdraw(acc(USDC), U128(USDC_1));
    })
    .unwrap();
    assert!(message.contains("INSUFFICIENT_RESERVE"), "{message}");
    assert_eq!(reserve(&vault), 30 * USDC_1);
}

// Views

#[test]
fn reports_every_listed_token_in_the_reserve() {
    let vault = vault_with(30 * USDC_1);
    let reserve = vault.get_reserve(acc(ALICE));
    assert_eq!(reserve.len(), 2);
    assert_eq!(reserve[&acc(USDC)], U128(30 * USDC_1));
    assert_eq!(reserve[&acc(WNEAR)], U128(0));
    assert_eq!(vault.get_reserve(acc("nobody.near"))[&acc(USDC)], U128(0));
}

#[test]
fn pages_through_rescues_oldest_first() {
    let mut vault = vault_with(100 * USDC_1);
    for i in 0..3u64 {
        rescue(&mut vault, START + i * 3 * MINUTE_NS, 2 * USDC_1, &format!("corr-{i}"));
    }
    let ids = |from, limit| -> Vec<String> {
        vault.get_rescues(acc(ALICE), from, limit).into_iter().map(|r| r.quote_id).collect()
    };
    assert_eq!(ids(None, None), ["corr-0", "corr-1", "corr-2"]);
    assert_eq!(ids(Some(1), Some(1)), ["corr-1"]);
    assert_eq!(ids(Some(3), None), Vec::<String>::new());
    assert_eq!(ids(None, Some(500)).len(), 3);
    assert!(vault.get_rescues(acc("nobody.near"), None, None).is_empty());
}

// The quote, checked on chain

/// The real non-dry quote 1Click signed on 2026-11-06, and the text it signed.
fn real_quote() -> (String, String, Value) {
    let fixture: Value = near_sdk::serde_json::from_str(include_str!("../tests/fixtures/quote-real.json")).unwrap();
    let payload = fixture["payload"].as_str().unwrap().to_string();
    let signature = fixture["signature"].as_str().unwrap().to_string();
    let fields: Value = near_sdk::serde_json::from_str(&payload).unwrap();
    (payload, signature, fields)
}

/// A mainnet-shaped vault trusting 1Click's real key, with the quote's refund account
/// (wrap.near) as the user and the quote's recipient as their Hyperliquid address.
fn real_quote_vault(fields: &Value) -> (Vault, u64) {
    fresh_chain();
    let mut vault = Vault::new(vec![acc(MAINNET_USDC)], ONE_CLICK_KEY.into());
    let user = fields["refundTo"].as_str().unwrap();
    as_(user, REGISTRATION_DEPOSIT, START);
    vault.set_policy(PolicyInput { hl_address: fields["recipient"].as_str().unwrap().into(), ..policy() });
    as_(MAINNET_USDC, ZERO, START);
    let _ = vault.ft_on_transfer(acc(user), U128(20 * USDC_1), String::new());
    let quoted_ms = quote::iso_to_ms(fields["timestamp"].as_str().unwrap()).unwrap();
    (vault, (quoted_ms + 5_000) * 1_000_000)
}

fn real_rescue(vault: &mut Vault, fields: &Value, now: u64, deposit: &str, payload: &str, signature: &str) {
    as_(KEEPER, ZERO, now);
    let _ = vault.rescue(
        acc(fields["refundTo"].as_str().unwrap()),
        acc(MAINNET_USDC),
        U128(5 * USDC_1),
        acc(deposit),
        fields["recipient"].as_str().unwrap().into(),
        "real".into(),
        payload.into(),
        signature.into(),
    );
}

#[test]
fn accepts_a_real_quote_signed_by_1click() {
    let (payload, signature, fields) = real_quote();
    let (mut vault, now) = real_quote_vault(&fields);
    real_rescue(&mut vault, &fields, now, fields["depositAddress"].as_str().unwrap(), &payload, &signature);
    let user = acc(fields["refundTo"].as_str().unwrap());
    assert_eq!(vault.get_reserve(user.clone())[&acc(MAINNET_USDC)], U128(15 * USDC_1));
    assert_eq!(vault.get_rescues(user, None, None)[0].deposit_address.as_str(), fields["depositAddress"].as_str().unwrap());
}

#[test]
fn a_hacked_keeper_cant_send_a_real_quote_to_its_own_address() {
    // The review's attack: the right recipient string, a genuine quote, and the attacker's address.
    let (payload, signature, fields) = real_quote();
    let (mut vault, now) = real_quote_vault(&fields);
    let message = refusal(|| real_rescue(&mut vault, &fields, now, ATTACKER_DEPOSIT, &payload, &signature)).unwrap();
    assert!(message.contains("BAD_QUOTE") && message.contains("deposit address"), "{message}");
}

#[test]
fn refuses_a_real_quote_edited_after_1click_signed_it() {
    let (payload, signature, fields) = real_quote();
    let (mut vault, now) = real_quote_vault(&fields);
    let edited = payload.replace(fields["depositAddress"].as_str().unwrap(), ATTACKER_DEPOSIT);
    let message = refusal(|| real_rescue(&mut vault, &fields, now, ATTACKER_DEPOSIT, &edited, &signature)).unwrap();
    assert!(message.contains("1Click didn't sign this quote"), "{message}");
}

#[test]
fn refuses_a_real_quote_more_than_two_minutes_old() {
    let (payload, signature, fields) = real_quote();
    let (mut vault, now) = real_quote_vault(&fields);
    let late = now + 120 * SEC_NS;
    let message = refusal(|| real_rescue(&mut vault, &fields, late, fields["depositAddress"].as_str().unwrap(), &payload, &signature)).unwrap();
    assert!(message.contains("more than 2 minutes old"), "{message}");
}

#[test]
fn refuses_a_quote_signed_by_anyone_but_the_quote_signer() {
    let mut vault = vault_with(30 * USDC_1);
    let deposit = deposit_for("forged");
    let payload = quote_json(START, USDC, 3 * USDC_1, HL, &deposit).to_string();
    let forged = sign_with(&SigningKey::from_bytes(&[9u8; 32]), &payload);
    for signature in [forged.as_str(), "", "ed25519:notbase58!", "ed25519:3"] {
        let message = refusal(|| rescue_quoted(&mut vault, START, &deposit, &payload, signature)).unwrap();
        assert!(message.contains("1Click didn't sign this quote"), "{signature}: {message}");
    }
    assert_eq!(reserve(&vault), 30 * USDC_1);
}

#[test]
fn refuses_a_quote_that_doesnt_fit_the_rescue() {
    let deposit = deposit_for("q");
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("dry run", Box::new(|q| q["dry"] = json!(true))),
        ("dry run", Box::new(|q| drop(q.as_object_mut().unwrap().remove("dry")))),
        ("destination chain", Box::new(|q| q["recipientType"] = json!("INTENTS"))),
        ("destination chain", Box::new(|q| q["swapType"] = json!("EXACT_OUTPUT"))),
        ("doesn't take this token", Box::new(|q| q["originAsset"] = json!("nep141:wrap.near"))),
        ("perps USDC", Box::new(|q| q["destinationAsset"] = json!("1cs_v1:hypercore:erc20:0x1"))),
        ("amount", Box::new(|q| q["amountIn"] = json!("2999999"))),
        ("amount", Box::new(|q| q["amount"] = json!("3000001"))),
        ("refund", Box::new(|q| q["refundTo"] = json!(ATTACKER))),
        ("someone other", Box::new(|q| q["recipient"] = json!(OTHER_HL))),
        ("deposit address", Box::new(|q| q["depositAddress"] = json!(ATTACKER_DEPOSIT))),
        ("slippage", Box::new(|q| q["slippageTolerance"] = json!(101))),
        ("slippage", Box::new(|q| drop(q.as_object_mut().unwrap().remove("slippageTolerance")))),
        ("time can't be read", Box::new(|q| q["timestamp"] = json!("yesterday"))),
        ("future", Box::new(|q| q["timestamp"] = json!(iso(START / 1_000_000 + 31_000)))),
        // An app fee isn't in the signed text, but it lowers amountOut, which is.
        ("delivers too little", Box::new(|q| q["amountOut"] = json!("255000000"))),
        ("slippage floor", Box::new(|q| q["minAmountOut"] = json!("200000000"))),
        ("flat fee", Box::new(|q| {
            q["withdrawFee"] = json!("100000001");
            q["amountOut"] = json!("199969999");
        })),
        ("amounts can't be read", Box::new(|q| q["amountOut"] = json!("lots"))),
        ("amounts can't be read", Box::new(|q| drop(q.as_object_mut().unwrap().remove("withdrawFee")))),
        ("refunds", Box::new(|q| q["refundType"] = json!("INTENTS"))),
        ("redirect", Box::new(|q| q["virtualChainRecipient"] = json!(ATTACKER))),
        ("redirect", Box::new(|q| q["virtualChainRefundRecipient"] = json!(ATTACKER))),
        ("redirect", Box::new(|q| q["customRecipientMsg"] = json!("send to attacker"))),
        ("redirect", Box::new(|q| q["depositMemo"] = json!("123"))),
    ];
    for (reason, change) in cases {
        let mut vault = vault_with(30 * USDC_1);
        let mut quote = quote_json(START, USDC, 3 * USDC_1, HL, &deposit);
        change(&mut quote);
        let payload = quote.to_string();
        let message = refusal(|| rescue_quoted(&mut vault, START, &deposit, &payload, &sign(&payload))).unwrap();
        assert!(message.contains("BAD_QUOTE") && message.contains(reason), "expected {reason}: {message}");
        assert_eq!(reserve(&vault), 30 * USDC_1);
    }
}

#[test]
fn refuses_a_rescue_so_small_the_flat_fee_eats_a_fifth_of_it() {
    let mut vault = vault_with(30 * USDC_1);
    let message = refusal(|| rescue(&mut vault, START, 1_500_000, "small")).unwrap();
    assert!(message.contains("BAD_QUOTE") && message.contains("a fifth"), "{message}");
    rescue(&mut vault, START, 2 * USDC_1, "big-enough");
    assert_eq!(reserve(&vault), 28 * USDC_1);
}

#[test]
fn logs_the_hash_of_the_signed_quote_so_auditors_can_match_it() {
    let mut vault = vault_with(30 * USDC_1);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    let deposit = deposit_for("corr-1");
    let payload = quote_json(START, USDC, 3 * USDC_1, HL, &deposit).to_string();
    assert_eq!(events()[0]["data"][0]["quote_hash"], quote::signed_message(&payload));
}

#[test]
fn refuses_a_quote_that_isnt_json() {
    let mut vault = vault_with(30 * USDC_1);
    let deposit = deposit_for("q");
    let message = refusal(|| rescue_quoted(&mut vault, START, &deposit, "not json", &sign("not json"))).unwrap();
    assert!(message.contains("isn't JSON"), "{message}");
}

#[test]
fn accepts_a_quote_a_little_ahead_of_block_time() {
    let mut vault = vault_with(30 * USDC_1);
    let deposit = deposit_for("q");
    let mut quote = quote_json(START, USDC, 3 * USDC_1, HL, &deposit);
    quote["timestamp"] = json!(iso(START / 1_000_000 + 29_000));
    let payload = quote.to_string();
    rescue_quoted(&mut vault, START, &deposit, &payload, &sign(&payload));
    assert_eq!(reserve(&vault), 27 * USDC_1);
}

#[test]
fn rescues_pay_in_the_first_token_only_so_the_caps_mean_one_thing() {
    let mut vault = vault_with(30 * USDC_1);
    as_(WNEAR, ZERO, START);
    let _ = vault.ft_on_transfer(acc(ALICE), U128(10u128.pow(24)), String::new());
    let message = refusal(|| rescue_with(&mut vault, KEEPER, START, WNEAR, 1, HL, "w")).unwrap();
    assert!(message.contains("UNKNOWN_TOKEN"), "{message}");
    assert_eq!(vault.get_reserve(acc(ALICE))[&acc(WNEAR)], U128(10u128.pow(24)));
}

#[test]
fn allows_at_most_200_rescues_in_24_hours() {
    fresh_chain();
    let mut vault = Vault::new(vec![acc(USDC)], test_signer_key());
    as_(ALICE, REGISTRATION_DEPOSIT, START);
    vault.set_policy(PolicyInput { max_per_rescue: U128(2 * USDC_1), max_per_day: U128(1_000 * USDC_1), cooldown_sec: 30, ..policy() });
    as_(USDC, ZERO, START);
    let _ = vault.ft_on_transfer(acc(ALICE), U128(1_000 * USDC_1), String::new());
    for i in 0..MAX_WINDOW_SCAN as u64 {
        rescue(&mut vault, START + i * 30 * SEC_NS, 2 * USDC_1, &format!("n{i}"));
    }
    assert_eq!(vault.get_rescue_count(acc(ALICE)), MAX_WINDOW_SCAN);
    let next = START + u64::from(MAX_WINDOW_SCAN) * 30 * SEC_NS;
    let message = refusal(|| rescue(&mut vault, next, 2 * USDC_1, "one-too-many")).unwrap();
    assert!(message.contains("too many rescues"), "{message}");
}

#[test]
fn shows_its_configuration_and_rescue_count() {
    let mut vault = vault_with(30 * USDC_1);
    assert_eq!(
        vault.get_config(),
        Config {
            tokens: vec![acc(USDC), acc(WNEAR)],
            rescue_token: acc(USDC),
            quote_signer: test_signer_key(),
            destination_asset: quote::HYPERLIQUID_USDC.into(),
            max_quote_age_sec: 120,
        }
    );
    assert_eq!(vault.get_rescue_count(acc(ALICE)), 0);
    rescue(&mut vault, START, 3 * USDC_1, "corr-1");
    assert_eq!(vault.get_rescue_count(acc(ALICE)), 1);
    assert_eq!(vault.get_rescue_count(acc("nobody.near")), 0);
}

#[test]
#[should_panic(expected = "quote_signer must be an ed25519 public key")]
fn refuses_a_signer_that_isnt_a_key() {
    fresh_chain();
    let _ = Vault::new(vec![acc(USDC)], "ed25519:short".into());
}

#[test]
fn reads_1click_timestamps() {
    assert_eq!(quote::iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0));
    assert_eq!(quote::iso_to_ms("2026-11-06T08:14:28.581Z"), Some(1_793_952_868_581));
    assert_eq!(quote::iso_to_ms("2026-11-06T08:14:28Z"), Some(1_793_952_868_000));
    assert_eq!(quote::iso_to_ms("2026-11-06T08:14:28.5Z"), Some(1_793_952_868_500));
    assert_eq!(quote::iso_to_ms("2024-02-29T12:00:00.000Z"), Some(1_709_208_000_000));
    for bad in ["2026-11-06 08:14:28Z", "2026-13-06T08:14:28Z", "2026-11-06T08:14:28.581", "2026-11-06T08:14:28.Z", "soon"] {
        assert_eq!(quote::iso_to_ms(bad), None, "{bad}");
    }
    assert_eq!(iso(1_793_952_868_581), "2026-11-06T08:14:28.581Z");
}
