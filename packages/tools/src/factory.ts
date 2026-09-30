import { IDatabaseRepository } from '@nexa/database';
import { PlaywrightBrowserService } from '@nexa/browser';
import { ToolRegistry } from './registry.js';
import { createWebSearchTool, DuckDuckGoSearchProvider } from './tools/web-search.js';
import { createBrowserTools } from './tools/browser-tools.js';
import { createTravelTools, LiveWebFlightProvider, LiveWebHotelProvider } from './tools/travel-tools.js';
import { createShoppingTools } from './tools/shopping-tools.js';
import { createCommunicationTools, DisconnectedEmailProvider } from './tools/communication-tools.js';
import { createProductivityTools } from './tools/productivity-tools.js';
import { createMemoryTools } from './tools/memory-tools.js';
import { createApprovalTool } from './tools/approval-tool.js';

export function createDefaultToolRegistry(options: {
  db: IDatabaseRepository;
  browserService?: PlaywrightBrowserService;
}): ToolRegistry {
  const registry = new ToolRegistry({ db: options.db });
  const searchProvider = new DuckDuckGoSearchProvider();

  // 1. Web Search
  registry.register(createWebSearchTool(searchProvider));

  // 2. Controlled Browser Automation
  const browserService = options.browserService || new PlaywrightBrowserService();
  for (const browserTool of createBrowserTools(browserService)) {
    registry.register(browserTool);
  }

  // 3. Travel (Flights & Hotels)
  const flightProvider = new LiveWebFlightProvider(searchProvider);
  const hotelProvider = new LiveWebHotelProvider(searchProvider);
  for (const travelTool of createTravelTools(flightProvider, hotelProvider)) {
    registry.register(travelTool);
  }

  // 4. Shopping & Price Comparison
  for (const shoppingTool of createShoppingTools(searchProvider)) {
    registry.register(shoppingTool);
  }

  // 5. Communication (Email)
  const emailProvider = new DisconnectedEmailProvider();
  for (const commTool of createCommunicationTools(emailProvider)) {
    registry.register(commTool);
  }

  // 6. Productivity (Calendar & Reminders)
  for (const prodTool of createProductivityTools(options.db)) {
    registry.register(prodTool);
  }

  // 7. Long-term User Memory
  for (const memoryTool of createMemoryTools(options.db)) {
    registry.register(memoryTool);
  }

  // 8. Explicit Approval Workflow
  registry.register(createApprovalTool());

  return registry;
}
