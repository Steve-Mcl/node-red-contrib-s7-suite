import { nextAddress, nextSchemaField } from '../../../src/core/next-address';
import { parseAddress } from '../../../src/core/address-parser';

describe('nextAddress', () => {
  it.each([
    // nodes7 DB notation: the next value of the same type
    ['DB1,REAL0', 'DB1,REAL4'],
    ['DB1,INT10', 'DB1,INT12'],
    ['DB1,BYTE7', 'DB1,BYTE8'],
    ['DB1,CHAR3', 'DB1,CHAR4'],
    ['DB1,LREAL8', 'DB1,LREAL16'],
    ['DB1,DTL0', 'DB1,DTL12'],
    ['DB2,DATE_AND_TIME0', 'DB2,DATE_AND_TIME8'],
    // bits, wrapping into the next byte
    ['DB1,X0.3', 'DB1,X0.4'],
    ['DB1,X0.7', 'DB1,X1.0'],
    ['DB1,BOOL4.7', 'DB1,BOOL5.0'],
    ['DB1,X10.3.8', 'DB1,X11.3.8'],
    // arrays move past the whole array, keeping the suffix as written
    ['DB1,BYTE0.10', 'DB1,BYTE10.10'],
    ['DB1,BYTE0.0.4', 'DB1,BYTE4.0.4'],
    ['DB1,INT20.3', 'DB1,INT26.3'],
    // strings: max length + 2 header bytes (WSTRING: 2 per char + 4)
    ['DB1,STRING10.20', 'DB1,STRING32.20'],
    ['DB1,STRING0', 'DB1,STRING256'],
    ['DB1,WSTRING0.10', 'DB1,WSTRING24.10'],
    // IEC DB notation
    ['DB1.DBD0', 'DB1.DBD4'],
    ['DB1.DBW2', 'DB1.DBW4'],
    ['DB1.DBB9', 'DB1.DBB10'],
    ['DB1.DBX0.7', 'DB1.DBX1.0'],
    // areas
    ['MW10', 'MW12'],
    ['MD4', 'MD8'],
    ['MB7', 'MB8'],
    ['M10', 'M11'],
    ['QB0.4', 'QB4.4'],
    ['I0.7', 'I1.0'],
    ['Q1.2', 'Q1.3'],
    ['M10.3.8', 'M11.3.8'],
    ['MX0.7', 'MX1.0'],
    // counters and timers are numbered
    ['C5', 'C6'],
    ['T0', 'T1'],
  ])('%s is followed by %s', (previous, expected) => {
    expect(nextAddress(previous)).toBe(expected);
  });

  it('starts anything wider than a byte, and strings and arrays, on an even byte in a DB', () => {
    expect(nextAddress('DB1,INT1')).toBe('DB1,INT4');
    expect(nextAddress('DB1,STRING10.21')).toBe('DB1,STRING34.21'); // 10 + 23, rounded up
    expect(nextAddress('DB1,BYTE0.3')).toBe('DB1,BYTE4.3');
    expect(nextAddress('DB1,BYTE1')).toBe('DB1,BYTE2'); // a single byte isn't aligned
  });

  it('does not align raw memory addresses', () => {
    expect(nextAddress('MW1')).toBe('MW3');
    expect(nextAddress('DB1.DBW1')).toBe('DB1.DBW3');
  });

  it('keeps the case and spacing the user typed', () => {
    expect(nextAddress('db1,real0')).toBe('db1,real4');
    expect(nextAddress('  mw10 ')).toBe('mw12');
  });

  it('returns null for anything that is not an address', () => {
    for (const bad of ['', '   ', 'foo', 'DB0,REAL0', 'DB1,REAL', 'DB1,X0.9']) {
      expect(nextAddress(bad)).toBeNull();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(nextAddress(undefined as any)).toBeNull();
  });

  it('always suggests an address the parser accepts', () => {
    for (const a of ['DB1,REAL0', 'DB1,X0.7', 'DB1,STRING10.20', 'DB1.DBX0.7', 'MW10', 'I0.7', 'C5', 'DB1,BYTE0.10']) {
      const next = nextAddress(a) as string;
      expect(() => parseAddress(next)).not.toThrow();
    }
  });
});

describe('nextSchemaField', () => {
  it.each([
    // same type at the next free offset
    [{ type: 'REAL', offset: 0 }, { type: 'REAL', offset: 4 }],
    [{ type: 'INT', offset: 4 }, { type: 'INT', offset: 6 }],
    [{ type: 'LREAL', offset: 8 }, { type: 'LREAL', offset: 16 }],
    [{ type: 'DTL', offset: 0 }, { type: 'DTL', offset: 12 }],
    [{ type: 'BYTE', offset: 3 }, { type: 'BYTE', offset: 4 }],
    // a string keeps its max length: STRING[10] at 2 is 12 bytes, so the next starts at 14
    [{ type: 'STRING', offset: 2, length: 10 }, { type: 'STRING', offset: 14, length: 10 }],
    [{ type: 'STRING', offset: 0, length: 11 }, { type: 'STRING', offset: 14, length: 11 }], // 13, rounded up
    [{ type: 'WSTRING', offset: 0, length: 10 }, { type: 'WSTRING', offset: 24, length: 10 }],
    [{ type: 'STRING', offset: 0 }, { type: 'STRING', offset: 256 }], // no length: STRING[254]
    // a BOOL moves to the next bit, wrapping into the next byte
    [{ type: 'BOOL', offset: 6, bit: 0 }, { type: 'BOOL', offset: 6, bit: 1 }],
    [{ type: 'BOOL', offset: 6, bit: 7 }, { type: 'BOOL', offset: 7, bit: 0 }],
    [{ type: 'BOOL', offset: 2 }, { type: 'BOOL', offset: 2, bit: 1 }],
    // wider than a byte starts on an even byte
    [{ type: 'INT', offset: 3 }, { type: 'INT', offset: 6 }],
    // the editor sends what the row holds: a hidden bit or length on other types is ignored
    [{ type: 'REAL', offset: 0, bit: 3, length: 20 }, { type: 'REAL', offset: 4 }],
    [{ type: 'real', offset: 0 }, { type: 'REAL', offset: 4 }],
  ])('%j is followed by %j', (previous, expected) => {
    expect(nextSchemaField(previous)).toEqual(expected);
  });

  it('returns null without a usable type or offset', () => {
    expect(nextSchemaField({ type: 'NOPE', offset: 0 })).toBeNull();
    expect(nextSchemaField({ type: '', offset: 0 })).toBeNull();
    expect(nextSchemaField({ type: 'REAL', offset: -1 })).toBeNull();
    expect(nextSchemaField({ type: 'REAL', offset: 1.5 })).toBeNull();
    expect(nextSchemaField({ type: 'REAL', offset: NaN })).toBeNull();
    expect(nextSchemaField({ type: 'BOOL', offset: 0, bit: 8 })).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(nextSchemaField(undefined as any)).toBeNull();
  });
});