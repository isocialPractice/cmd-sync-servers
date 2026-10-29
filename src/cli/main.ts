#!/usr/bin/env node
import { processIo } from './io.ts';
import { runCli } from './router.ts';

process.exitCode = await runCli(process.argv.slice(2), processIo());
