#!/usr/bin/env node
import { launchUpstream } from './launcher.js';

const { child, done } = launchUpstream({ argv: process.argv.slice(2) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

done.then((code) => process.exit(code));
