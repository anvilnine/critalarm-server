import { createSign, generateKeyPairSync } from "node:crypto";

// A self-signed certificate for one DNS name, built by hand in DER so tests
// need neither a dependency nor a call to openssl.
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? Buffer.from([body.length])
    : body.length < 256 ? Buffer.from([0x81, body.length])
    : Buffer.from([0x82, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const oid = (...arcs: number[]): Buffer => {
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 127];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 127) | 128);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const sha256WithRsa = der(0x30, oid(1, 2, 840, 113549, 1, 1, 11), der(0x05));
const name = (cn: string) => der(0x30, der(0x31, der(0x30, oid(2, 5, 4, 3), der(0x0c, Buffer.from(cn)))));

export function selfSignedCertificate(host: string): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const extensions = der(0xa3, der(0x30,
    der(0x30, oid(2, 5, 29, 19), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, der(0x01, Buffer.from([0xff]))))),
    der(0x30, oid(2, 5, 29, 17), der(0x04, der(0x30, der(0x82, Buffer.from(host))))),
  ));
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), sha256WithRsa, name(host),
    der(0x30, der(0x17, Buffer.from("200101000000Z")), der(0x17, Buffer.from("491231235959Z"))),
    name(host), publicKey.export({ type: "spki", format: "der" }), extensions);
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const certificate = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}
