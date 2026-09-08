import { BrpClient } from './brp/client.js';
import type { ToolContractCatalog } from './tool-contracts.js';
import { loadToolContractCatalog } from './tool-contracts.js';

/** Watches lifecycle (native `world.get/list_components+watch` SSE streams). */
export interface WatchService {
  stopAll(): Promise<void>;
}

/** Referenced Bevy child-process tracking and shutdown. */
export interface ProcessService {
  shutdownAll(): Promise<void>;
}

/** Shared service objects handed to every owned tool. */
export interface BevyMcpServices {
  brp: BrpClient;
  catalog: ToolContractCatalog;
  watches: WatchService;
  processes: ProcessService;
}

/**
 * Create the shared services. `watches` and `processes` are no-op stubs until
 * the watch and process-management tasks replace them; `catalog` is final.
 */
export function createServices(): BevyMcpServices {
  return {
    brp: new BrpClient(),
    catalog: loadToolContractCatalog(),
    watches: {
      // ponytail: stub until the watch task lands; owned-index cleanup order already codes the contract
      stopAll: async () => {},
    },
    processes: {
      // ponytail: stub until the process-tracking task lands; owned-index cleanup order already codes the contract
      shutdownAll: async () => {},
    },
  };
}
