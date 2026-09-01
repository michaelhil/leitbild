#!/usr/bin/env bun

import { bootstrap } from './bootstrap.ts'

if (import.meta.main) await bootstrap()
