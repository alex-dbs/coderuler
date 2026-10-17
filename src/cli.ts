#!/usr/bin/env node
import { runCli } from './infra/runtime.js';

process.exitCode = await runCli(process.argv.slice(2));
