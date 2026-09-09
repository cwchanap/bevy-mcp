import { BrpClient } from './brp/client.js';
import { LogStore } from './runtime/log-store.js';
import { WatchManager } from './runtime/watch-manager.js';
import type { ToolContractCatalog } from './tool-contracts.js';
import { loadToolContractCatalog } from './tool-contracts.js';

/** Referenced Bevy child-process tracking and shutdown. */
export interface ProcessService {
  shutdownAll(): Promise<void>;
}

/** Shared service objects handed to every owned tool. */
export interface BevyMcpServices {
  brp: BrpClient;
  catalog: ToolContractCatalog;
  logStore: LogStore;
  watches: WatchManager;
  processes: ProcessService;
}

/**
 * Create the shared services. `processes` is a no-op stub until the
 * process-management task replaces it; everything else is final.
 */
export function createServices(): BevyMcpServices {
  const brp = new BrpClient();
  const logStore = new LogStore();
  return {
    brp,
    catalog: loadToolContractCatalog(),
    logStore,
    watches: new WatchManager(logStore, brp),
    processes: {
      // ponytail: stub until the process-tracking task lands; owned-index cleanup order already codes the contract
      shutdownAll: async () => {},
    },
  };
}
