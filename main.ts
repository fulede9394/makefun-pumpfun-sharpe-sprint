// Launcher for the paper-trading bot: assemble the strategy from its
// default configuration, then hand it to the runtime to execute.
import { createStrategy, DEFAULT_SETTINGS } from "./strategy.ts";
import { runBot } from "./vendor/makefun-bot.ts";

const settings = DEFAULT_SETTINGS;
const strategy = createStrategy(settings);

await runBot(strategy);
