import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import { USER_AGENT } from "./version.js";

export class FetchError extends Error {}

export interface Fetched {
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface Address {
  address: string;
  family: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: (host: string) => Promise<Address[]>;
  isAllowed?: (ip: string) => boolean;
}

export type FetchText = (url: string) => Promise<Fetched>;

const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC_V6.addSubnet(net, bits, "ipv6");
}

// A BlockList's IPv6 rule for ::ffff:0:0/96 would also match every IPv4 address, so mapped addresses are unwrapped here.
function unmapped(ip: string): string | null {
  const match = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
  if (!match) return null;
  const tail = match[1]!;
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !NOT_PUBLIC_V4.check(ip, "ipv4");
  if (family !== 6) return false;
  const v4 = unmapped(ip);
  return v4 ? isPublicAddress(v4) : !NOT_PUBLIC_V6.check(ip, "ipv6");
}

function systemResolve(host: string): Promise<Address[]> {
  return new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
  );
}

const READABLE = /^(text\/(html|plain|markdown|x-markdown)|application\/(xhtml\+xml|xml)|text\/xml)\b/i;

/** GET a public page as text: every hop's address is checked when it connects, redirects included; size and time are capped. */
export function publicFetcher(options: FetchOptions = {}): FetchText {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const resolve = options.resolve ?? systemResolve;
  const isAllowed = options.isAllowed ?? isPublicAddress;

  const lookup: LookupFunction = (host, lookupOptions, callback) => {
    resolve(host).then(
      (addresses) => {
        const refused = addresses.find((a) => !isAllowed(a.address));
        if (addresses.length === 0 || refused) {
          callback(new FetchError(`refused: ${host} is not on the public internet`), "", 0);
        } else if (lookupOptions.all) {
          (callback as unknown as (e: null, a: Address[]) => void)(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, "", 0),
    );
  };

  function once(url: URL, deadline: number): Promise<{ status: number; location?: string; fetched?: Fetched }> {
    return new Promise((resolvePromise, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && !isAllowed(host)) {
        reject(new FetchError(`refused: ${host} is not on the public internet`));
        return;
      }
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        url,
        {
          method: "GET",
          lookup,
          agent: false,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,*/*;q=0.1",
            "accept-encoding": "gzip, deflate, br",
            "accept-language": "en;q=0.9, *;q=0.5",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            resolvePromise({ status, location: response.headers.location });
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new FetchError(`HTTP ${status}`));
            return;
          }
          const contentType = String(response.headers["content-type"] ?? "text/html");
          if (!READABLE.test(contentType)) {
            response.resume();
            reject(new FetchError(`not a text page (${contentType.split(";")[0]})`));
            return;
          }
          const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
          const stream =
            encoding === "gzip" || encoding === "x-gzip"
              ? response.pipe(zlib.createGunzip())
              : encoding === "deflate"
                ? response.pipe(zlib.createInflate())
                : encoding === "br"
                  ? response.pipe(zlib.createBrotliDecompress())
                  : response;
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const finish = () => {
            const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
            let decoder: TextDecoder;
            try {
              decoder = new TextDecoder(charset);
            } catch {
              decoder = new TextDecoder("utf-8");
            }
            resolvePromise({
              status,
              fetched: { url: url.href, contentType, body: decoder.decode(Buffer.concat(chunks)), truncated },
            });
          };
          stream.on("data", (chunk: Buffer) => {
            if (truncated) return;
            const room = maxBytes - size;
            if (chunk.length >= room) {
              chunks.push(chunk.subarray(0, room));
              size = maxBytes;
              truncated = true;
              request.destroy();
              finish();
              return;
            }
            chunks.push(chunk);
            size += chunk.length;
          });
          stream.on("end", () => {
            if (!truncated) finish();
          });
          stream.on("error", (error) => {
            if (!truncated) reject(new FetchError(`could not read the page: ${error.message}`));
          });
        },
      );
      const timer = setTimeout(
        () => request.destroy(new FetchError(`timed out after ${Math.round(timeoutMs / 1000)} s`)),
        Math.max(0, deadline - Date.now()),
      );
      request.on("close", () => clearTimeout(timer));
      request.on("error", (error) => reject(error instanceof FetchError ? error : new FetchError(error.message)));
      request.end();
    });
  }

  return async (address: string) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new FetchError(`not a web address: ${address}`);
    }
    const deadline = Date.now() + timeoutMs;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new FetchError(`refused: only http and https addresses are read (${url.protocol})`);
      }
      if (url.username || url.password) throw new FetchError("refused: addresses with sign-in details are not read");
      const answer = await once(url, deadline);
      if (answer.fetched) return answer.fetched;
      if (hop >= maxRedirects) throw new FetchError(`more than ${maxRedirects} redirects`);
      url = new URL(answer.location!, url);
    }
  };
}
