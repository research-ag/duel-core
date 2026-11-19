// The logged-in principal's cycle wallet: its account on the cycles
// ledger (an ICRC-1 ledger of cycles, token TCYCLES), funded from
// outside (`icp cycles transfer`, any wallet holding TCYCLES). The page
// reads its balance and calls the ledger's `withdraw`, which deposits
// cycles into any canister, with the login's own identity; nothing goes
// through this dashboard's backend.

import { useSyncExternalStore } from "react";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import type { Identity } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

import { exactTC, formatTC } from "./cycles";
import { deriveHost } from "./ic-env";

export const CYCLES_LEDGER = "um5iw-rqaaa-aaaaq-qaaba-cai";

/// The ledger's `icrc1_fee`, paid by the wallet on every withdrawal.
export const LEDGER_FEE = 100_000_000n;

const ledgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const RejectionCode = IDL.Variant({
    NoError: IDL.Null,
    CanisterError: IDL.Null,
    SysTransient: IDL.Null,
    DestinationInvalid: IDL.Null,
    Unknown: IDL.Null,
    SysFatal: IDL.Null,
    CanisterReject: IDL.Null,
  });
  const WithdrawError = IDL.Variant({
    FailedToWithdraw: IDL.Record({
      rejection_code: RejectionCode,
      fee_block: IDL.Opt(IDL.Nat),
      rejection_reason: IDL.Text,
    }),
    GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    InvalidReceiver: IDL.Record({ receiver: IDL.Principal }),
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TooOld: IDL.Null,
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ["query"]),
    withdraw: IDL.Func(
      [
        IDL.Record({
          to: IDL.Principal,
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
          amount: IDL.Nat,
        }),
      ],
      [IDL.Variant({ Ok: IDL.Nat, Err: WithdrawError })],
      []
    ),
  });
};

type WithdrawError =
  | {
      FailedToWithdraw: {
        fee_block: [] | [bigint];
        rejection_reason: string;
      };
    }
  | { GenericError: { message: string } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint } }
  | { BadFee: { expected_fee: bigint } }
  | { InvalidReceiver: { receiver: Principal } }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TooOld: null }
  | { InsufficientFunds: { balance: bigint } };

interface Ledger {
  icrc1_balance_of(account: {
    owner: Principal;
    subaccount: [];
  }): Promise<bigint>;
  withdraw(args: {
    to: Principal;
    from_subaccount: [];
    created_at_time: [bigint];
    amount: bigint;
  }): Promise<{ Ok: bigint } | { Err: WithdrawError }>;
}

export interface Wallet {
  principal: Principal;
  /// `undefined` while the first read runs, `null` when the ledger
  /// could not be read.
  balance: bigint | null | undefined;
}

let ledger: Ledger | undefined;
let wallet: Wallet | undefined;
/// Numbers the balance reads; only the latest one publishes.
let latestRead = 0;
/// Set while a withdrawal waits for the ledger; sends run one at a time.
let sending = false;
/// A withdrawal whose call threw, so it may or may not have happened.
/// Its resend repeats the exact arguments, which the ledger either
/// executes or answers with `Duplicate`; no other send goes out before.
let unanswered: { to: Principal; amount: bigint; createdAt: bigint } | undefined;

/// Whether sending `amount` to `to` resends the unanswered withdrawal,
/// which skips the balance check: the wallet may already have paid it.
export function isResend(to: Principal, amount: bigint): boolean {
  return (
    unanswered !== undefined &&
    unanswered.to.toText() === to.toText() &&
    unanswered.amount === amount
  );
}
const listeners = new Set<() => void>();

function set(next: Wallet) {
  wallet = next;
  for (const l of listeners) l();
}

/// Opens the wallet of a resolved login and reads its balance.
export async function connectWallet(identity: Identity): Promise<void> {
  if (wallet?.principal.toText() !== identity.getPrincipal().toText())
    unanswered = undefined;
  const agent = await HttpAgent.create({
    host: deriveHost(),
    identity,
    rootKey: safeGetCanisterEnv()?.IC_ROOT_KEY,
  });
  ledger = Actor.createActor(ledgerIdl, {
    agent,
    canisterId: CYCLES_LEDGER,
  }) as unknown as Ledger;
  set({ principal: identity.getPrincipal(), balance: undefined });
  await refreshWallet();
}

/// Re-reads the balance; a failed read keeps a known one, and a read
/// overtaken by a later one publishes nothing.
export async function refreshWallet(): Promise<void> {
  if (!ledger || !wallet) return;
  const read = ++latestRead;
  const { principal } = wallet;
  const balance = await ledger
    .icrc1_balance_of({ owner: principal, subaccount: [] })
    .catch(() => undefined);
  if (read !== latestRead || !wallet) return;
  set({ principal, balance: balance ?? wallet.balance ?? null });
}

/// Sends `amount` cycles to canister `to`; the wallet pays `amount` plus
/// `LEDGER_FEE`. Resolves with the ledger's block index; rejects with a
/// message for the page. `created_at_time` lets the ledger refuse the
/// same withdrawal twice, so an unanswered one is repeated as it was
/// before any other is sent.
export async function sendCycles(to: Principal, amount: bigint): Promise<bigint> {
  if (!ledger) throw new Error("Log in to use your wallet.");
  if (sending)
    throw new Error("Another send is still waiting for the ledger's answer.");
  if (unanswered && !isResend(to, amount))
    throw new Error(
      `Your send of ${exactTC(unanswered.amount)} to ${unanswered.to.toText()} got no answer and may have gone through. Send that again first: the ledger will not take it twice.`
    );
  const tx = unanswered ?? {
    to,
    amount,
    createdAt: BigInt(Date.now()) * 1_000_000n,
  };
  const resend = tx === unanswered;
  sending = true;
  try {
    const res = await ledger
      .withdraw({ to, from_subaccount: [], created_at_time: [tx.createdAt], amount })
      .catch(() => {
        unanswered = tx;
        throw new Error(
          "The cycles ledger did not answer, so this may have gone through. Send the same amount again: the ledger will not take it twice."
        );
      });
    // Any other answer settles a resend: the ledger looks for the
    // duplicate before it checks the balance, and what it refuses
    // earlier it refused the first time too.
    const open =
      "Err" in res &&
      ("TooOld" in res.Err || "TemporarilyUnavailable" in res.Err);
    if (!open && unanswered === tx) unanswered = undefined;
    if ("Ok" in res) return res.Ok;
    // A failed delivery is refunded in a block of its own and leaves
    // the duplicate entry in place, so `Duplicate` only says the first
    // call was taken.
    if ("Duplicate" in res.Err)
      throw new Error(
        `The ledger had already taken this send (block ${res.Err.Duplicate.duplicate_of}): the cycles reached ${to.toText()}, or, if that delivery failed, came back to your wallet less 0.0002 TC in fees. The two balances tell which.`
      );
    if (resend && "TooOld" in res.Err)
      throw new Error(
        "Your earlier send is over a day old, so the ledger can no longer tell whether it went through. Check your wallet's balance; reload this page to send anything else."
      );
    throw new Error(withdrawMessage(res.Err, to));
  } finally {
    sending = false;
    void refreshWallet();
  }
}

function withdrawMessage(err: WithdrawError, to: Principal): string {
  if ("InsufficientFunds" in err)
    return `Your wallet holds ${formatTC(err.InsufficientFunds.balance)}, not enough for this plus the fee.`;
  if ("InvalidReceiver" in err)
    return `${to.toText()} cannot receive cycles: it is not a canister.`;
  if ("FailedToWithdraw" in err)
    return `The ledger could not deliver: ${err.FailedToWithdraw.rejection_reason}${
      err.FailedToWithdraw.fee_block.length > 0 ? " (the fee was charged)" : ""
    }`;
  if ("TemporarilyUnavailable" in err)
    return "The cycles ledger is temporarily unavailable; try again.";
  if ("GenericError" in err) return err.GenericError.message;
  if ("TooOld" in err || "CreatedInFuture" in err)
    return "This computer's clock is off; set it right and try again.";
  return "The ledger refused the withdrawal.";
}

export function useWallet(): Wallet | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => wallet
  );
}
