import { BrpClient } from './brp/client.js';
import { CargoRuntime } from './runtime/cargo.js';
import { LogStore } from './runtime/log-store.js';
import { ProcessManager } from './runtime/process-manager.js';
import type { ProcessService } from './runtime/process-manager.js';
import { WatchManager } from './runtime/watch-manager.js';
import type { ToolContractCatalog } from './tool-contracts.js';
import { loadToolContractCatalog } from './tool-contracts.js';

export type { ProcessService } from './runtime/process-manager.js';

/** Shared service objects handed to every owned tool. */
export interface BevyMcpServices {
  brp: BrpClient;
  cargo: CargoRuntime;
  catalog: ToolContractCatalog;
  logStore: LogStore;
  watches: WatchManager;
  processes: ProcessService;
}

/** Create the shared services for the owned server. */
export function createServices(): BevyMcpServices {
  const brp = new BrpClient();
  const logStore = new LogStore();
  return {
    brp,
    cargo: new CargoRuntime(),
    catalog: loadToolContractCatalog(),
    logStore,
    watches: new WatchManager(logStore, brp),
    processes: new ProcessManager(),
  };
}
