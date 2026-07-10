// ump.ts — MIDI 2.0 UMP codec (canonical <-> UMP wire).
//
// Wraps canonical bytes in MIDI 2.0 Universal MIDI Packet (UMP) SysEx 8
// message-type packets. Spec-direct, no third-party UMP library.
//
// UMP SysEx 8 packet layout (16 bytes / 128 bits):
//     Byte 0: 0x5G       message type 0x5 (SysEx 8), group G (0..15)
//     Byte 1: 0xSN       status nybble S (0=complete,1=start,2=continue,3=end)
//                        num_bytes nybble N (count of valid data bytes, 0..13)
//     Byte 2: stream_id  (0 for Patch v1.1)
//     Bytes 3..15: up to 13 data bytes, padded with 0x00 if num_bytes < 13

const SYSEX8_MESSAGE_TYPE = 0x5;

const PACKET_BYTES = 16;
const DATA_BYTES_PER_PACKET = 13;

const STATUS_COMPLETE = 0;
const STATUS_START = 1;
const STATUS_CONTINUE = 2;
const STATUS_END = 3;

const PROTOCOL_GROUP = 0;

/**
 * Thrown when a UMP SysEx 8 stream is malformed: the length is not a multiple
 * of the 16-byte packet size, a packet has the wrong message type or an
 * out-of-range num_bytes/status, the stream is empty, packet groups are
 * inconsistent, or the START/CONTINUE/END status sequence is invalid.
 */
export class UMPParseError extends Error {
  /** Construct with a message describing the UMP stream violation. */
  constructor(message: string) {
    super(message);
    this.name = "UMPParseError";
  }
}

interface UMPPacket {
  messageType: number; // 0x5 for SysEx 8
  group: number; // 0..15
  status: number; // 0..3
  numBytes: number; // 0..13
  streamId: number; // 0 for v1.1
  data: Uint8Array; // exactly numBytes long
}

// --- packet pack / unpack ---------------------------------------------------

function packPacket(p: UMPPacket): Uint8Array {
  if (p.data.length !== p.numBytes) {
    throw new Error(`packet data length ${p.data.length} != num_bytes ${p.numBytes}`);
  }
  if (!(p.numBytes >= 0 && p.numBytes <= DATA_BYTES_PER_PACKET)) {
    throw new Error(`num_bytes must be 0..${DATA_BYTES_PER_PACKET}, got ${p.numBytes}`);
  }
  if (p.messageType !== SYSEX8_MESSAGE_TYPE) {
    throw new Error(`message_type must be ${SYSEX8_MESSAGE_TYPE}, got ${p.messageType}`);
  }
  if (!(p.group >= 0 && p.group <= 15)) throw new Error(`group must be 0..15, got ${p.group}`);
  if (!(p.status >= 0 && p.status <= 3)) throw new Error(`status must be 0..3, got ${p.status}`);
  if (!(p.streamId >= 0 && p.streamId <= 255)) {
    throw new Error(`stream_id must be 0..255, got ${p.streamId}`);
  }
  const out = new Uint8Array(PACKET_BYTES);
  out[0] = (p.messageType << 4) | p.group;
  out[1] = (p.status << 4) | p.numBytes;
  out[2] = p.streamId;
  out.set(p.data, 3);
  // Bytes 3 + numBytes .. 15 stay zero-padded.
  return out;
}

function unpackPacket(packet: Uint8Array): UMPPacket {
  if (packet.length !== PACKET_BYTES) {
    throw new UMPParseError(`UMP packet must be exactly ${PACKET_BYTES} bytes, got ${packet.length}`);
  }
  const messageType = (packet[0] >> 4) & 0x0f;
  const group = packet[0] & 0x0f;
  const status = (packet[1] >> 4) & 0x0f;
  const numBytes = packet[1] & 0x0f;
  const streamId = packet[2];
  if (messageType !== SYSEX8_MESSAGE_TYPE) {
    throw new UMPParseError(
      `unexpected message type 0x${messageType.toString(16)} (expected SysEx 8 = 0x${SYSEX8_MESSAGE_TYPE.toString(16)})`,
    );
  }
  if (numBytes > DATA_BYTES_PER_PACKET) {
    throw new UMPParseError(`num_bytes ${numBytes} exceeds packet capacity ${DATA_BYTES_PER_PACKET}`);
  }
  if (status > 3) throw new UMPParseError(`invalid status nybble ${status}`);
  const data = packet.slice(3, 3 + numBytes);
  return { messageType, group, status, numBytes, streamId, data };
}

// --- canonical bytes <-> UMP stream -----------------------------------------

/**
 * Encode canonical bytes as a stream of UMP SysEx 8 packets.
 * v1.1 (R-003): protocol data MUST use group 0.
 */
export function encode(canonicalBytes: Uint8Array, group = PROTOCOL_GROUP, streamId = 0): Uint8Array {
  if (group !== PROTOCOL_GROUP) {
    throw new Error(
      `Patch v1.1 protocol data must use UMP group ${PROTOCOL_GROUP}; got group=${group}`,
    );
  }
  if (canonicalBytes.length === 0) throw new Error("canonical_bytes is empty");

  const n = canonicalBytes.length;
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i < n) {
    const chunk = canonicalBytes.subarray(i, i + DATA_BYTES_PER_PACKET);
    const remainingAfter = n - (i + chunk.length);
    const isFirst = i === 0;
    const isLast = remainingAfter === 0;
    let status: number;
    if (isFirst && isLast) status = STATUS_COMPLETE;
    else if (isFirst) status = STATUS_START;
    else if (isLast) status = STATUS_END;
    else status = STATUS_CONTINUE;
    parts.push(
      packPacket({
        messageType: SYSEX8_MESSAGE_TYPE,
        group,
        status,
        numBytes: chunk.length,
        streamId,
        data: chunk.slice(),
      }),
    );
    i += chunk.length;
  }
  return concat(parts);
}

/** Decode a UMP SysEx 8 stream back to canonical bytes. */
export function decode(umpBytes: Uint8Array): Uint8Array {
  if (umpBytes.length % PACKET_BYTES !== 0) {
    throw new UMPParseError(`UMP stream length ${umpBytes.length} is not a multiple of ${PACKET_BYTES}`);
  }
  const packets: UMPPacket[] = [];
  for (let i = 0; i < umpBytes.length; i += PACKET_BYTES) {
    packets.push(unpackPacket(umpBytes.subarray(i, i + PACKET_BYTES)));
  }
  if (packets.length === 0) throw new UMPParseError("UMP stream is empty");

  const group = packets[0].group;
  if (group !== PROTOCOL_GROUP) {
    throw new UMPParseError(
      `Patch v1.1 protocol-data decoder only accepts group ${PROTOCOL_GROUP}, got group ${group}`,
    );
  }
  for (let idx = 1; idx < packets.length; idx++) {
    if (packets[idx].group !== group) {
      throw new UMPParseError(`packet ${idx} group ${packets[idx].group} differs from stream group ${group}`);
    }
  }

  const parts: Uint8Array[] = [];
  if (packets.length === 1) {
    if (packets[0].status !== STATUS_COMPLETE) {
      throw new UMPParseError(
        `single-packet stream must have status=COMPLETE (${STATUS_COMPLETE}), got ${packets[0].status}`,
      );
    }
    parts.push(packets[0].data);
  } else {
    if (packets[0].status !== STATUS_START) {
      throw new UMPParseError(
        `multi-packet stream must start with status=START (${STATUS_START}), got ${packets[0].status}`,
      );
    }
    if (packets[packets.length - 1].status !== STATUS_END) {
      throw new UMPParseError(
        `multi-packet stream must end with status=END (${STATUS_END}), got ${packets[packets.length - 1].status}`,
      );
    }
    for (let idx = 1; idx < packets.length - 1; idx++) {
      if (packets[idx].status !== STATUS_CONTINUE) {
        throw new UMPParseError(
          `middle packet ${idx} must have status=CONTINUE (${STATUS_CONTINUE}), got ${packets[idx].status}`,
        );
      }
    }
    for (const p of packets) parts.push(p.data);
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
