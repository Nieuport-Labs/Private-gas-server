// Proving what is running, to somebody who has no reason to take our word for it.
//
// Everything else in this server asks users to trust the operator: the permit is deleted because
// we say so, the balance is read once because we say so. Running inside a TDX confidential VM
// replaces that with something checkable -- the hardware signs a statement about the exact
// software image it booted, and a client can verify that signature against Intel before handing
// over anything.
//
// It only replaces trust if the client actually checks. A server that offers an attestation
// nobody verifies is in exactly the same position as one that offers a promise, so this endpoint
// exists to be called by the app before it sends a permit, not to be admired on a status page.
//
// Outside a CVM there is no socket and this reports that plainly. Claiming an attestation that
// does not exist would be worse than having none.
import { config } from "./config.js";

/** Where the dstack guest agent listens inside a CVM. */
const DSTACK_SOCKET = "/var/run/dstack.sock";

export interface AttestationInfo {
  /** Identity of the application: derived from the compose file, and what a client pins. */
  appId: string;
  /** Identity of this particular VM. Changes when the CVM is recreated; appId does not. */
  instanceId: string;
  appName: string;
  /** The hash of the compose file this CVM booted. The thing worth comparing. */
  composeHash: string | null;
  tcbInfo: unknown;
}

export interface Attestation {
  info: AttestationInfo;
  /** The TDX quote, hex. Verified against Intel, not against us. */
  quote: string;
  /** RTMR event log, for replaying the measurements rather than trusting the summary. */
  eventLog: unknown;
  /** Echoed back so a client can confirm this quote was made for its challenge, not replayed. */
  nonce: string;
}

let clientPromise: Promise<unknown> | null = null;

/**
 * The SDK is imported lazily and tolerantly.
 *
 * Most runs of this server are not in a CVM -- a laptop, a VPS, CI -- and none of them should
 * fail to boot because a confidential-computing SDK is missing or its socket is not there.
 */
async function dstackClient(): Promise<{ info(): Promise<never>; getQuote(data: string): Promise<never> } | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { DstackClient } = (await import("@phala/dstack-sdk")) as {
          DstackClient: new (endpoint?: string) => unknown;
        };
        // DSTACK_SIMULATOR_ENDPOINT is what the local simulator sets; honouring it is what makes
        // this path testable without a real TDX host.
        const endpoint = process.env.DSTACK_SIMULATOR_ENDPOINT;
        return new DstackClient(endpoint || DSTACK_SOCKET);
      } catch {
        return null;
      }
    })();
  }
  return clientPromise as Promise<{ info(): Promise<never>; getQuote(data: string): Promise<never> } | null>;
}

/** Whether this process can produce an attestation at all. */
export async function attestationAvailable(): Promise<boolean> {
  const client = await dstackClient();
  if (!client) return false;
  try {
    await client.info();
    return true;
  } catch {
    return false;
  }
}

/**
 * A quote bound to the caller's nonce.
 *
 * The nonce is the difference between "this hardware once ran this image" and "this hardware is
 * running this image now, and is the thing I am talking to". Without it a quote can be captured
 * and replayed by anything, which would leave a client verifying a genuine attestation of a
 * machine that is not answering its requests.
 */
export async function getAttestation(nonce: string): Promise<Attestation | null> {
  const client = await dstackClient();
  if (!client) return null;

  try {
    const reportData = JSON.stringify({
      nonce,
      chainId: config.chainId,
      // Named so a verifier can tell which service it is looking at without guessing from ports.
      service: "sscrt-gas-provider",
    });

    const [rawInfo, rawQuote] = await Promise.all([client.info(), client.getQuote(reportData)]);
    const i = rawInfo as unknown as Record<string, unknown>;
    const q = rawQuote as unknown as Record<string, unknown>;

    return {
      info: {
        appId: String(i.app_id ?? ""),
        instanceId: String(i.instance_id ?? ""),
        appName: String(i.app_name ?? ""),
        composeHash: typeof i.compose_hash === "string" ? i.compose_hash : null,
        tcbInfo: i.tcb_info ?? null,
      },
      quote: String(q.quote ?? ""),
      eventLog: q.event_log ?? null,
      nonce,
    };
  } catch {
    return null;
  }
}
