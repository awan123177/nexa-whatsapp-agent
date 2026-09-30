import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { SearchProvider } from './web-search.js';

export interface FlightOption {
  airline: string;
  flightNumber?: string;
  departureTime: string;
  arrivalTime: string;
  duration?: string;
  stops: number;
  price: number;
  currency: string;
  bookingUrl?: string;
}

export interface FlightProvider {
  searchFlights(params: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    maxBudget?: number;
    currency?: string;
  }): Promise<{ flights: FlightOption[]; providerStatus: string; notice?: string }>;
}

export interface HotelOption {
  name: string;
  rating?: number;
  pricePerNight: number;
  currency: string;
  location?: string;
  bookingUrl?: string;
}

export interface HotelProvider {
  searchHotels(params: {
    city: string;
    checkInDate: string;
    checkOutDate: string;
    guests?: number;
    maxBudget?: number;
  }): Promise<{ hotels: HotelOption[]; providerStatus: string; notice?: string }>;
}

/**
 * Transparent Travel Provider that searches live web data or prompts configuration.
 * Never fabricates nonexistent flights or rates.
 */
export class LiveWebFlightProvider implements FlightProvider {
  constructor(private searchProvider: SearchProvider) {}

  async searchFlights(params: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    maxBudget?: number;
    currency?: string;
  }): Promise<{ flights: FlightOption[]; providerStatus: string; notice?: string }> {
    const query = `flights from ${params.origin} to ${params.destination} on ${params.departureDate} price`;
    const searchResults = await this.searchProvider.search(query, 5);

    return {
      flights: [],
      providerStatus: 'web_search_fallback',
      notice:
        `Direct GDS/Airline ticketing API (e.g., Amadeus / Duffel) is not connected. ` +
        `Live flight search was performed via web search. ` +
        `Relevant flight sources found: ${searchResults.map((r) => r.title).join('; ')}. ` +
        `NEXA will not invent fictional flight numbers or ticket prices.`,
    };
  }
}

export class LiveWebHotelProvider implements HotelProvider {
  constructor(private searchProvider: SearchProvider) {}

  async searchHotels(params: {
    city: string;
    checkInDate: string;
    checkOutDate: string;
    guests?: number;
    maxBudget?: number;
  }): Promise<{ hotels: HotelOption[]; providerStatus: string; notice?: string }> {
    const query = `hotels in ${params.city} from ${params.checkInDate} to ${params.checkOutDate}`;
    const searchResults = await this.searchProvider.search(query, 5);

    return {
      hotels: [],
      providerStatus: 'web_search_fallback',
      notice:
        `Direct hotel reservation API is not connected. ` +
        `Live accommodation search was performed via web search. ` +
        `Found sources: ${searchResults.map((r) => r.title).join('; ')}.`,
    };
  }
}

export function createTravelTools(
  flightProvider: FlightProvider,
  hotelProvider: HotelProvider
): BaseTool[] {
  const searchFlightsTool: BaseTool = {
    name: 'search_flights',
    description: 'Searches for real flight availability, schedules, and fares between cities or airport codes.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      origin: z.string().describe('Origin city or 3-letter IATA airport code (e.g. BLR, Bengaluru)'),
      destination: z.string().describe('Destination city or 3-letter IATA airport code (e.g. DXB, Dubai)'),
      departureDate: z.string().describe('Departure date in YYYY-MM-DD format'),
      returnDate: z.string().optional().describe('Optional return date in YYYY-MM-DD format for round trips'),
      maxBudget: z.number().optional().describe('Maximum budget in the specified currency'),
      currency: z.string().default('INR').describe('3-letter currency code (e.g. INR, USD, EUR)'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: any, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await flightProvider.searchFlights(args);
      return { success: true, data };
    },
  };

  const searchHotelsTool: BaseTool = {
    name: 'search_hotels',
    description: 'Searches for real hotel accommodations, availability, and nightly rates in a city.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      city: z.string().describe('City or area name (e.g. Paris, Goa, Dubai)'),
      checkInDate: z.string().describe('Check-in date in YYYY-MM-DD format'),
      checkOutDate: z.string().describe('Check-out date in YYYY-MM-DD format'),
      guests: z.number().default(1).describe('Number of guests'),
      maxBudget: z.number().optional().describe('Maximum budget per night'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: any, _context: ToolExecutionContext): Promise<ToolResult> => {
      const data = await hotelProvider.searchHotels(args);
      return { success: true, data };
    },
  };

  return [searchFlightsTool, searchHotelsTool];
}
