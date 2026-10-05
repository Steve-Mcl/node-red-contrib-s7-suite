import { NodeMessage } from 'node-red';
import { S7ConfigNode } from '../s7-config/s7-config-types';
import { s7Details } from './msg-details';

/** What msg.action can ask of the connection. */
export const CONNECTION_ACTIONS = ['connect', 'disconnect', 'reconnect', 'status'] as const;
export type ConnectionAction = typeof CONNECTION_ACTIONS[number];

/**
 * Runs msg.action against the node's connection, when its s7-config has Dynamic control on.
 * With it off, msg.action is ignored and the message is read or written as usual, so turning the
 * feature on is the only thing that can change how an existing flow behaves.
 *
 * Returns true when the message was an action (done has been called, success or not), so the
 * caller must stop; false to carry on with its normal work. An action does no PLC I/O. A finished
 * action sends the message on with the connection report; a failed one only reports the error.
 */
export async function handleConnectionAction(
  serverNode: S7ConfigNode,
  msg: NodeMessage,
  send: (msg: NodeMessage) => void,
  done: (err?: Error) => void,
): Promise<boolean> {
  const action = (msg as Record<string, unknown>).action;
  if (action === undefined || action === null || action === '') return false;
  if (!serverNode.allowDynamic) return false;

  if (typeof action !== 'string' || !(CONNECTION_ACTIONS as readonly string[]).includes(action)) {
    done(new Error(`Invalid msg.action ${JSON.stringify(action)}. Expected one of: ${CONNECTION_ACTIONS.join(', ')}`));
    return true;
  }

  const started = Date.now();
  const connection = serverNode.connectionManager;
  try {
    switch (action as ConnectionAction) {
      case 'status':
        break;
      case 'disconnect':
        await connection.disconnect();
        break;
      case 'connect':
      case 'reconnect':
        // Settings that can't be used would only fail again, with a less helpful error
        if (serverNode.configError) throw new Error(`Invalid S7 config: ${serverNode.configError}`);
        await (action === 'connect' ? connection.connect() : connection.reconnect());
        break;
    }
    // Every action sends the message on once it has finished, with the connection report as it is
    // now. msg.action is dropped so the reply can't act again on the next S7 node; msg.s7.op says
    // which action it was.
    const out: Record<string, unknown> = {
      ...msg,
      payload: serverNode.getStatus(),
      s7: s7Details(serverNode, action, started),
    };
    delete out.action;
    send(out as NodeMessage);
    done();
  } catch (err) {
    done(err instanceof Error ? err : new Error(String(err)));
  }
  return true;
}
