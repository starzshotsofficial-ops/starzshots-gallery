"use strict";

const fs = require("fs");
const { once } = require("events");

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_SIGNATURE = 0x06054b50;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

const crcTable = buildCrcTable();

/**
 * Minimal streaming ZIP writer, "store" method only. Photos are already compressed,
 * so skipping deflate keeps CPU usage on shared hosting close to zero. Each entry is
 * staged to a temp file first so its size and CRC are known before the header is written.
 */
class ZipWriter {
  constructor(output) {
    this.output = output;
    this.offset = 0;
    this.entries = [];
  }

  async addLocalFile(entryName, filePath) {
    const stats = await fs.promises.stat(filePath);
    const crc = await crc32File(filePath);
    const name = Buffer.from(entryName, "utf8");
    const needsZip64 = stats.size > UINT32_MAX || this.offset > UINT32_MAX;
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(needsZip64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(needsZip64 ? UINT32_MAX : stats.size, 18);
    header.writeUInt32LE(needsZip64 ? UINT32_MAX : stats.size, 22);
    header.writeUInt16LE(name.length, 26);

    const extra = needsZip64 ? buildZip64Extra([stats.size, stats.size]) : Buffer.alloc(0);
    header.writeUInt16LE(extra.length, 28);

    await this.#write(Buffer.concat([header, name, extra]));
    await this.#writeStream(fs.createReadStream(filePath));

    this.entries.push({ name, crc, size: stats.size, localOffset });
  }

  async finish() {
    const centralStart = this.offset;

    for (const entry of this.entries) {
      const needsZip64 = entry.size > UINT32_MAX || entry.localOffset > UINT32_MAX;
      const extraValues = [];
      if (entry.size > UINT32_MAX) extraValues.push(entry.size, entry.size);
      if (entry.localOffset > UINT32_MAX) extraValues.push(entry.localOffset);
      const extra = needsZip64 ? buildZip64Extra(extraValues) : Buffer.alloc(0);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
      header.writeUInt16LE(0x032d, 4);
      header.writeUInt16LE(needsZip64 ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(0x21, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size > UINT32_MAX ? UINT32_MAX : entry.size, 20);
      header.writeUInt32LE(entry.size > UINT32_MAX ? UINT32_MAX : entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset > UINT32_MAX ? UINT32_MAX : entry.localOffset, 42);

      await this.#write(Buffer.concat([header, entry.name, extra]));
    }

    const centralSize = this.offset - centralStart;
    const zip64EndOffset = this.offset;

    const zip64End = Buffer.alloc(56);
    zip64End.writeUInt32LE(ZIP64_END_SIGNATURE, 0);
    writeUInt64LE(zip64End, 44, 4);
    zip64End.writeUInt16LE(0x032d, 12);
    zip64End.writeUInt16LE(45, 14);
    writeUInt64LE(zip64End, BigInt(this.entries.length), 24);
    writeUInt64LE(zip64End, BigInt(this.entries.length), 32);
    writeUInt64LE(zip64End, BigInt(centralSize), 40);
    writeUInt64LE(zip64End, BigInt(centralStart), 48);
    await this.#write(zip64End);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
    writeUInt64LE(locator, BigInt(zip64EndOffset), 8);
    locator.writeUInt32LE(1, 16);
    await this.#write(locator);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIGNATURE, 0);
    end.writeUInt16LE(Math.min(this.entries.length, UINT16_MAX), 8);
    end.writeUInt16LE(Math.min(this.entries.length, UINT16_MAX), 10);
    end.writeUInt32LE(Math.min(centralSize, UINT32_MAX), 12);
    end.writeUInt32LE(Math.min(centralStart, UINT32_MAX), 16);
    await this.#write(end);
  }

  async #write(buffer) {
    if (!this.output.write(buffer)) await once(this.output, "drain");
    this.offset += buffer.length;
  }

  async #writeStream(readable) {
    for await (const chunk of readable) {
      await this.#write(chunk);
    }
  }
}

function buildZip64Extra(values) {
  const body = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => writeUInt64LE(body, BigInt(value), index * 8));

  const extra = Buffer.alloc(4 + body.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(body.length, 2);
  body.copy(extra, 4);
  return extra;
}

function writeUInt64LE(buffer, value, offset) {
  buffer.writeBigUInt64LE(typeof value === "bigint" ? value : BigInt(value), offset);
}

function buildCrcTable() {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
}

async function crc32File(filePath) {
  let crc = -1;
  for await (const chunk of fs.createReadStream(filePath)) {
    for (let index = 0; index < chunk.length; index += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[index]) & 0xff];
    }
  }
  return (crc ^ -1) >>> 0;
}

module.exports = { ZipWriter };
