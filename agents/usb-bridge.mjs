// Run after: adb -s SERIAL forward tcp:18444 tcp:18444
// The board initiates and verifies HTTPS end to end through this raw relay.
import net from 'node:net';
const server = process.env.POSEGUARD_HOST || 'poseguard.nanaoni.tech';
const port = Number(process.env.POSEGUARD_USB_PORT || 18444);
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  process.exit(0);
});
function connect() {
  if (stopping) return;
  const board = net.connect({ host: '127.0.0.1', port });
  let cloud;
  let once = false;
  const retry = () => {
    if (once) return;
    once = true;
    board.destroy();
    cloud?.destroy();
    if (!stopping) setTimeout(connect, 1000);
  };
  // Wait for the board's TLS ClientHello. A preconnected TLS socket can time
  // out at the cloud while the device is between 30-second heartbeats.
  board.once('connect', () => {
    board.once('data', (first) => {
      board.pause();
      cloud = net.connect({ host: server, port: 443 });
      cloud.once('connect', () => {
        cloud.write(first);
        board.pipe(cloud);
        cloud.pipe(board);
        board.resume();
      });
      cloud.on('error', retry);
      cloud.on('close', retry);
    });
  });
  board.on('error', retry);
  board.on('close', retry);
}
connect();
console.log(
  'USB cloud transport active; HTTPS authentication remains on the device.'
);
