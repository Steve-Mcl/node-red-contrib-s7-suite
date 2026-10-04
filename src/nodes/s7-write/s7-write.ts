import { NodeAPI, Node, NodeDef, NodeMessage } from 'node-red';
import { S7ConfigNode } from '../s7-config/s7-config-types';
import { parseAddress, toNodes7Address } from '../../core/address-parser';
import { S7WriteItem, S7StructField, AREA_CODE_MAP } from '../../types/s7-address';
import { writeValue, byteLength } from '../../core/data-converter';
import { createStatusUpdater } from '../shared/status-helper';
import { evaluateProperty } from '../shared/msg-source';
import { handleConnectionAction } from '../shared/connection-action';

interface S7WriteNodeDef extends NodeDef {
  server: string;
  address: string;
  mode: 'single' | 'multi' | 'struct';
  schema: string; // JSON-encoded S7StructField[]
  // typedInput type of `address`: 'str' (a fixed address, the default), msg, flow, global or env
  addressType?: string;
  // Where the schema comes from: 'config' (this node, the default), msg, flow or global
  schemaType?: string;
  schemaProp?: string;
}

export = function (RED: NodeAPI): void {
  function S7WriteNodeConstructor(this: Node, config: S7WriteNodeDef): void {
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

    const addressType = config.addressType || 'str';
    const schemaType = config.schemaType || 'config';

    // The address to write: the one typed into this node, or whatever the chosen msg/flow/global/env
    // property holds. Nothing else in the message can change it.
    const resolveAddress = async (msg: NodeMessage): Promise<string> => {
      if (addressType === 'str') return (config.address || '').trim();
      const value = await evaluateProperty(RED, this, msg, addressType, config.address || '');
      if (value === undefined || value === null || value === '') {
        throw new Error(`No address in ${addressType}.${config.address}`);
      }
      if (typeof value !== 'string') {
        throw new Error(`${addressType}.${config.address} must be an address string (got ${typeof value})`);
      }
      return value.trim();
    };

    this.on('input', async (msg: NodeMessage, _send, done) => {
      const send = _send || ((m: NodeMessage) => this.send(m));

      // msg.action (with Dynamic control on) acts on the connection and does no PLC I/O
      if (await handleConnectionAction(serverNode, msg, send, done)) return;

      try {
        const mode = config.mode || 'single';

        if (mode === 'multi') {
          // Multi-write: msg.payload is an object { address: value, ... }
          const payload = msg.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            done(new Error('Multi-write mode requires msg.payload to be an object { address: value }'));
            return;
          }

          const entries = Object.entries(payload);
          if (entries.length === 0) {
            done(new Error('Multi-write payload is empty'));
            return;
          }

          const items: S7WriteItem[] = entries.map(([addr, value], i) => {
            const parsed = parseAddress(addr);
            return {
              name: `item_${i}`,
              address: parsed,
              nodes7Address: toNodes7Address(parsed),
              value,
            };
          });

          await serverNode.connectionManager.write(items);
          send(msg);
          done();
          return;
        }

        if (mode === 'struct') {
          // Struct-write: read-modify-write using schema
          const addressStr = await resolveAddress(msg);
          if (!addressStr) {
            done(new Error('No base address specified'));
            return;
          }

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

          const payload = msg.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            done(new Error('Struct-write mode requires msg.payload to be an object'));
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
              done(new Error('Schema field missing required "name" property'));
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

          const baseParsed = parseAddress(addressStr.trim());
          const areaCode = AREA_CODE_MAP[baseParsed.area];
          if (areaCode === undefined) {
            done(new Error(`Unsupported area: ${baseParsed.area}`));
            return;
          }

          // Calculate required buffer length from schema
          let requiredLength = 0;
          for (const field of schema) {
            const fieldEnd = field.offset + byteLength(field.type, field.length);
            if (fieldEnd > requiredLength) requiredLength = fieldEnd;
          }

          // Read current buffer (read-modify-write for BOOL support)
          const buffer = await serverNode.connectionManager.readRawArea(
            areaCode, baseParsed.dbNumber, baseParsed.offset, requiredLength
          );

          // Write each matching field into the buffer
          const fieldsToWrite: S7StructField[] = [];
          for (const field of schema) {
            if (field.name in payload) {
              writeValue(buffer, field.offset, field.type, payload[field.name], field.bit ?? 0);
              fieldsToWrite.push(field);
            }
          }

          if (fieldsToWrite.length === 0) {
            done(new Error('No fields in msg.payload match the schema'));
            return;
          }

          // Build individual S7WriteItem for each modified field and write via connectionManager
          const items: S7WriteItem[] = fieldsToWrite.map((field, i) => {
            const fieldAddress = {
              ...baseParsed,
              dataType: field.type,
              offset: baseParsed.offset + field.offset,
              bitOffset: field.bit ?? 0,
              stringLength: field.length,
            };
            return {
              name: `struct_${i}`,
              address: fieldAddress,
              nodes7Address: toNodes7Address(fieldAddress),
              value: payload[field.name],
            };
          });

          await serverNode.connectionManager.write(items);
          send(msg);
          done();
          return;
        }

        // Single mode (default)
        const addressStr = await resolveAddress(msg);
        if (!addressStr) {
          done(new Error('No address specified'));
          return;
        }

        if (msg.payload === undefined || msg.payload === null) {
          done(new Error('msg.payload is required for single write mode'));
          return;
        }
        const parsed = parseAddress(addressStr);
        const pType = typeof msg.payload;
        // An address with a length (DB1,INT20.3) takes an array, or a Buffer for bytes; the backend
        // checks the length
        const isMany = Array.isArray(msg.payload) || Buffer.isBuffer(msg.payload);
        if (isMany && parsed.arrayLength === undefined) {
          done(new Error(`An array or Buffer needs an address with a length, e.g. DB1,BYTE0.4 (got ${addressStr})`));
          return;
        }
        if (!isMany && pType !== 'number' && pType !== 'boolean' && pType !== 'string' && pType !== 'bigint') {
          done(new Error(`msg.payload must be a number, boolean, string, or bigint for single write mode (got ${pType})`));
          return;
        }

        const items: S7WriteItem[] = [
          {
            name: 'item_0',
            address: parsed,
            nodes7Address: toNodes7Address(parsed),
            value: msg.payload,
          },
        ];

        await serverNode.connectionManager.write(items);

        // Pass-through on success
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

  RED.nodes.registerType('s7-write', S7WriteNodeConstructor);
};
