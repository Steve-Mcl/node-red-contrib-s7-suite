import { s7Details, serverLabel } from '../../../../src/nodes/shared/msg-details';
import { S7ConfigNode } from '../../../../src/nodes/s7-config/s7-config-types';

describe('msg.s7 details', () => {
  const server = (props: Record<string, unknown>) => props as unknown as S7ConfigNode;

  afterEach(() => jest.restoreAllMocks());

  it('names the server by its s7-config name, else host:port', () => {
    expect(serverLabel(server({ name: 'Line 1 PLC', s7Config: { host: '10.0.0.1', port: 102 } }))).toBe('Line 1 PLC');
    expect(serverLabel(server({ name: '', s7Config: { host: '10.0.0.1', port: 1102 } }))).toBe('10.0.0.1:1102');
    expect(serverLabel(server({}))).toBe('');
  });

  it('has only the fields that apply, in a fixed order', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1012);
    const node = server({ name: 'PLC' });
    expect(Object.keys(s7Details(node, 'status', 1000))).toEqual(['op', 'server', 'timestamp', 'durationMs']);
    const full = s7Details(node, 'read', 1000, {
      addresses: { a: 'DB1,INT0' }, address: 'DB1,INT0', source: 'config',
    });
    expect(Object.keys(full)).toEqual(['op', 'server', 'source', 'address', 'addresses', 'timestamp', 'durationMs']);
    expect(full).toEqual({
      op: 'read', server: 'PLC', source: 'config', address: 'DB1,INT0', addresses: { a: 'DB1,INT0' },
      timestamp: 1012, durationMs: 12,
    });
  });

  it('leaves out a field given as undefined', () => {
    const details = s7Details(server({ name: 'PLC' }), 'read', Date.now(), { source: 'config', address: undefined });
    expect('address' in details).toBe(false);
  });
});
