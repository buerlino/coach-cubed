// The pose engine's worker: MoveNet Thunder behind contract 1's messages
// (app/src/contracts/pose-messages.mjs). Started by pose-client.mjs as a module
// worker. The frame of an estimate (a VideoFrame) is transferred in and closed
// here.
import { createWorkerHandler } from './worker-core.mjs';
import { loadMoveNet } from './movenet.mjs';

const handle = createWorkerHandler({ load: loadMoveNet, post: msg => self.postMessage(msg) });
self.onmessage = ({ data }) => { handle(data); };
