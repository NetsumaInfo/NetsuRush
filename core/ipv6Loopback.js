// @ts-check
// core/ipv6Loopback.js
// Second loopback socket for the core: [::1] on the same port, feeding the same HTTP server.
//
// On a machine with IPv6, `localhost` resolves to ::1 first. With nothing listening there, Windows
// takes ~200 ms to give up and fall back to 127.0.0.1 — on every new connection. The Adobe panel
// serves its grid media under `localhost` to get a connection pool of its own
// (src/lib/gridMediaOrigin.ts), and its probe refuses a name that slow, so without this socket the
// panel never gets that pool. Loopback only: nothing is exposed beyond 127.0.0.1's own reach.

const net = require("node:net");

/**
 * Accepts connections on [::1]:port and hands them to `server`, which keeps its own guards.
 * Never rejects: ::1 may be disabled, or the port taken there by another program.
 * @param {import('node:http').Server} server
 * @param {number} port
 * @returns {Promise<{ listener: net.Server | null, error: NodeJS.ErrnoException | null }>}
 */
function listenIpv6Loopback(server, port) {
  return new Promise((resolve) => {
    const listener = net.createServer((socket) => server.emit("connection", socket));
    listener.once("error", (error) => resolve({ listener: null, error }));
    listener.listen(port, "::1", () => resolve({ listener, error: null }));
  });
}

module.exports = { listenIpv6Loopback };
