// Signing a quote the way a real client has to: the server's bytes, verbatim.
//
// The smoke tests used to rebuild the payment message locally and sign that, with a comment
// saying byte-identical ciphertext was not what /submit cared about. Since txVerify.ts landed
// that is no longer true and has not been: MsgExecuteContract encrypts with a random nonce, so a
// locally rebuilt message produces different bytes and is rejected as a mismatch -- correctly.
//
// So a client cannot rebuild the message; it signs what it was handed. secretjs only ever calls
// `toProto` and `toAmino` on a Msg, so a plain object carrying the quoted bytes is enough, and
// this is what the browser app does too.
import { fromBase64, type Msg } from "secretjs";

export interface QuotedForSigning {
  messages: unknown[];
  protoMessages: { typeUrl: string; bytes: string }[];
}

export function quotedMessages(quote: QuotedForSigning): Msg[] {
  return quote.protoMessages.map((proto, index) => ({
    toProto: async () => ({
      type_url: proto.typeUrl,
      value: null,
      encode: () => fromBase64(proto.bytes),
    }),
    toAmino: async () => quote.messages[index] as never,
  })) as unknown as Msg[];
}
