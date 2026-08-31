#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

if (process.env.XM_FAKE_TRACE_LOG) appendFileSync(process.env.XM_FAKE_TRACE_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
process.stdout.write('recorded review\n');
