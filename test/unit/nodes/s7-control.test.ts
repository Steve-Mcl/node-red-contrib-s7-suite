import { EventEmitter } from 'events';
import { ConnectionManager } from '../../../src/core/connection-manager';
import { MockBackend } from '../../helpers/mock-backend';

import s7ControlModule = require('../../../src/nodes/s7-control/s7-control');

describe('s7-control node', () => {
  let registeredType: string;
  let constructorFn: Function;
  let mockBackend: MockBackend & { plcStop?: jest.Mock; plcStart?: jest.Mock };
  let connManager: ConnectionManager;

  const mockRED = {
    nodes: {
      createNode: jest.fn(),
      registerType: jest.fn((type: string, constructor: Function) => {
        registeredType = type;
        constructorFn = constructor;
      }),
      getNode: jest.fn(),
    },
  };

  function createServerNode() {
    mockBackend = new MockBackend();
    connManager = new ConnectionManager(mockBackend, {
      host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'snap7',
    });
    return { name: 'PLC 1', connectionManager: connManager, registerChildNode: jest.fn(), deregisterChildNode: jest.fn() };
  }

  function createNodeContext() {
    return Object.assign(new EventEmitter(), { status: jest.fn(), send: jest.fn(), error: jest.fn() });
  }

  async function run(msg: Record<string, unknown>, action = 'stop') {
    const node = createNodeContext();
    constructorFn.call(node, { id: 'ctl1', type: 's7-control', server: 'config1', action });
    const send = jest.fn();
    const done = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (node as any).listeners('input')[0](msg, send, done);
    return { send, done };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s7ControlModule(mockRED as any);
    mockRED.nodes.getNode.mockReturnValue(createServerNode());
  });

  it('registers the s7-control type', () => {
    expect(registeredType).toBe('s7-control');
  });

  it('runs the configured command and sets msg.s7, replacing one from an earlier S7 node', async () => {
    mockBackend.plcStop = jest.fn().mockResolvedValue(undefined);
    const { send, done } = await run({ _msgid: '1', s7: { op: 'read', address: 'DB1,INT0' } });
    expect(mockBackend.plcStop).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      _msgid: '1',
      payload: { action: 'stop', success: true },
      s7: { op: 'control', server: 'PLC 1', timestamp: expect.any(Number), durationMs: expect.any(Number) },
    });
    expect(done).toHaveBeenCalledWith();
  });

  it('takes the command from msg.payload', async () => {
    mockBackend.plcStart = jest.fn().mockResolvedValue(undefined);
    const { send } = await run({ _msgid: '1', payload: 'start' });
    expect(mockBackend.plcStart).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].payload).toEqual({ action: 'start', success: true });
  });

  it('refuses when the backend has no CPU control, and sends nothing', async () => {
    const { send, done } = await run({ _msgid: '1' });
    expect(send).not.toHaveBeenCalled();
    expect(done.mock.calls[0][0].message).toBe('plcStop is not supported by the current backend. Use the snap7 backend for CPU control.');
  });

  it('refuses an unknown command', async () => {
    const { send, done } = await run({ _msgid: '1', payload: 'explode' });
    expect(send).not.toHaveBeenCalled();
    expect(done.mock.calls[0][0].message).toMatch(/^Unknown action: explode/);
  });

  it('reports a command the PLC refuses, and sends nothing', async () => {
    mockBackend.plcStop = jest.fn().mockRejectedValue(new Error('PlcStop failed: CPU : Cannot stop PLC'));
    const { send, done } = await run({ _msgid: '1' });
    expect(send).not.toHaveBeenCalled();
    expect(done.mock.calls[0][0].message).toBe('PlcStop failed: CPU : Cannot stop PLC');
  });
});
