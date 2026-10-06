import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';
import { S7ConfigNode } from '../s7-config/s7-config-types';
import { parseAddress, toNodes7Address, splitAddresses } from '../../core/address-parser';
import { S7ReadItem, S7ReadResult, S7StructField, AREA_CODE_MAP } from '../../types/s7-address';
import { readValue, byteLength } from '../../core/data-converter';
import { createStatusUpdater } from '../shared/status-helper';
import { AddressEntry, evaluateProperty, toAddressEntries } from '../shared/msg-source';
import { handleConnectionAction } from '../shared/connection-action';
import { S7MsgDetailsExtra, s7Details } from '../shared/msg-details';

interface S7ReadNodeDef extends NodeDef {
  server: string;
  address: string;
  labels: string; // JSON-encoded Record<string, string> (address -> label)
  outputMode: 'single' | 'object' | 'buffer' | 'struct' | 'bits';
  topic: string;
  schema: string; // JSON-encoded S7StructField[]
  // Where the addresses and schema come from: 'config' (this node, the default) or a typedInput
  // type (msg, flow, global, env) with the property in addressProp / schemaProp
  addressType?: string;
  addressProp?: string;
  schemaType?: string;
  schemaProp?: string;
}

export = function (RED: NodeAPI): void {
  function S7ReadNodeConstructor(this: Node, config: S7ReadNodeDef): void {
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

    const addressType = config.addressType || 'config';
    const schemaType = config.schemaType || 'config';

    // The addresses to read: this node's list, or whatever the chosen msg/flow/global/env
    // property holds. Nothing else in the message can change them.
    const resolveAddresses = async (msg: NodeMessage): Promise<AddressEntry[]> => {
      if (addressType === 'config') {
        let labelMap: Record<string, string> = {};
        try {
          labelMap = JSON.parse(config.labels || '{}');
        } catch { /* ignore */ }
        return splitAddresses(config.address || '').map((address) => ({ address, label: labelMap[address] }));
      }
      const prop = config.addressProp || '';
      const value = await evaluateProperty(RED, this, msg, addressType, prop);
      return toAddressEntries(value, `${addressType}.${prop}`);
    };

    // For msg.s7: "config" for this node's list, else the property the addresses came from
    const source = addressType === 'config' ? 'config' : `${addressType}.${config.addressProp || ''}`;

    // buffer, bits and struct read one area, so they take exactly one address
    const singleAddress = (entries: AddressEntry[], mode: string): string => {
      if (entries.length === 0) throw new Error('No address specified');
      if (entries.length > 1) throw new Error(`${mode} output reads one address; got ${entries.length}`);
      return entries[0].address;
    };

    this.on('input', async (msg: NodeMessage, _send, done) => {
      const send = _send || ((m: NodeMessage) => this.send(m));
      const started = Date.now();

      // msg.action (with Dynamic control on) acts on the connection and does no PLC I/O
      if (await handleConnectionAction(serverNode, msg, send, done)) return;

      // msg.s7 for this read, built as the message is sent
      const details = (extra: S7MsgDetailsExtra) => s7Details(serverNode, 'read', started, { source, ...extra });

      try {
        const outputMode = config.outputMode || 'single';
        const entries = await resolveAddresses(msg);

        if (outputMode === 'buffer' || outputMode === 'bits') {
          const address = singleAddress(entries, outputMode);
          const parsed = parseAddress(address);
          const areaCode = AREA_CODE_MAP[parsed.area];
          if (areaCode === undefined) {
            done(new Error(`Unsupported area: ${parsed.area}`));
            return;
          }

          const length = parsed.arrayLength || byteLength(parsed.dataType, parsed.stringLength);
          const buffer = await serverNode.connectionManager.readRawArea(
            areaCode, parsed.dbNumber, parsed.offset, length
          );

          if (outputMode === 'buffer') {
            send({ ...msg, payload: buffer, s7: details({ address }) } as NodeMessage);
          } else {
            // bits mode: unpack each byte into boolean array (LSB first)
            const bits: boolean[] = [];
            for (let i = 0; i < buffer.length; i++) {
              const byte = buffer[i];
              for (let bit = 0; bit < 8; bit++) {
                bits.push((byte & (1 << bit)) !== 0);
              }
            }
            send({ ...msg, payload: bits, s7: details({ address }) } as NodeMessage);
          }

          done();
          return;
        }

        if (outputMode === 'struct') {
          const addressStr = singleAddress(entries, outputMode);

          // The schema from this node, or from the chosen msg/flow/global property
          const schemaSource = schemaType === 'config'
            ? config.schema
            : await evaluateProperty(RED, this, msg, schemaType, config.schemaProp || '');
          if (!schemaSource) {
            done(new Error('No schema specified'));
            return;
          }

          let schema: S7StructField[];
          try {
            schema = typeof schemaSource === 'string'
              ? JSON.parse(schemaSource)
              : schemaSource as S7StructField[];
          } catch {
            done(new Error('Invalid JSON in schema'));
            return;
          }

          if (!Array.isArray(schema) || schema.length === 0) {
            done(new Error('Schema must be a non-empty array'));
            return;
          }

          const validTypes: Set<string> = new Set([
            'BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'DINT', 'REAL', 'LREAL', 'CHAR', 'STRING',
            'USINT', 'UINT', 'UDINT', 'LINT', 'ULINT',
            'DATE', 'TIME', 'TIME_OF_DAY', 'DATE_AND_TIME', 'DT', 'DTZ', 'DTL', 'DTLZ', 'S5TIME',
            'WSTRING',
          ]);
          for (const field of schema) {
            if (!field.name || typeof field.name !== 'string') {
              done(new Error(`Schema field missing required "name" property`));
              return;
            }
            if (!field.type || !validTypes.has(field.type)) {
              done(new Error(`Schema field "${field.name}" has invalid type: "${field.type}"`));
              return;
            }
            if (field.offset === undefined || typeof field.offset !== 'number' || field.offset < 0) {
              done(new Error(`Schema field "${field.name}" has invalid offset: ${field.offset}`));
              return;
            }
          }

          const parsed = parseAddress(addressStr.trim());
          const areaCode = AREA_CODE_MAP[parsed.area];
          if (areaCode === undefined) {
            done(new Error(`Unsupported area: ${parsed.area}`));
            return;
          }

          // Calculate required buffer length from schema
          let requiredLength = 0;
          for (const field of schema) {
            const fieldEnd = field.offset + byteLength(field.type, field.length);
            if (fieldEnd > requiredLength) requiredLength = fieldEnd;
          }

          const buffer = await serverNode.connectionManager.readRawArea(
            areaCode, parsed.dbNumber, parsed.offset, requiredLength
          );

          const result: Record<string, unknown> = {};
          for (const field of schema) {
            result[field.name] = readValue(buffer, field.offset, field.type, field.bit ?? 0, {
              int64: serverNode.s7Config?.int64As,
            });
          }

          send({ ...msg, payload: result, s7: details({ address: addressStr }) } as NodeMessage);
          done();
          return;
        }

        // single/object modes
        if (entries.length === 0) {
          done(new Error('No address specified'));
          return;
        }

        const addresses = entries.map((e) => e.address);
        const items: S7ReadItem[] = addresses.map((a, i) => {
          const parsed = parseAddress(a);
          return {
            name: `item_${i}`,
            address: parsed,
            nodes7Address: toNodes7Address(parsed),
          };
        });

        const results: S7ReadResult[] = await serverNode.connectionManager.read(items);

        // A backend marks an address it couldn't read as bad instead of failing the whole read.
        // Fail when nothing could be read; otherwise send what was read and warn about the rest.
        const failed = results
          .map((r, i) => (r.quality === 'bad' ? `${addresses[i]} (${r.error ?? 'no value'})` : undefined))
          .filter((f): f is string => f !== undefined);
        if (results.length > 0 && failed.length === results.length) {
          done(new Error(`Read failed: ${failed.join(', ')}`));
          return;
        }
        if (failed.length > 0) {
          this.warn(`Read failed, sent as null: ${failed.join(', ')}`);
        }

        // One address is msg.s7.address; a keyed payload also gets msg.s7.addresses with the same keys
        const address = addresses.length === 1 ? addresses[0] : undefined;
        if (outputMode === 'object' || addresses.length > 1) {
          // Keyed by label (from this node's list, or an object of { label: address }), else address
          const payload: Record<string, unknown> = {};
          const keyed: Record<string, string> = {};
          for (let i = 0; i < results.length; i++) {
            const key = entries[i].label || addresses[i];
            payload[key] = results[i].value;
            keyed[key] = addresses[i];
          }
          send({ ...msg, payload, s7: details({ address, addresses: keyed }) } as NodeMessage);
        } else {
          send({ ...msg, payload: results[0]?.value ?? null, s7: details({ address }) } as NodeMessage);
        }

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

  RED.nodes.registerType('s7-read', S7ReadNodeConstructor);
};
