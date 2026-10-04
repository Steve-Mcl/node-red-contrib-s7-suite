import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';
import { S7ConfigNode } from '../s7-config/s7-config-types';
import { parseAddress, toNodes7Address, splitAddresses } from '../../core/address-parser';
import { Poller, EdgeMode } from '../../core/poller';
import { S7ReadItem, S7ReadResult } from '../../types/s7-address';
import { statusForState } from '../shared/status-helper';

interface S7TriggerNodeDef extends NodeDef {
  server: string;
  address: string;
  interval: number | string;
  edgeMode: EdgeMode;
  deadband: number | string;
  // TypedInput type of interval / deadband: 'num' (the default, also when absent) or 'env'
  intervalType?: 'num' | 'env';
  deadbandType?: 'num' | 'env';
}

export = function (RED: NodeAPI): void {
  function S7TriggerNodeConstructor(this: Node, config: S7TriggerNodeDef): void {
    RED.nodes.createNode(this, config);

    const serverNode = RED.nodes.getNode(config.server) as S7ConfigNode | null;
    if (!serverNode) {
      this.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }

    serverNode.registerChildNode(this);

    if (!config.address) {
      this.status({ fill: 'red', shape: 'ring', text: 'no address' });
      return;
    }

    const addresses = splitAddresses(config.address);
    let items: S7ReadItem[];
    try {
      items = addresses.map((a, i) => {
        const parsed = parseAddress(a);
        return {
          name: `item_${i}`,
          address: parsed,
          nodes7Address: toNodes7Address(parsed),
        };
      });
    } catch (err) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid address' });
      this.error(`Invalid address: ${err instanceof Error ? err.message : String(err)}`);
      serverNode.deregisterChildNode(this);
      return;
    }

    // Interval and deadband are numbers, or (type env) the name of an environment variable holding
    // one. As on s7-config, an unset or unusable variable is an error rather than a silent default.
    const settingErrors: string[] = [];
    const numberSetting = (
      field: 'interval' | 'deadband', fallback: number, isValid: (n: number) => boolean, expected: string,
    ): number => {
      const type = field === 'interval' ? config.intervalType : config.deadbandType;
      // The editor delivers typed-in values as strings - coerce them, as before
      if (type !== 'env') return Number(config[field]) || fallback;
      const varName = String(config[field] ?? '').trim();
      const raw = varName ? RED.util.evaluateNodeProperty(varName, 'env', this, {}) : undefined;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        settingErrors.push(`${field}: environment variable "${varName}" is not set`);
        return fallback;
      }
      const n = Number(String(raw).trim());
      if (!isValid(n)) {
        settingErrors.push(`${field}: environment variable "${varName}" is "${raw}", not ${expected}`);
        return fallback;
      }
      return n;
    };
    const interval = numberSetting('interval', 1000, (n) => Number.isInteger(n) && n >= 1, 'a whole number of ms, 1 or more');
    const deadband = numberSetting('deadband', 0, (n) => Number.isFinite(n) && n >= 0, 'a number, 0 or more');
    if (settingErrors.length > 0) {
      this.status({ fill: 'red', shape: 'ring', text: 'invalid setting' });
      this.error(`Invalid setting: ${settingErrors.join('; ')}`);
      serverNode.deregisterChildNode(this);
      return;
    }

    const poller = new Poller({
      interval,
      edgeMode: config.edgeMode || 'any',
      deadband,
    });

    for (const item of items) {
      poller.addItem(item.name);
    }

    poller.setReadFunction(async () => {
      const results: S7ReadResult[] = await serverNode.connectionManager.read(items);
      const map = new Map<string, unknown>();
      for (const r of results) {
        map.set(r.name, r.value);
      }
      return map;
    });

    poller.on('changed', ({ name, value, oldValue }) => {
      const index = parseInt(name.replace('item_', ''), 10);
      const addr = addresses[index] || name;
      const msg: NodeMessage = {
        topic: addr,
        payload: value,
        _msgid: '',
      };
      (msg as Record<string, unknown>).oldValue = oldValue;
      this.send(msg);
    });

    poller.on('error', (err: Error) => {
      this.error(err.message);
    });

    const updateStatus = ({ newState }: { newState: string }) => {
      this.status(
        statusForState(newState, { connectedText: () => `polling ${interval}ms` }),
      );
      if (newState === 'connected') {
        if (!poller.isRunning()) poller.start();
      } else {
        poller.stop();
      }
    };

    serverNode.connectionManager.on('stateChanged', updateStatus);
    updateStatus({ newState: serverNode.connectionManager.getState() });

    this.on('close', (done: () => void) => {
      poller.stop();
      poller.removeAllListeners();
      if (serverNode) {
        serverNode.deregisterChildNode(this);
        serverNode.connectionManager.removeListener('stateChanged', updateStatus);
      }
      done();
    });
  }

  RED.nodes.registerType('s7-trigger', S7TriggerNodeConstructor);
};
