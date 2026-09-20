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
 * Why the SDK could not be used, when it could not be.
 *
 * This exists because swallowing that reason cost a deployment. `@phala/dstack-sdk` declares
 * `@noble/curves` as an *optional* peer dependency and then imports it statically, so npm never
 * installs it and the import throws everywhere -- including inside a real CVM. A bare `catch {}`
 * turned that into "not running in a confidential VM", which is the same answer a laptop gives,
 * so it looked like correct behaviour right up until it was deployed on TDX hardware and said
 * the same thing.
 *
 * A diagnostic that is indistinguishable from the healthy case is not a diagnostic.
 */
let unavailableReason: string | null = null;

/**
 * The SDK is imported lazily and tolerantly.
 *
 * Most runs of this server are not in a CVM -- a laptop, a VPS, CI -- and none of them should
 * fail to boot because a confidential-computing SDK is missing or its socket is not there.
 * Tolerantly, though, is not silently: whatever went wrong is kept and reported.
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
      } catch (err) {
        unavailableReason = (err as Error)?.message ?? String(err);
        return null;
      }
    })();
  }
  return clientPromise as Promise<{ info(): Promise<never>; getQuote(data: string): Promise<never> } | null>;
}

/**
 * Why attestation is unavailable, or null while it has not been attempted or is working.
 *
 * Reported on /status and in the 501 body. It names a missing package or an absent socket, which
 * is an operator's problem and not a secret: the whole file is public and its hash is the app's
 * identity.
 */
export function attestationUnavailableReason(): string | null {
  return unavailableReason;
}

/** Whether this process can produce an attestation at all. */
export async function attestationAvailable(): Promise<boolean> {
  const client = await dstackClient();
  if (!client) return false;
  try {
    await client.info();
    unavailableReason = null;
    return true;
  } catch (err) {
    unavailableReason = `dstack guest agent unreachable at ${DSTACK_SOCKET}: ${(err as Error)?.message ?? String(err)}`;
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
  } catch (err) {
    unavailableReason = `dstack quote request failed: ${(err as Error)?.message ?? String(err)}`;
    return null;
  }
}
