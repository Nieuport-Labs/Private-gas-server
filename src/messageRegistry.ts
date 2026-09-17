// Maps a wire-format {typeUrl, value} pair (what an HTTP client sends) to a real secretjs Msg
// instance. Every secretjs Msg class has the same shape — `new MsgX(params)`, where `params` is
// exactly the proto message's fields — so a client only needs to send the type URL plus those
// fields; no per-type parsing logic is needed here beyond the lookup table itself.
//
// Covers the native (plaintext, simulatable) action types the grant scopes —
// MsgSend/MsgDelegate/MsgUndelegate/MsgBeginRedelegate/MsgVote — plus MsgExecuteContract for
// calling a *whitelisted* contract (config.allowedContractAddresses), e.g. a DEX swap.
//
// MsgExecuteContract here is deliberately plaintext-in, same as the payment message payment.ts
// already builds: quote.ts has to see the contract address to check it against the whitelist
// (and, for now, has no way around also seeing the rest of the call's plaintext to do that — see
// the plan's "Rozšíření: whitelist kontraktů" section for the confidentiality trade-off this
// implies, and why it's judged acceptable only for contracts the operator has explicitly
// vetted). It also means gas for these can't come from simulate — Secret can't simulate
// MsgExecuteContract at all — so quote.ts prices each whitelisted contract address from its own
// calibrated constant (gasCalibration.ts), not the shared simulate path used for the other
// types here.
import {
  MsgSend,
  MsgDelegate,
  MsgUndelegate,
  MsgBeginRedelegate,
  MsgVote,
  MsgExecuteContract,
  type Msg,
} from "secretjs";

export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/secret.compute.v1beta1.MsgExecuteContract";

const registry: Record<string, new (params: any) => Msg> = {
  "/cosmos.bank.v1beta1.MsgSend": MsgSend,
  "/cosmos.staking.v1beta1.MsgDelegate": MsgDelegate,
  "/cosmos.staking.v1beta1.MsgUndelegate": MsgUndelegate,
  "/cosmos.staking.v1beta1.MsgBeginRedelegate": MsgBeginRedelegate,
  "/cosmos.gov.v1.MsgVote": MsgVote,
  [MSG_EXECUTE_CONTRACT_TYPE_URL]: MsgExecuteContract,
};

export class MessageDecodeError extends Error {}

export interface WireMessage {
  typeUrl: string;
  value: unknown;
}

export function decodeMessages(wireMessages: WireMessage[]): Msg[] {
  if (!Array.isArray(wireMessages) || wireMessages.length === 0) {
    throw new MessageDecodeError("messages must be a non-empty array");
  }
  return wireMessages.map((m) => {
    if (!m || typeof m.typeUrl !== "string") {
      throw new MessageDecodeError("each message needs a typeUrl string");
    }
    const MsgClass = registry[m.typeUrl];
    if (!MsgClass) {
      throw new MessageDecodeError(
        `unsupported message type over HTTP: ${m.typeUrl} (supported: ${Object.keys(registry).join(", ")})`,
      );
    }
    return new MsgClass(m.value);
  });
}
