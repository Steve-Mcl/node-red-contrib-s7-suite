import { parseAddress } from './address-parser';
import { byteLength } from './data-converter';
import { S7Address } from '../types';

const NODES7_FORM = /^(DB\d+,[A-Z_]+)(\d+)(.*)$/i;
const IEC_FORM = /^(DB\d+\.DB[XBWD])(\d+)(?:\.\d)?$/i;
const AREA_FORM = /^([MIQCT][XBWD]?)(\d+)(.*)$/i;

/**
 * Suggests the address that follows `previous` in a run of same-type tags, for seeding a new row
 * in an address list: DB1,REAL0 gives DB1,REAL4, DB1.DBD0 gives DB1.DBD4, MW10 gives MW12 and
 * I0.7 gives I1.0. The notation, the type and any array or string length are kept, so the
 * guess is right for a run of one type and costs nothing when it isn't (the editor selects it).
 *
 * In nodes7 DB notation, anything wider than a byte, and every string and array, starts on an
 * even byte, as in a DB without optimized block access. Area and IEC addresses (MW, DB1.DBW)
 * are raw memory and are not aligned.
 *
 * Returns null for anything that isn't a valid address.
 */
export function nextAddress(previous: string): string | null {
  const text = String(previous ?? '').trim();
  let addr: S7Address;
  try {
    addr = parseAddress(text);
  } catch {
    return null;
  }
  const isBit = addr.dataType === 'BOOL';
  const count = addr.arrayLength ?? 1;
  const countSuffix = addr.arrayLength !== undefined ? `.${addr.arrayLength}` : '';

  let m = NODES7_FORM.exec(text);
  if (m) {
    if (isBit) {
      const next = afterBits(addr.offset, addr.bitOffset, count);
      return `${m[1]}${next.offset}.${next.bit}${countSuffix}`;
    }
    const size = byteLength(addr.dataType, addr.stringLength) * count;
    let offset = addr.offset + size;
    const isString = addr.dataType === 'STRING' || addr.dataType === 'WSTRING';
    if (size > 1 || isString || addr.arrayLength !== undefined) offset += offset % 2;
    // The suffix (array length, or a string's max length) is kept exactly as written
    return `${m[1]}${offset}${m[3]}`;
  }

  m = IEC_FORM.exec(text);
  if (m) {
    if (isBit) {
      const next = afterBits(addr.offset, addr.bitOffset, 1);
      return `${m[1]}${next.offset}.${next.bit}`;
    }
    return `${m[1]}${addr.offset + byteLength(addr.dataType)}`;
  }

  m = AREA_FORM.exec(text);
  if (m) {
    // Counters and timers are numbered, not addressed by byte: C5 is followed by C6
    if (addr.area === 'C' || addr.area === 'T') return `${m[1]}${addr.offset + count}${m[3]}`;
    if (isBit) {
      const next = afterBits(addr.offset, addr.bitOffset, count);
      return `${m[1]}${next.offset}.${next.bit}${countSuffix}`;
    }
    return `${m[1]}${addr.offset + byteLength(addr.dataType) * count}${m[3]}`;
  }

  return null;
}

/** The bit after `count` bits starting at byte `offset`, bit `bit`, wrapping into the next byte. */
function afterBits(offset: number, bit: number, count: number): { offset: number; bit: number } {
  const total = offset * 8 + bit + count;
  return { offset: Math.floor(total / 8), bit: total % 8 };
}
