// codec_test.ts — Deno tests for the native Patch codec, asserted against the
// copied testdata/column_fill_demo fixture bundle (self-contained, no absolute
// paths). These golden vectors are ground truth.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  ContentHashError,
  decode,
  emit,
  encode,
  parse,
  patchId,
  patchIdHex,
} from "./codec.ts";

const HERE = new URL(".", import.meta.url).pathname;

async function readFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(`${HERE}testdata/${name}`);
}

async function readManifest(): Promise<{ patch_id: string }> {
  const text = await Deno.readTextFile(`${HERE}testdata/column_fill_demo.manifest.json`);
  return JSON.parse(text);
}

/** Strict Uint8Array equality: same length + every byte identical. */
function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, msg?: string) {
  assertEquals(actual.length, expected.length, `${msg ?? "byte length"} mismatch`);
  for (let i = 0; i < expected.length; i++) {
    assertEquals(actual[i], expected[i], `${msg ?? "byte"} differs at offset ${i}`);
  }
}

Deno.test("patchId equals manifest patch_id", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const manifest = await readManifest();

  const id = await patchId(patch); // "sha256:..." prefixed form
  assertEquals(id, manifest.patch_id);

  // raw-hex form matches the manifest hex (strip the "sha256:" prefix).
  const hex = await patchIdHex(patch);
  assertEquals(hex, manifest.patch_id.replace(/^sha256:/, ""));
  assertEquals(
    hex,
    "a8284a7c35a8be9bf47381542dbb3b576c277be684a92882a86701b6ab3efc3a",
  );
});

Deno.test("decode(ump) byte-equals the .patch bytes", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const umpBytes = await readFixture("column_fill_demo.ump");
  assertBytesEqual(decode(umpBytes), patch, "decode(ump)");
  // auto-sniff must pick ump too.
  assertBytesEqual(decode(umpBytes, "auto"), patch, "decode(ump, auto)");
});

Deno.test("decode(syx) byte-equals the .patch bytes", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const syx = await readFixture("column_fill_demo.syx");
  assertBytesEqual(decode(syx), patch, "decode(sysex1)");
  assertBytesEqual(decode(syx, "auto"), patch, "decode(sysex1, auto)");
});

Deno.test("decode(patch, canonical) is identity", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  assertBytesEqual(decode(patch, "canonical"), patch, "decode(canonical)");
  // auto-sniff of raw canonical (first byte 0x70) also passes through.
  assertBytesEqual(decode(patch, "auto"), patch, "decode(auto->canonical)");
});

Deno.test("parse succeeds and content-hash verification passes", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const parsed = await parse(patch);
  assertEquals(parsed.header.schemaSetVersion, 5);
  assertEquals(parsed.header.patchVersion, 1);
  // Exactly one invocation frame in this fixture: PIP.transfer.
  assertEquals(parsed.invocations.length, 1);
  assertEquals(parsed.invocations[0].schemaId >>> 0, 0x60005005);
  assertEquals(parsed.footer.contentHash.length, 32);
});

Deno.test("tampering one payload byte throws ContentHashError", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const tampered = patch.slice();
  // Flip a byte inside the invocation payload region (well inside, not header
  // schema_id or footer). Offset 0x40 is within the PIP.transfer payload.
  tampered[0x40] ^= 0xff;
  await assertRejects(() => parse(tampered), ContentHashError);
});

Deno.test("emit(header, invocations) byte-equals original .patch (round-trip)", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const parsed = await parse(patch);
  const reemitted = await emit(parsed.header, parsed.invocations);
  assertBytesEqual(reemitted, patch, "emit round-trip");
});

Deno.test("encode(canonical, ump) byte-equals the .ump bytes", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const umpBytes = await readFixture("column_fill_demo.ump");
  assertBytesEqual(encode(patch, "ump"), umpBytes, "encode ump");
});

Deno.test("encode(canonical, sysex1) byte-equals the .syx bytes", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  const syx = await readFixture("column_fill_demo.syx");
  assertBytesEqual(encode(patch, "sysex1"), syx, "encode sysex1");
});

Deno.test("full wire round-trips: encode then decode returns canonical", async () => {
  const patch = await readFixture("column_fill_demo.patch");
  assertBytesEqual(decode(encode(patch, "ump")), patch, "ump round-trip");
  assertBytesEqual(decode(encode(patch, "sysex1")), patch, "sysex1 round-trip");
});

Deno.test("variable-length PIP.transfer frame width is honored on parse", async () => {
  // Sanity: the sole invocation payload is 6 + 3*N. In this fixture N = 8
  // (prologue byte 0x08), so payload length must be 30 bytes.
  const patch = await readFixture("column_fill_demo.patch");
  const parsed = await parse(patch);
  const inv = parsed.invocations[0];
  assertEquals(inv.payload[0], 8, "target_count prologue byte");
  assertEquals(inv.payload.length, 6 + 3 * 8);
  assert(inv.payload.length === 30);
});
