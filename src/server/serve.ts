#!/usr/bin/env node
import { loadEnvFile } from '../core/env.js';
import { serve } from './app.js';

loadEnvFile();

const portArg = process.argv.indexOf('--port');
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : undefined;

serve(Number.isFinite(port) ? port : undefined);
