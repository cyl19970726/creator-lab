#!/usr/bin/env node
import "dotenv/config";
import { startSignalRoomServer } from "../../../src/server/http-runtime.js";
import { Command } from "commander";
import { apiPort } from "../../../packages/adapters/index.js";
import { createSignalRoomComposition } from "../../../src/server/composition-root.js";

const program = new Command();
program.name("selfmedia").description("小红书 / X 内容证据分析工作台").version("0.1.0");

program.command("serve")
  .description("启动本地 API")
  .option("--port <number>", "端口")
  .action((options: { port?: string }) => {
    const port = Number(options.port ?? apiPort());
    const composition = createSignalRoomComposition();
    startSignalRoomServer(composition, port);
  });

await program.parseAsync();
