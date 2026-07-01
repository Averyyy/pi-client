#!/usr/bin/env node
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = "pi-client";
process.env.PI_CODING_AGENT = "true";
process.env.PI_SERVER_MODE = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(process.argv.slice(2));
