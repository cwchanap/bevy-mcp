#!/usr/bin/env node
import { launchUpstream } from '../src/launcher.mjs';

const { child, done } = launchUpstream({ argv: process.argv.slice(2) });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

done.then((code) => process.exit(code));
