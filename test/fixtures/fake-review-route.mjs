#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

if (process.env.XM_FAKE_ROUTE_LOG) appendFileSync(process.env.XM_FAKE_ROUTE_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write('{"delegated":true}\n');

