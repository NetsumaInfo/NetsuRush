// Shared wire-level test client. Speaks the protocol like the C++ client: one
// socket, sequential requests, framed reads.
import { connect } from 'node:net';

import { MessageReader, MessageType, encodeMessage } from '../../fake-renderer/protocol.mjs';

export function protocolClient(port) {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  const reader = new MessageReader();
  const inbox = [];
  const waiters = [];
  let ended = false;

  socket.on('data', (chunk) => {
    reader.push(chunk);
    for (const message of reader.drain()) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.push(message);
    }
  });
  const finish = () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection closed'));
  };
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send(message) {
      socket.write(encodeMessage(message));
    },
    next() {
      if (inbox.length > 0) return Promise.resolve(inbox.shift());
      if (ended) return Promise.reject(new Error('connection closed'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    closed: new Promise((resolve) => socket.on('close', resolve)),
    destroy: () => socket.destroy(),
  };
}

export async function hello(client, token, requestId = 1) {
  client.send({
    type: MessageType.HELLO,
    requestId,
    metadata: { token, client: 'test', instanceId: 't' },
  });
  return client.next();
}
