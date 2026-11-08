//! Lifeline's reserve vault. README.md describes every method.
//!
//! Each user keeps a reserve here and names one keeper. That keeper can move reserve
//! funds only through `rescue`, which checks every limit that protects the money: the
//! recipient, the caps, the cooldown and the pause. The keeper's own policy engine runs
//! the same checks first, and this contract doesn't rely on it having done so.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

/// Paid once, by a user's first `set_policy`, for the storage their account takes.
pub const REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(50);
/// USDC's `storage_balance_bounds` on mainnet. A token refunds it if the account is already registered.
pub const TOKEN_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

pub const WARN_RANGE: (f64, f64) = (1.3, 3.0);
pub const TRIGGER_RANGE: (f64, f64) = (1.2, 2.5);
pub const TARGET_MAX: f64 = 4.0;
pub const COOLDOWN_RANGE: (u32, u32) = (30, 3_600);

const SEC_NS: u64 = 1_000_000_000;
const DAY_NS: u64 = 24 * 60 * 60 * SEC_NS;
/// The most rescues the 24-hour check reads. More than this in a day is refused, not skipped.
pub const MAX_WINDOW_SCAN: u32 = 200;
pub const MAX_PAGE: u32 = 100;
const MAX_QUOTE_ID_LEN: usize = 128;

const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// Enough for the three receipts a rescue makes plus its own work, so a failed
/// transfer always has the gas to be refunded. The keeper sends 100 Tgas.
pub const MIN_RESCUE_GAS: Gas = Gas::from_tgas(60);
const MIN_WITHDRAW_GAS: Gas = Gas::from_tgas(40);

#[ext_contract(ext_token)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Reserves,
    Rescues,
    UsedQuotes,
    Users,
}

/// What a user signs. `get_policy` returns the same fields plus `paused`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PolicyInput {
    pub hl_address: String,
    pub keeper: AccountId,
    pub warn: f64,
    pub trigger: f64,
    pub target: f64,
    pub max_per_rescue: U128,
    pub max_per_day: U128,
    pub cooldown_sec: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PolicyView {
    pub hl_address: String,
    pub keeper: AccountId,
    pub warn: f64,
    pub trigger: f64,
    pub target: f64,
    pub max_per_rescue: U128,
    pub max_per_day: U128,
    pub cooldown_sec: u32,
    pub paused: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RescueView {
    pub token: AccountId,
    pub amount: U128,
    /// Block time in nanoseconds.
    pub at: U64,
    pub quote_id: String,
    pub deposit_address: AccountId,
    pub recipient: String,
    /// The transfer failed and the amount went back to the reserve.
    pub refunded: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct StoredPolicy {
    hl_address: String,
    keeper: AccountId,
    warn: f64,
    trigger: f64,
    target: f64,
    max_per_rescue: u128,
    max_per_day: u128,
    cooldown_sec: u32,
}

#[near(serializers = [borsh])]
struct UserAccount {
    policy: StoredPolicy,
    paused: bool,
    rescue_count: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Rescue {
    token: AccountId,
    amount: u128,
    at: u64,
    quote_id: String,
    deposit_address: AccountId,
    recipient: String,
    refunded: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    tokens: Vec<AccountId>,
    accounts: LookupMap<AccountId, UserAccount>,
    reserves: LookupMap<(AccountId, AccountId), u128>,
    rescues: LookupMap<(AccountId, u32), Rescue>,
    used_quotes: LookupSet<(AccountId, String)>,
    users: Vector<AccountId>,
}

#[near]
impl Vault {
    #[init]
    pub fn new(tokens: Vec<AccountId>) -> Self {
        require!(!tokens.is_empty(), "the token list is empty");
        let mut unique: Vec<AccountId> = Vec::with_capacity(tokens.len());
        for token in tokens {
            if !unique.contains(&token) {
                unique.push(token);
            }
        }
        Self {
            tokens: unique,
            accounts: LookupMap::new(StorageKey::Accounts),
            reserves: LookupMap::new(StorageKey::Reserves),
            rescues: LookupMap::new(StorageKey::Rescues),
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
            users: Vector::new(StorageKey::Users),
        }
    }

    /// Saves the caller's policy. The first call registers them and needs 0.05 NEAR for
    /// storage. Later calls need 1 yoctoNEAR, so only a full-access key can change where
    /// rescues go. Anything attached beyond that is returned.
    #[payable]
    pub fn set_policy(&mut self, policy: PolicyInput) {
        let user = env::predecessor_account_id();
        let stored = validate(policy);
        let attached = env::attached_deposit();
        let registered = self.accounts.contains_key(&user);
        let needed = if registered { ONE_YOCTO } else { REGISTRATION_DEPOSIT };
        require!(
            attached >= needed,
            if registered {
                "attach 1 yoctoNEAR: only a full-access key may change a policy"
            } else {
                "attach 0.05 NEAR the first time, for your storage in the vault"
            }
        );

        emit(
            "policy_set",
            json!({ "user": user, "hl_address": stored.hl_address, "keeper": stored.keeper }),
        );
        match self.accounts.get_mut(&user) {
            Some(account) => account.policy = stored,
            None => {
                self.accounts.insert(user.clone(), UserAccount { policy: stored, paused: false, rescue_count: 0 });
                self.users.push(user.clone());
            }
        }

        let excess = attached.saturating_sub(needed);
        if !excess.is_zero() {
            Promise::new(user).transfer(excess).detach();
        }
    }

    /// Stops rescues at once. Needs no deposit, so any of the user's keys can do it.
    pub fn pause(&mut self) {
        self.set_paused(true);
    }

    #[payable]
    pub fn unpause(&mut self) {
        near_sdk::assert_one_yocto();
        self.set_paused(false);
    }

    /// Credits a deposit made with `ft_transfer_call` to the sender's reserve.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        require!(self.tokens.contains(&token), "UNKNOWN_TOKEN: this vault doesn't hold that token");
        require!(self.accounts.contains_key(&sender_id), "NO_POLICY: set a policy before depositing");
        require!(amount.0 > 0, "the amount must be above 0");

        let key = (sender_id.clone(), token.clone());
        let balance = self.reserve_of(&key);
        let credited = balance.checked_add(amount.0).unwrap_or_else(|| env::panic_str("the reserve would overflow"));
        self.reserves.insert(key, credited);
        emit("deposit", json!({ "user": sender_id, "token": token, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// Returns reserve funds to the user's own account. Restored if the transfer fails.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        require!(env::prepaid_gas() >= MIN_WITHDRAW_GAS, "attach at least 40 Tgas");
        let user = env::predecessor_account_id();
        require!(amount.0 > 0, "the amount must be above 0");
        let key = (user.clone(), token.clone());
        let balance = self.reserve_of(&key);
        require!(balance >= amount.0, "INSUFFICIENT_RESERVE: the reserve holds less than that");

        self.reserves.insert(key, balance - amount.0);
        emit("withdraw", json!({ "user": user, "token": token, "amount": amount }));
        ext_token::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(user.clone(), amount, Some("Lifeline withdrawal".to_string()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw_transfer(user, token, amount))
    }

    /// Sends `amount` of the user's reserve to a 1Click deposit address, if every rule holds.
    /// Resolves to `true` once the transfer lands, or `false` if it failed and was refunded.
    pub fn rescue(
        &mut self,
        user: AccountId,
        token: AccountId,
        amount: U128,
        deposit_address: AccountId,
        recipient: String,
        quote_id: String,
    ) -> Promise {
        require!(env::prepaid_gas() >= MIN_RESCUE_GAS, "attach at least 60 Tgas, so a failed transfer can be refunded");
        let (policy, paused, count) = match self.accounts.get(&user) {
            Some(account) => (account.policy.clone(), account.paused, account.rescue_count),
            None => env::panic_str("NO_POLICY: this user has no policy"),
        };
        require!(env::predecessor_account_id() == policy.keeper, "NOT_KEEPER: only the keeper this user chose can rescue");
        require!(!paused, "PAUSED: this user has paused rescues");
        require!(self.tokens.contains(&token), "UNKNOWN_TOKEN: this vault doesn't hold that token");
        require!(
            recipient.to_ascii_lowercase() == policy.hl_address,
            "RECIPIENT_MISMATCH: the recipient isn't this user's Hyperliquid address"
        );
        require!(amount.0 > 0, "the amount must be above 0");
        require!(amount.0 <= policy.max_per_rescue, "OVER_PER_RESCUE: over this user's limit per rescue");
        require!(
            !quote_id.is_empty() && quote_id.len() <= MAX_QUOTE_ID_LEN,
            "BAD_QUOTE_ID: the quote id must be 1 to 128 characters"
        );
        let quote_key = (user.clone(), quote_id.clone());
        require!(!self.used_quotes.contains(&quote_key), "QUOTE_REUSED: this quote was already used for this user");

        let now = env::block_timestamp();
        let (spent, last_at) = self.window(&user, count, now);
        let total = spent.checked_add(amount.0).unwrap_or(u128::MAX);
        require!(total <= policy.max_per_day, "OVER_DAILY: over this user's limit per 24 hours");
        if let Some(last) = last_at {
            require!(
                now.saturating_sub(last) >= u64::from(policy.cooldown_sec) * SEC_NS,
                "COOLDOWN: the last rescue was too recent"
            );
        }
        let reserve_key = (user.clone(), token.clone());
        let balance = self.reserve_of(&reserve_key);
        require!(balance >= amount.0, "INSUFFICIENT_RESERVE: the reserve holds less than that");

        // Every change happens before the transfer is sent; the callback undoes them if it fails.
        self.reserves.insert(reserve_key, balance - amount.0);
        self.rescues.insert(
            (user.clone(), count),
            Rescue {
                token: token.clone(),
                amount: amount.0,
                at: now,
                quote_id: quote_id.clone(),
                deposit_address: deposit_address.clone(),
                recipient: policy.hl_address.clone(),
                refunded: false,
            },
        );
        if let Some(account) = self.accounts.get_mut(&user) {
            account.rescue_count = count + 1;
        }
        self.used_quotes.insert(quote_key);
        emit(
            "rescue",
            json!({
                "user": user,
                "token": token,
                "amount": amount,
                "recipient": policy.hl_address,
                "quote_id": quote_id,
                "deposit_address": deposit_address,
            }),
        );

        // A 1Click deposit address is a fresh account the token doesn't know yet, and a
        // transfer to an unregistered account fails. Registering an account that already
        // exists costs nothing: the token refunds the deposit.
        ext_token::ext(token.clone())
            .with_attached_deposit(TOKEN_STORAGE_DEPOSIT)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(deposit_address.clone()), Some(true))
            .then(
                ext_token::ext(token)
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(deposit_address, amount, Some(format!("Lifeline rescue {quote_id}"))),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_rescue_transfer(user, count))
    }

    #[private]
    pub fn on_rescue_transfer(&mut self, user: AccountId, index: u32) -> bool {
        if transfer_succeeded() {
            return true;
        }
        let key = (user.clone(), index);
        let Some(rescue) = self.rescues.get_mut(&key) else {
            env::panic_str("unknown rescue");
        };
        require!(!rescue.refunded, "this rescue was already refunded");
        rescue.refunded = true;
        let (token, amount, quote_id) = (rescue.token.clone(), rescue.amount, rescue.quote_id.clone());
        let reserve_key = (user.clone(), token.clone());
        let balance = self.reserve_of(&reserve_key);
        self.reserves.insert(reserve_key, balance.saturating_add(amount));
        emit(
            "rescue_refunded",
            json!({ "user": user, "token": token, "amount": U128(amount), "quote_id": quote_id }),
        );
        false
    }

    #[private]
    pub fn on_withdraw_transfer(&mut self, user: AccountId, token: AccountId, amount: U128) -> bool {
        if transfer_succeeded() {
            return true;
        }
        let key = (user.clone(), token.clone());
        let balance = self.reserve_of(&key);
        self.reserves.insert(key, balance.saturating_add(amount.0));
        emit("withdraw_refunded", json!({ "user": user, "token": token, "amount": amount }));
        false
    }

    pub fn get_policy(&self, user: AccountId) -> Option<PolicyView> {
        self.accounts.get(&user).map(|account| {
            let p = &account.policy;
            PolicyView {
                hl_address: p.hl_address.clone(),
                keeper: p.keeper.clone(),
                warn: p.warn,
                trigger: p.trigger,
                target: p.target,
                max_per_rescue: U128(p.max_per_rescue),
                max_per_day: U128(p.max_per_day),
                cooldown_sec: p.cooldown_sec,
                paused: account.paused,
            }
        })
    }

    /// Every token in the list, with what the user holds of it.
    pub fn get_reserve(&self, user: AccountId) -> BTreeMap<AccountId, U128> {
        self.tokens
            .iter()
            .map(|token| (token.clone(), U128(self.reserve_of(&(user.clone(), token.clone())))))
            .collect()
    }

    /// The user's rescues, oldest first.
    pub fn get_rescues(&self, user: AccountId, from: Option<u32>, limit: Option<u32>) -> Vec<RescueView> {
        let count = self.accounts.get(&user).map_or(0, |account| account.rescue_count);
        let from = from.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)).min(count);
        (from..end)
            .filter_map(|index| self.rescues.get(&(user.clone(), index)))
            .map(|r| RescueView {
                token: r.token.clone(),
                amount: U128(r.amount),
                at: U64(r.at),
                quote_id: r.quote_id.clone(),
                deposit_address: r.deposit_address.clone(),
                recipient: r.recipient.clone(),
                refunded: r.refunded,
            })
            .collect()
    }

    /// Every registered user, in sign-up order, so a keeper can find who to watch.
    pub fn get_users(&self, from: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        let from = from.unwrap_or(0);
        let end = from.saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)).min(self.users.len());
        (from..end).filter_map(|index| self.users.get(index).cloned()).collect()
    }

    pub fn get_tokens(&self) -> Vec<AccountId> {
        self.tokens.clone()
    }
}

impl Vault {
    fn reserve_of(&self, key: &(AccountId, AccountId)) -> u128 {
        self.reserves.get(key).copied().unwrap_or(0)
    }

    fn set_paused(&mut self, paused: bool) {
        let user = env::predecessor_account_id();
        let Some(account) = self.accounts.get_mut(&user) else {
            env::panic_str("NO_POLICY: you have no policy");
        };
        account.paused = paused;
        emit("paused", json!({ "user": user, "paused": paused }));
    }

    /// What the user's rescues of the last 24 hours add up to, and when the latest was.
    /// Refunded rescues moved no money, so they count for neither.
    fn window(&self, user: &AccountId, count: u32, now: u64) -> (u128, Option<u64>) {
        let mut spent: u128 = 0;
        let mut last_at = None;
        let mut scanned = 0;
        for index in (0..count).rev() {
            let Some(rescue) = self.rescues.get(&(user.clone(), index)) else {
                env::panic_str("a rescue record is missing");
            };
            if now.saturating_sub(rescue.at) >= DAY_NS {
                break;
            }
            scanned += 1;
            require!(scanned <= MAX_WINDOW_SCAN, "OVER_DAILY: too many rescues in the last 24 hours");
            if !rescue.refunded {
                spent = spent.saturating_add(rescue.amount);
                last_at = last_at.or(Some(rescue.at));
            }
        }
        (spent, last_at)
    }
}

fn validate(policy: PolicyInput) -> StoredPolicy {
    let hl_address = policy.hl_address.to_ascii_lowercase();
    require!(is_hl_address(&hl_address), "hl_address must be 0x and 40 hex characters");
    require!(in_range(policy.warn, WARN_RANGE), "warn must be from 1.3 to 3.0");
    require!(in_range(policy.trigger, TRIGGER_RANGE), "trigger must be from 1.2 to 2.5");
    require!(policy.trigger < policy.warn, "trigger must be below warn");
    require!(
        policy.target.is_finite() && policy.target > policy.trigger && policy.target <= TARGET_MAX,
        "target must be above trigger and at most 4.0"
    );
    require!(policy.max_per_rescue.0 > 0, "max_per_rescue must be above 0");
    require!(policy.max_per_day.0 >= policy.max_per_rescue.0, "max_per_day must be at least max_per_rescue");
    require!(
        (COOLDOWN_RANGE.0..=COOLDOWN_RANGE.1).contains(&policy.cooldown_sec),
        "cooldown_sec must be from 30 to 3600"
    );
    StoredPolicy {
        hl_address,
        keeper: policy.keeper,
        warn: policy.warn,
        trigger: policy.trigger,
        target: policy.target,
        max_per_rescue: policy.max_per_rescue.0,
        max_per_day: policy.max_per_day.0,
        cooldown_sec: policy.cooldown_sec,
    }
}

fn in_range(value: f64, (min, max): (f64, f64)) -> bool {
    value.is_finite() && value >= min && value <= max
}

fn is_hl_address(value: &str) -> bool {
    value.len() == 42 && value.starts_with("0x") && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/** Whether the one promise this callback waited on succeeded. Its return value isn't needed. */
fn transfer_succeeded() -> bool {
    env::promise_results_count() == 1
        && matches!(env::promise_result_checked(0, 64), Ok(_) | Err(PromiseError::TooLong(_)))
}

/// A NEP-297 event: `EVENT_JSON:{"standard":"lifeline","version":"1.0.0","event":…,"data":[…]}`.
fn emit(event: &str, data: Value) {
    let body = json!({ "standard": "lifeline", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}
