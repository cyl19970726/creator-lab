#!/usr/bin/env node
import { parseArgs, readJson, requireArg } from "./lib.mjs";
import { planCaptureProtocol } from "./capture-plan.mjs";

const args = parseArgs(process.argv.slice(2));
const protocol = readJson(requireArg(args, "protocol"));
const duration = Number(args.duration);
if (!Number.isFinite(duration) || duration < 0) throw new Error("--duration must be a finite nonnegative number");
const plan = planCaptureProtocol(protocol, duration);
process.stdout.write(`${JSON.stringify({ pass: plan.pass, totalUniqueTimes: plan.totalUniqueTimes,
  maxTotalFrames: plan.maxTotalFrames, actions: plan.actions.map(({ action, index, sampleSource, sampleCount, newUniqueTimes, cumulativeUniqueTimes, selected }) =>
    ({ id: action.id, index, range: action.range, sampleSource, sampleCount, newUniqueTimes, cumulativeUniqueTimes, selectedTimes: selected })),
  errors: plan.errors })}\n`);
