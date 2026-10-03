import { parseAddress, toNodes7Address } from '../../../src/core/address-parser';
import { S7Address } from '../../../src/types';

describe('address-parser', () => {
  describe('parseAddress - nodes7 style', () => {
    it('parses DB with REAL type', () => {
      const addr = parseAddress('DB1,REAL0');
      expect(addr).toEqual({
        area: 'DB',
        dbNumber: 1,
        dataType: 'REAL',
        offset: 0,
        bitOffset: 0,
        arrayLength: undefined,
      });
    });

    it('parses DB with BOOL and bit offset', () => {
      const addr = parseAddress('DB10,BOOL4.3');
      expect(addr).toEqual({
        area: 'DB',
        dbNumber: 10,
        dataType: 'BOOL',
        offset: 4,
        bitOffset: 3,
        arrayLength: undefined,
      });
    });

    it('parses DB with INT type', () => {
      const addr = parseAddress('DB5,INT10');
      expect(addr.area).toBe('DB');
      expect(addr.dbNumber).toBe(5);
      expect(addr.dataType).toBe('INT');
      expect(addr.offset).toBe(10);
    });

    it('parses DB with BYTE array', () => {
      const addr = parseAddress('DB1,BYTE0.10');
      expect(addr.dataType).toBe('BYTE');
      expect(addr.offset).toBe(0);
      expect(addr.arrayLength).toBe(10);
    });

    it('parses DB with DINT type', () => {
      const addr = parseAddress('DB100,DINT20');
      expect(addr.dbNumber).toBe(100);
      expect(addr.dataType).toBe('DINT');
      expect(addr.offset).toBe(20);
    });

    it('parses DB with WORD type', () => {
      const addr = parseAddress('DB2,WORD4');
      expect(addr.dataType).toBe('WORD');
    });

    it('parses DB with DWORD type', () => {
      const addr = parseAddress('DB2,DWORD8');
      expect(addr.dataType).toBe('DWORD');
    });

    it('parses DB with LREAL type', () => {
      const addr = parseAddress('DB3,LREAL0');
      expect(addr.dataType).toBe('LREAL');
    });

    it('parses DB with CHAR type', () => {
      const addr = parseAddress('DB1,CHAR5');
      expect(addr.dataType).toBe('CHAR');
    });

    it('parses DB with STRING type', () => {
      const addr = parseAddress('DB1,STRING10');
      expect(addr.dataType).toBe('STRING');
      expect(addr.offset).toBe(10);
    });

    describe('the numbers after the offset depend on the type', () => {
      it.each([
        ['DB1,BYTE10.4', 4], ['DB1,REAL0.3', 3], ['DB1,BYTE10.12', 12], ['DB1,BYTE10.0.4', 4], ['DB1,INT0.0.3', 3],
      ])('reads %s as a count of %i', (address, count) => {
        const addr = parseAddress(address);
        expect(addr.arrayLength).toBe(count);
        expect(addr.bitOffset).toBe(0);
      });

      it('sends a count to nodes7 in its own form', () => {
        expect(toNodes7Address(parseAddress('DB1,BYTE10.4'))).toBe('DB1,BYTE10.4');
        expect(toNodes7Address(parseAddress('DB1,REAL0.0.3'))).toBe('DB1,REAL0.3');
      });

      it('reads a BOOL as a bit, then a count of bits', () => {
        expect(parseAddress('DB1,BOOL10.3')).toMatchObject({ bitOffset: 3, arrayLength: undefined });
        expect(parseAddress('DB1,BOOL10.3.8')).toMatchObject({ bitOffset: 3, arrayLength: 8 });
      });

      it('refuses a bit offset on a type that has no bits', () => {
        expect(() => parseAddress('DB1,REAL0.3.2')).toThrow('Only a BOOL takes a bit offset; for 2 values write .2');
      });

      it('refuses a BOOL bit outside 0-7 and a count of 0', () => {
        expect(() => parseAddress('DB1,BOOL10.12')).toThrow('Bit offset must be 0-7 for BOOL');
        expect(() => parseAddress('DB1,BYTE10.0')).toThrow('Count must be at least 1');
      });

      it('leaves a STRING suffix to the string rules', () => {
        // A STRING's suffix is its length (#44), never a bit offset or a count of strings here
        expect(parseAddress('DB1,STRING50.5').bitOffset).toBe(0);
        expect(parseAddress('DB1,STRING50.20').bitOffset).toBe(0);
      });
    });

    it('is case-insensitive', () => {
      const addr = parseAddress('db1,real0');
      expect(addr.area).toBe('DB');
      expect(addr.dataType).toBe('REAL');
    });

    it('trims whitespace', () => {
      const addr = parseAddress('  DB1,REAL0  ');
      expect(addr.area).toBe('DB');
    });
  });

  describe('parseAddress - IEC style', () => {
    it('parses DBX (BOOL)', () => {
      const addr = parseAddress('DB1.DBX0.5');
      expect(addr).toEqual({
        area: 'DB',
        dbNumber: 1,
        dataType: 'BOOL',
        offset: 0,
        bitOffset: 5,
      });
    });

    it('parses DBB (BYTE)', () => {
      const addr = parseAddress('DB1.DBB10');
      expect(addr.dataType).toBe('BYTE');
      expect(addr.offset).toBe(10);
    });

    it('parses DBW (WORD)', () => {
      const addr = parseAddress('DB5.DBW20');
      expect(addr.dataType).toBe('WORD');
      expect(addr.offset).toBe(20);
    });

    it('parses DBD (DWORD)', () => {
      const addr = parseAddress('DB3.DBD4');
      expect(addr.dataType).toBe('DWORD');
      expect(addr.offset).toBe(4);
    });
  });

  describe('parseAddress - suffix on area and IEC addresses', () => {
    it('reads a sized area address with one number as a count, like nodes7', () => {
      expect(parseAddress('QB0.4')).toMatchObject({ dataType: 'BYTE', bitOffset: 0, arrayLength: 4 });
      expect(parseAddress('MW0.0.3')).toMatchObject({ dataType: 'WORD', bitOffset: 0, arrayLength: 3 });
      expect(toNodes7Address(parseAddress('QB0.4'))).toBe('QB0.4');
    });

    it('keeps an area address with no size letter as a bit', () => {
      expect(parseAddress('Q0.1')).toMatchObject({ dataType: 'BOOL', bitOffset: 1 });
      expect(parseAddress('M10.3.8')).toMatchObject({ dataType: 'BOOL', bitOffset: 3, arrayLength: 8 });
    });

    it('refuses a bit offset on a byte or word', () => {
      expect(() => parseAddress('MW0.3.2')).toThrow('Only a BOOL takes a bit offset');
      expect(() => parseAddress('DB1.DBB10.3')).toThrow('Only DBX takes a bit offset');
    });
  });

  describe('parseAddress - area style', () => {
    it('parses M with bit (BOOL)', () => {
      const addr = parseAddress('M0.1');
      expect(addr).toEqual({
        area: 'M',
        dbNumber: 0,
        dataType: 'BOOL',
        offset: 0,
        bitOffset: 1,
      });
    });

    it('parses MB (BYTE)', () => {
      const addr = parseAddress('MB10');
      expect(addr.area).toBe('M');
      expect(addr.dataType).toBe('BYTE');
      expect(addr.offset).toBe(10);
    });

    it('parses MW (WORD)', () => {
      const addr = parseAddress('MW20');
      expect(addr.dataType).toBe('WORD');
    });

    it('parses MD (DWORD)', () => {
      const addr = parseAddress('MD0');
      expect(addr.dataType).toBe('DWORD');
    });

    it('parses I area', () => {
      const addr = parseAddress('IB0');
      expect(addr.area).toBe('I');
      expect(addr.dataType).toBe('BYTE');
    });

    it('parses Q area', () => {
      const addr = parseAddress('QB0');
      expect(addr.area).toBe('Q');
    });

    it('parses bare M as BYTE', () => {
      const addr = parseAddress('M10');
      expect(addr.area).toBe('M');
      expect(addr.dataType).toBe('BYTE');
      expect(addr.offset).toBe(10);
    });

    it('parses I with bit (BOOL)', () => {
      const addr = parseAddress('I0.0');
      expect(addr.area).toBe('I');
      expect(addr.dataType).toBe('BOOL');
      expect(addr.bitOffset).toBe(0);
    });
  });

  describe('parseAddress - errors', () => {
    it('throws on invalid address', () => {
      expect(() => parseAddress('INVALID')).toThrow('Cannot parse address');
    });

    it('throws on empty string', () => {
      expect(() => parseAddress('')).toThrow('Cannot parse address');
    });
  });

  describe('toNodes7Address', () => {
    it('converts DB REAL address', () => {
      const addr: S7Address = {
        area: 'DB',
        dbNumber: 1,
        dataType: 'REAL',
        offset: 0,
        bitOffset: 0,
      };
      expect(toNodes7Address(addr)).toBe('DB1,REAL0');
    });

    it('converts DB BOOL address with bit offset', () => {
      const addr: S7Address = {
        area: 'DB',
        dbNumber: 10,
        dataType: 'BOOL',
        offset: 4,
        bitOffset: 3,
      };
      expect(toNodes7Address(addr)).toBe('DB10,BOOL4.3');
    });

    it('converts DB BYTE array', () => {
      const addr: S7Address = {
        area: 'DB',
        dbNumber: 1,
        dataType: 'BYTE',
        offset: 0,
        bitOffset: 0,
        arrayLength: 10,
      };
      expect(toNodes7Address(addr)).toBe('DB1,BYTE0.10');
    });

    it('converts M BOOL address', () => {
      const addr: S7Address = {
        area: 'M',
        dbNumber: 0,
        dataType: 'BOOL',
        offset: 0,
        bitOffset: 1,
      };
      expect(toNodes7Address(addr)).toBe('M0.1');
    });

    it('converts MB address', () => {
      const addr: S7Address = {
        area: 'M',
        dbNumber: 0,
        dataType: 'BYTE',
        offset: 10,
        bitOffset: 0,
      };
      expect(toNodes7Address(addr)).toBe('MB10');
    });

    it('converts MW address', () => {
      const addr: S7Address = {
        area: 'M',
        dbNumber: 0,
        dataType: 'WORD',
        offset: 20,
        bitOffset: 0,
      };
      expect(toNodes7Address(addr)).toBe('MW20');
    });

    it('converts IB address', () => {
      const addr: S7Address = {
        area: 'I',
        dbNumber: 0,
        dataType: 'BYTE',
        offset: 0,
        bitOffset: 0,
      };
      expect(toNodes7Address(addr)).toBe('IB0');
    });
  });
});
