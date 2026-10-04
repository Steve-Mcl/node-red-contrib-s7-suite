import { Int64Mode, S7Address, S7DataType } from '../types';
import { S7Error, S7ErrorCode } from '../utils/error-codes';

export interface ReadOptions {
  /** How LINT and ULINT come back. Defaults to 'number'. */
  int64?: Int64Mode;
}

/** S7 epoch: 1990-01-01 */
const S7_DATE_EPOCH = new Date('1990-01-01T00:00:00Z');
const S7_DATE_EPOCH_MS = S7_DATE_EPOCH.getTime();

/** Encode a decimal value (0-99) as BCD byte */
function toBCD(val: number): number {
  const clamped = Math.max(0, Math.min(99, Math.floor(val)));
  return ((Math.floor(clamped / 10) & 0x0f) << 4) | (clamped % 10);
}

/** Decode a BCD byte to decimal value */
function fromBCD(bcd: number): number {
  return ((bcd >> 4) & 0x0f) * 10 + (bcd & 0x0f);
}

function int64Out(value: bigint, mode: Int64Mode | undefined): number | bigint | string {
  if (mode === 'bigint') return value;
  if (mode === 'string') return value.toString();
  return Number(value);
}

/** Accepts a number, a BigInt or an integer string, so values past 2^53 can be written exactly. */
function int64In(value: unknown, dataType: 'LINT' | 'ULINT'): bigint {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    v = BigInt(value.trim());
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new S7Error(S7ErrorCode.WRITE_FAILED, `${dataType} needs an integer; got ${String(value)}`);
    }
    v = BigInt(Math.round(n));
  }
  const [min, max] = dataType === 'LINT' ? [-(2n ** 63n), 2n ** 63n - 1n] : [0n, 2n ** 64n - 1n];
  if (v < min || v > max) {
    throw new S7Error(S7ErrorCode.WRITE_FAILED, `${v} is out of range for ${dataType} (${min} to ${max})`);
  }
  return v;
}

interface DateParts {
  year: number; month: number; day: number; weekday: number;
  hour: number; minute: number; second: number; ms: number;
}

/** Splits a date into its fields in UTC or in the server's local time. weekday is 1 (Sunday) to 7. */
function dateParts(d: Date, utc: boolean): DateParts {
  return utc
    ? {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() + 1,
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
    }
    : {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), weekday: d.getDay() + 1,
      hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), ms: d.getMilliseconds(),
    };
}

function fromParts(p: Omit<DateParts, 'weekday'>, utc: boolean): Date {
  return utc
    ? new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms))
    : new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
}

/** Accepts a Date, milliseconds since 1970, or anything Date can parse (e.g. an ISO string). */
function dateIn(value: unknown, dataType: S7DataType, utc: boolean, minYear: number, maxYear: number): DateParts {
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(d.getTime())) {
    throw new S7Error(
      S7ErrorCode.WRITE_FAILED,
      `${dataType} needs a date (a Date, an ISO string or milliseconds since 1970); got ${String(value)}`,
    );
  }
  const p = dateParts(d, utc);
  if (p.year < minYear || p.year > maxYear) {
    throw new S7Error(S7ErrorCode.WRITE_FAILED, `${dataType} holds years ${minYear} to ${maxYear}; got ${p.year}`);
  }
  return p;
}

/** DATE_AND_TIME / DT: 8 BCD bytes, years 1990-2089, milliseconds, weekday in the last nibble. */
function readDT(buffer: Buffer, offset: number): Omit<DateParts, 'weekday'> {
  const yr = fromBCD(buffer.readUInt8(offset));
  return {
    year: yr < 90 ? 2000 + yr : 1900 + yr,
    month: fromBCD(buffer.readUInt8(offset + 1)),
    day: fromBCD(buffer.readUInt8(offset + 2)),
    hour: fromBCD(buffer.readUInt8(offset + 3)),
    minute: fromBCD(buffer.readUInt8(offset + 4)),
    second: fromBCD(buffer.readUInt8(offset + 5)),
    ms: fromBCD(buffer.readUInt8(offset + 6)) * 10 + ((buffer.readUInt8(offset + 7) >> 4) & 0x0f),
  };
}

function writeDT(buffer: Buffer, offset: number, p: DateParts): void {
  buffer.writeUInt8(toBCD(p.year % 100), offset);
  buffer.writeUInt8(toBCD(p.month), offset + 1);
  buffer.writeUInt8(toBCD(p.day), offset + 2);
  buffer.writeUInt8(toBCD(p.hour), offset + 3);
  buffer.writeUInt8(toBCD(p.minute), offset + 4);
  buffer.writeUInt8(toBCD(p.second), offset + 5);
  buffer.writeUInt8(toBCD(Math.floor(p.ms / 10)), offset + 6);
  buffer.writeUInt8(((p.ms % 10) << 4) | p.weekday, offset + 7);
}

/** DTL: year (u16), month, day, weekday, hour, minute, second (u8 each), nanoseconds (u32). */
function readDTL(buffer: Buffer, offset: number): Omit<DateParts, 'weekday'> {
  return {
    year: buffer.readUInt16BE(offset),
    month: buffer.readUInt8(offset + 2),
    day: buffer.readUInt8(offset + 3),
    hour: buffer.readUInt8(offset + 5),
    minute: buffer.readUInt8(offset + 6),
    second: buffer.readUInt8(offset + 7),
    ms: Math.floor(buffer.readUInt32BE(offset + 8) / 1e6),
  };
}

function writeDTL(buffer: Buffer, offset: number, p: DateParts): void {
  buffer.writeUInt16BE(p.year, offset);
  buffer.writeUInt8(p.month, offset + 2);
  buffer.writeUInt8(p.day, offset + 3);
  buffer.writeUInt8(p.weekday, offset + 4);
  buffer.writeUInt8(p.hour, offset + 5);
  buffer.writeUInt8(p.minute, offset + 6);
  buffer.writeUInt8(p.second, offset + 7);
  buffer.writeUInt32BE(p.ms * 1e6, offset + 8);
}

/** Returns the byte length for a given S7 data type. */
export function byteLength(dataType: S7DataType, stringLength?: number): number {
  switch (dataType) {
    case 'BOOL':
    case 'BYTE':
    case 'CHAR':
    case 'USINT':
      return 1;
    case 'WORD':
    case 'INT':
    case 'UINT':
    case 'DATE':
    case 'S5TIME':
      return 2;
    case 'DWORD':
    case 'DINT':
    case 'REAL':
    case 'UDINT':
    case 'TIME':
    case 'TIME_OF_DAY':
      return 4;
    case 'LREAL':
    case 'LINT':
    case 'ULINT':
    case 'DATE_AND_TIME':
    case 'DT':
    case 'DTZ':
      return 8;
    case 'DTL':
    case 'DTLZ':
      return 12;
    case 'STRING':
      return (stringLength ?? 254) + 2;
    case 'WSTRING':
      return (stringLength ?? 254) * 2 + 4;
  }
}

/**
 * Reads a typed value from a buffer at the given offset. DT and DTL are the PLC's local time
 * (read as the server's local time, like nodes7); DTZ and DTLZ are UTC. All four return a Date.
 */
export function readValue(
  buffer: Buffer, offset: number, dataType: S7DataType, bitOffset = 0, options: ReadOptions = {},
): unknown {
  const required = dataType === 'STRING' ? 2 : dataType === 'WSTRING' ? 4 : byteLength(dataType);
  if (buffer.length < offset + required) {
    throw new S7Error(S7ErrorCode.READ_FAILED, `Buffer too small for ${dataType} read at offset ${offset}: need ${offset + required} bytes, have ${buffer.length}`);
  }
  switch (dataType) {
    case 'BOOL':
      return (buffer.readUInt8(offset) & (1 << bitOffset)) !== 0;
    case 'BYTE':
      return buffer.readUInt8(offset);
    case 'USINT':
      return buffer.readUInt8(offset);
    case 'WORD':
      return buffer.readUInt16BE(offset);
    case 'UINT':
      return buffer.readUInt16BE(offset);
    case 'DWORD':
      return buffer.readUInt32BE(offset);
    case 'UDINT':
      return buffer.readUInt32BE(offset);
    case 'INT':
      return buffer.readInt16BE(offset);
    case 'DINT':
      return buffer.readInt32BE(offset);
    case 'LINT':
      return int64Out(buffer.readBigInt64BE(offset), options.int64);
    case 'ULINT':
      return int64Out(buffer.readBigUInt64BE(offset), options.int64);
    case 'REAL':
      return buffer.readFloatBE(offset);
    case 'LREAL':
      return buffer.readDoubleBE(offset);
    case 'CHAR':
      return String.fromCharCode(buffer.readUInt8(offset));
    case 'STRING': {
      const maxLen = buffer.readUInt8(offset);
      const actualLen = buffer.readUInt8(offset + 1);
      const available = Math.max(0, buffer.length - offset - 2);
      const len = Math.min(actualLen, maxLen, available);
      return buffer.toString('ascii', offset + 2, offset + 2 + len);
    }
    case 'WSTRING': {
      const wsMaxLen = buffer.readUInt16BE(offset);
      const wsActualLen = buffer.readUInt16BE(offset + 2);
      const wsAvailable = Math.max(0, Math.floor((buffer.length - offset - 4) / 2));
      const wsLen = Math.min(wsActualLen, wsMaxLen, wsAvailable);
      const chars: string[] = [];
      for (let i = 0; i < wsLen; i++) {
        chars.push(String.fromCharCode(buffer.readUInt16BE(offset + 4 + i * 2)));
      }
      return chars.join('');
    }
    case 'DATE': {
      const days = buffer.readUInt16BE(offset);
      const dateMs = S7_DATE_EPOCH_MS + days * 86400000;
      const d = new Date(dateMs);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
    case 'TIME':
      return buffer.readInt32BE(offset);
    case 'TIME_OF_DAY':
      return buffer.readUInt32BE(offset);
    case 'DATE_AND_TIME':
      // Same layout as DTZ, but kept as an ISO string as before
      return fromParts(readDT(buffer, offset), true).toISOString();
    case 'DT':
      return fromParts(readDT(buffer, offset), false);
    case 'DTZ':
      return fromParts(readDT(buffer, offset), true);
    case 'DTL':
      return fromParts(readDTL(buffer, offset), false);
    case 'DTLZ':
      return fromParts(readDTL(buffer, offset), true);
    case 'S5TIME': {
      const raw = buffer.readUInt16BE(offset);
      const timeBase = (raw >> 12) & 0x03;
      const bcdVal = raw & 0x0fff;
      const hundreds = (bcdVal >> 8) & 0x0f;
      const tens = (bcdVal >> 4) & 0x0f;
      const ones = bcdVal & 0x0f;
      const count = hundreds * 100 + tens * 10 + ones;
      const multipliers = [10, 100, 1000, 10000];
      return count * multipliers[timeBase];
    }
  }
}

/**
 * Works out what to write for a STRING or WSTRING so that only the string itself changes: its
 * current length and characters. Nothing past the string's declared size is touched, and its
 * declared max length is only written when the header is still empty (all zero).
 *
 * @param header   the string's header as it is in the PLC now (2 bytes for STRING, 4 for WSTRING)
 * @param declared max length given in the address (DB1,STRING50.20), if any
 * @param where    where the string is, for error messages (e.g. "DB1 offset 50")
 * @returns the offset to start writing at, relative to the string, and the bytes to write
 */
export function stringWrite(
  dataType: 'STRING' | 'WSTRING',
  value: unknown,
  header: Buffer,
  declared: number | undefined,
  where: string,
): { start: number; bytes: Buffer } {
  const wide = dataType === 'WSTRING';
  const headerMax = wide ? header.readUInt16BE(0) : header.readUInt8(0);
  // Trust the smaller of the PLC's declared size and the address's, never more
  const maxLen = headerMax > 0 ? Math.min(headerMax, declared ?? headerMax) : declared;
  if (!maxLen) {
    throw new S7Error(
      S7ErrorCode.WRITE_FAILED,
      `${dataType} at ${where} has an empty header and the address gives no length, so its size is unknown (add one to the address, e.g. DB1,${dataType}50.20)`,
    );
  }
  const text = String(value);
  if (text.length > maxLen) {
    throw new S7Error(
      S7ErrorCode.WRITE_FAILED,
      `${dataType} at ${where} holds ${maxLen} characters; the value has ${text.length}`,
    );
  }

  const charSize = wide ? 2 : 1;
  const lenSize = wide ? 2 : 1;
  const writeMax = headerMax === 0; // initialise an empty header, otherwise leave it alone
  const bytes = Buffer.alloc((writeMax ? lenSize : 0) + lenSize + text.length * charSize);
  let pos = 0;
  if (writeMax) {
    pos = wide ? bytes.writeUInt16BE(maxLen, pos) : bytes.writeUInt8(maxLen, pos);
  }
  pos = wide ? bytes.writeUInt16BE(text.length, pos) : bytes.writeUInt8(text.length, pos);
  for (let i = 0; i < text.length; i++) {
    pos = wide ? bytes.writeUInt16BE(text.charCodeAt(i), pos) : bytes.writeUInt8(text.charCodeAt(i) & 0xff, pos);
  }
  return { start: writeMax ? 0 : lenSize, bytes };
}

/**
 * Number of bytes an address covers. An array of bits is packed, as in the PLC: DB1,X10.3.8 is
 * 8 consecutive bits from bit 3 of byte 10, so it spans 2 bytes.
 */
export function addressByteLength(addr: S7Address): number {
  if (addr.arrayLength === undefined) return byteLength(addr.dataType, addr.stringLength);
  if (addr.dataType === 'BOOL') return Math.ceil((addr.bitOffset + addr.arrayLength) / 8);
  return byteLength(addr.dataType, addr.stringLength) * addr.arrayLength;
}

/** Reads the value of an address (a single value, or an array when it has a length) at `start`. */
export function readAddressValue(buffer: Buffer, start: number, addr: S7Address, options: ReadOptions = {}): unknown {
  if (addr.arrayLength === undefined) {
    return readValue(buffer, start, addr.dataType, addr.bitOffset, options);
  }
  const len = byteLength(addr.dataType, addr.stringLength);
  const values: unknown[] = [];
  for (let i = 0; i < addr.arrayLength; i++) {
    if (addr.dataType === 'BOOL') {
      const bit = addr.bitOffset + i;
      values.push(readValue(buffer, start + (bit >> 3), 'BOOL', bit & 7, options));
    } else {
      values.push(readValue(buffer, start + i * len, addr.dataType, 0, options));
    }
  }
  return values;
}

/**
 * Writes the value of an address into a buffer at `start`. An address with a length takes an
 * array of that many values (or a Buffer, for a byte array). For bits the buffer must already
 * hold the bytes as they are in the PLC, so the other bits in them are kept.
 */
export function writeAddressValue(buffer: Buffer, start: number, addr: S7Address, value: unknown): void {
  if (addr.arrayLength === undefined) {
    writeValue(buffer, start, addr.dataType, value, addr.bitOffset);
    return;
  }
  const values = arrayValues(addr, value);
  const len = byteLength(addr.dataType, addr.stringLength);
  for (let i = 0; i < addr.arrayLength; i++) {
    if (addr.dataType === 'BOOL') {
      const bit = addr.bitOffset + i;
      writeValue(buffer, start + (bit >> 3), 'BOOL', values[i], bit & 7);
    } else {
      writeValue(buffer, start + i * len, addr.dataType, values[i], 0);
    }
  }
}

/**
 * Checks the value written to an address that has a length: it must be an array (or a Buffer,
 * for a byte array) with exactly that many values. Anything else is rejected rather than
 * written short.
 */
export function arrayValues(addr: S7Address, value: unknown): ArrayLike<unknown> {
  const byteSized = addr.dataType === 'BYTE' || addr.dataType === 'USINT';
  const values: ArrayLike<unknown> | undefined =
    Array.isArray(value) ? value : byteSized && Buffer.isBuffer(value) ? value : undefined;
  if (!values) {
    throw new S7Error(
      S7ErrorCode.WRITE_FAILED,
      `An array of ${addr.arrayLength} ${addr.dataType} needs an array${byteSized ? ' or a Buffer' : ''} of values`,
    );
  }
  if (values.length !== addr.arrayLength) {
    throw new S7Error(
      S7ErrorCode.WRITE_FAILED,
      `An array of ${addr.arrayLength} ${addr.dataType} needs ${addr.arrayLength} values; got ${values.length}`,
    );
  }
  return values;
}

/** Writes a typed value into a buffer at the given offset. */
export function writeValue(buffer: Buffer, offset: number, dataType: S7DataType, value: unknown, bitOffset = 0): void {
  // A string only needs its header; the characters are fitted to what the buffer holds
  const required = dataType === 'STRING' ? 2 : dataType === 'WSTRING' ? 4 : byteLength(dataType);
  if (buffer.length < offset + required) {
    throw new S7Error(S7ErrorCode.WRITE_FAILED, `Buffer too small for ${dataType} write at offset ${offset}: need ${offset + required} bytes, have ${buffer.length}`);
  }
  switch (dataType) {
    case 'BOOL': {
      const current = buffer.readUInt8(offset);
      if (value) {
        buffer.writeUInt8(current | (1 << bitOffset), offset);
      } else {
        buffer.writeUInt8(current & ~(1 << bitOffset), offset);
      }
      break;
    }
    case 'BYTE':
      buffer.writeUInt8(Number(value), offset);
      break;
    case 'WORD':
      buffer.writeUInt16BE(Number(value), offset);
      break;
    case 'DWORD':
      buffer.writeUInt32BE(Number(value), offset);
      break;
    case 'INT':
      buffer.writeInt16BE(Number(value), offset);
      break;
    case 'DINT':
      buffer.writeInt32BE(Number(value), offset);
      break;
    case 'REAL':
      buffer.writeFloatBE(Number(value), offset);
      break;
    case 'LREAL':
      buffer.writeDoubleBE(Number(value), offset);
      break;
    case 'CHAR':
      buffer.writeUInt8(String(value).charCodeAt(0) || 0, offset);
      break;
    case 'USINT':
      buffer.writeUInt8(Number(value), offset);
      break;
    case 'UINT':
      buffer.writeUInt16BE(Number(value), offset);
      break;
    case 'UDINT':
      buffer.writeUInt32BE(Number(value), offset);
      break;
    case 'LINT':
      buffer.writeBigInt64BE(int64In(value, 'LINT'), offset);
      break;
    case 'ULINT':
      buffer.writeBigUInt64BE(int64In(value, 'ULINT'), offset);
      break;
    case 'STRING': {
      const str = String(value);
      const maxLen = buffer.readUInt8(offset) || (buffer.length - offset - 2);
      const writeLen = Math.min(str.length, maxLen, buffer.length - offset - 2);
      if (writeLen < 0) break;
      buffer.writeUInt8(maxLen, offset);
      buffer.writeUInt8(writeLen, offset + 1);
      buffer.write(str.substring(0, writeLen), offset + 2, writeLen, 'ascii');
      break;
    }
    case 'WSTRING': {
      const wstr = String(value);
      const wsMaxLen = buffer.readUInt16BE(offset) || Math.floor((buffer.length - offset - 4) / 2);
      const wsWriteLen = Math.min(wstr.length, wsMaxLen, Math.floor((buffer.length - offset - 4) / 2));
      if (wsWriteLen < 0) break;
      buffer.writeUInt16BE(wsMaxLen, offset);
      buffer.writeUInt16BE(wsWriteLen, offset + 2);
      for (let i = 0; i < wsWriteLen; i++) {
        buffer.writeUInt16BE(wstr.charCodeAt(i), offset + 4 + i * 2);
      }
      break;
    }
    case 'DATE': {
      const dateVal = new Date(String(value));
      const daysDiff = Math.round((dateVal.getTime() - S7_DATE_EPOCH_MS) / 86400000);
      buffer.writeUInt16BE(Math.max(0, daysDiff), offset);
      break;
    }
    case 'TIME':
      buffer.writeInt32BE(Number(value), offset);
      break;
    case 'TIME_OF_DAY':
      buffer.writeUInt32BE(Number(value), offset);
      break;
    case 'DATE_AND_TIME':
    case 'DTZ':
      writeDT(buffer, offset, dateIn(value, dataType, true, 1990, 2089));
      break;
    case 'DT':
      writeDT(buffer, offset, dateIn(value, dataType, false, 1990, 2089));
      break;
    case 'DTL':
      writeDTL(buffer, offset, dateIn(value, dataType, false, 1970, 2262));
      break;
    case 'DTLZ':
      writeDTL(buffer, offset, dateIn(value, dataType, true, 1970, 2262));
      break;
    case 'S5TIME': {
      const totalMs = Math.max(0, Number(value));
      let base: number;
      let multiplier: number;
      if (totalMs <= 9990) { base = 0; multiplier = 10; }
      else if (totalMs <= 99900) { base = 1; multiplier = 100; }
      else if (totalMs <= 999000) { base = 2; multiplier = 1000; }
      else { base = 3; multiplier = 10000; }
      const count = Math.min(999, Math.round(totalMs / multiplier));
      const h = Math.floor(count / 100);
      const t = Math.floor((count % 100) / 10);
      const o = count % 10;
      const bcdVal = (h << 8) | (t << 4) | o;
      buffer.writeUInt16BE((base << 12) | bcdVal, offset);
      break;
    }
  }
}
