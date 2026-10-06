import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';
import { S7ConfigNode } from '../s7-config/s7-config-types';
import { createStatusUpdater } from '../shared/status-helper';
import { handleConnectionAction } from '../shared/connection-action';
import { s7Details } from '../shared/msg-details';

type ControlAction = 'start' | 'stop' | 'coldstart' | 'reset';

interface S7ControlNodeDef extends NodeDef {
  server: string;
  action: ControlAction;
}

export = function (RED: NodeAPI): void {
  function S7ControlNodeConstructor(this: Node, config: S7ControlNodeDef): void {
    RED.nodes.createNode(this, config);

    const serverNode = RED.nodes.getNode(config.server) as S7ConfigNode | null;
    if (!serverNode) {
      this.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }

    serverNode.registerChildNode(this);

    const updateStatus = createStatusUpdater(this);

    serverNode.connectionManager.on('stateChanged', updateStatus);
    updateStatus({ newState: serverNode.connectionManager.getState() });

    this.on('input', async (msg: NodeMessage, _send, done) => {
      const send = _send || ((m: NodeMessage) => this.send(m));
      const started = Date.now();

      // msg.action (with Dynamic control on) acts on the connection and does no PLC I/O
      if (await handleConnectionAction(serverNode, msg, send, done)) return;

      try {
        const action = ((msg.payload as string) || config.action || 'stop').toLowerCase() as ControlAction;
        const backend = serverNode.connectionManager.getBackend();

        let methodName: 'plcStart' | 'plcStop' | 'plcColdStart';

        switch (action) {
          case 'start':
            methodName = 'plcStart';
            break;
          case 'stop':
            methodName = 'plcStop';
            break;
          case 'coldstart':
          case 'reset':
            methodName = 'plcColdStart';
            break;
          default:
            done(new Error(`Unknown action: ${action}. Use start, stop, coldstart, or reset.`));
            return;
        }

        if (typeof backend[methodName] !== 'function') {
          done(new Error(`${methodName} is not supported by the current backend. Use the snap7 backend for CPU control.`));
          return;
        }

        await backend[methodName]!();

        msg.payload = { action, success: true };
        // Replaces any msg.s7 from an earlier S7 node, which would describe that node's work
        (msg as Record<string, unknown>).s7 = s7Details(serverNode, 'control', started);
        send(msg);
        done();
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.on('close', () => {
      if (serverNode) {
        serverNode.deregisterChildNode(this);
        serverNode.connectionManager.removeListener('stateChanged', updateStatus);
      }
    });
  }

  RED.nodes.registerType('s7-control', S7ControlNodeConstructor);
};
