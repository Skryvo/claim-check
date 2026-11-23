import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import zlib from "node:zlib";
import { FetchError, isPublicAddress, publicFetcher, VERSION } from "../dist/index.js";

async function server(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { port: s.address().port, seen, close: () => new Promise((resolve) => s.close(resolve)) };
}

// The test server lives on loopback, so these fetchers treat 127.0.0.1 as the one allowed address and name it public.test.
function fetcher(options = {}) {
  return publicFetcher({
    resolve: async (host) =>
      ({ "public.test": [{ address: "127.0.0.1", family: 4 }], "internal.test": [{ address: "10.0.0.5", family: 4 }] })[host] ?? [],
    isAllowed: (ip) => ip === "127.0.0.1",
    ...options,
  });
}

test("only public addresses pass", () => {
  for (const ip of ["8.8.8.8", "103.102.166.224", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.ok(isPublicAddress(ip), ip);
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "not-an-ip",
  ]) {
    assert.ok(!isPublicAddress(ip), ip);
  }
});

test("loopback, private and metadata addresses are refused before any connection", async () => {
  const s = await server((_, res) => res.end("secret"));
  const strict = publicFetcher();
  await assert.rejects(strict(`http://127.0.0.1:${s.port}/`), /refused: 127.0.0.1 is not on the public internet/);
  await assert.rejects(strict(`http://[::1]:${s.port}/`), /refused/);
  await assert.rejects(strict("http://169.254.169.254/latest/meta-data/"), /refused/);
  await assert.rejects(strict(`http://localhost:${s.port}/`), /refused: localhost is not on the public internet/);
  await assert.rejects(fetcher()(`http://internal.test:${s.port}/`), /refused: internal.test/);
  assert.equal(s.seen.length, 0);
  await s.close();
});

test("a redirect to a private address is refused at the hop", async () => {
  const s = await server((req, res) => {
    const to = { "/meta": "http://169.254.169.254/", "/internal": `http://internal.test:1/`, "/ok": "/final" }[req.url];
    if (to) {
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("arrived");
  });
  const get = fetcher();
  await assert.rejects(get(`http://public.test:${s.port}/meta`), /refused: 169.254.169.254/);
  await assert.rejects(get(`http://public.test:${s.port}/internal`), /refused: internal.test/);
  const fine = await get(`http://public.test:${s.port}/ok`);
  assert.equal(fine.body, "arrived");
  assert.equal(fine.url, `http://public.test:${s.port}/final`);
  await s.close();
});

test("other schemes, sign-in details and redirect loops are refused", async () => {
  const s = await server((req, res) => {
    res.writeHead(301, { location: req.url });
    res.end();
  });
  await assert.rejects(fetcher()("file:///etc/passwd"), /only http and https/);
  await assert.rejects(fetcher()(`http://user:pass@public.test:${s.port}/`), /sign-in details/);
  await assert.rejects(fetcher({ maxRedirects: 2 })(`http://public.test:${s.port}/loop`), /more than 2 redirects/);
  assert.equal(s.seen.length, 3);
  await s.close();
});

test("the page is capped in size, decompressed, decoded, and fetched with an honest User-Agent", async () => {
  const s = await server((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(50_000));
    } else if (req.url === "/gzip") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("<p>café au lait</p>"));
    } else if (req.url === "/latin1") {
      res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" });
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    } else {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7");
    }
  });
  const get = fetcher({ maxBytes: 1000 });
  const big = await get(`http://public.test:${s.port}/big`);
  assert.equal(big.body.length, 1000);
  assert.equal(big.truncated, true);
  assert.equal((await get(`http://public.test:${s.port}/gzip`)).body, "<p>café au lait</p>");
  assert.equal((await get(`http://public.test:${s.port}/latin1`)).body, "café");
  await assert.rejects(get(`http://public.test:${s.port}/pdf`), (e) => e instanceof FetchError && /not a text page \(application\/pdf\)/.test(e.message));
  assert.equal(s.seen[0].headers["user-agent"], `claim-check/${VERSION} (+https://github.com/Skryvo/claim-check)`);
  await s.close();
});

test("a page that does not answer in time is given up", async () => {
  const s = await server(() => {});
  const started = Date.now();
  await assert.rejects(fetcher({ timeoutMs: 300 })(`http://public.test:${s.port}/slow`), /timed out/);
  assert.ok(Date.now() - started < 3000);
  s.close();
});

test("an error status is reported as it came", async () => {
  const s = await server((_, res) => {
    res.writeHead(403);
    res.end();
  });
  await assert.rejects(fetcher()(`http://public.test:${s.port}/`), /HTTP 403/);
  await s.close();
});
