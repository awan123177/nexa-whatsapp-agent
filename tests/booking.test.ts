import { describe, it, expect, vi } from 'vitest';
import {
  createTravelTools,
  FlightBookingProvider,
  HotelBookingProvider,
  FlightProvider,
  HotelProvider,
  LiveFlightBookingProvider,
  LiveHotelBookingProvider,
} from '../packages/tools/src/tools/travel-tools.js';
import { ApprovalRequiredError } from '../packages/shared/src/index.js';
import { InMemoryRepository } from '../packages/database/src/index.js';

describe('Real Booking Capabilities Suite', () => {
  const dummyContext = (isConfirmed = false) => ({
    user: { id: 'u1', phone_number: '+919876543210' } as any,
    conversation: { id: 'c1' } as any,
    messageId: 'm1',
    sourceChannel: 'whatsapp' as const,
    isUserConfirmed: isConfirmed,
  });

  const dummyFlightProvider: FlightProvider = {
    searchFlights: vi.fn(async () => ({
      flights: [],
      providerStatus: 'unconfigured_fallback',
    })),
  };

  const dummyHotelProvider: HotelProvider = {
    searchHotels: vi.fn(async () => ({
      hotels: [],
      providerStatus: 'unconfigured_fallback',
    })),
  };

  it('Separates search tools (read_only) from booking tools (critical, approval required)', async () => {
    const tools = createTravelTools(dummyFlightProvider, dummyHotelProvider);

    const searchFlight = tools.find((t) => t.name === 'search_flights')!;
    const searchHotel = tools.find((t) => t.name === 'search_hotels')!;
    const bookFlight = tools.find((t) => t.name === 'book_flight')!;
    const bookHotel = tools.find((t) => t.name === 'book_hotel')!;

    expect(searchFlight.riskLevel).toBe('read_only');
    const req1 = await Promise.resolve(searchFlight.requiresApproval({}, dummyContext()));
    expect(req1.required).toBe(false);

    expect(searchHotel.riskLevel).toBe('read_only');
    const req2 = await Promise.resolve(searchHotel.requiresApproval({}, dummyContext()));
    expect(req2.required).toBe(false);

    expect(bookFlight.riskLevel).toBe('critical');
    const req3 = await Promise.resolve(bookFlight.requiresApproval({}, dummyContext()));
    expect(req3.required).toBe(true);

    expect(bookHotel.riskLevel).toBe('critical');
    const req4 = await Promise.resolve(bookHotel.requiresApproval({}, dummyContext()));
    expect(req4.required).toBe(true);
  });

  it('book_flight raises ApprovalRequiredError with full itinerary details when unconfirmed', async () => {
    const tools = createTravelTools(dummyFlightProvider, dummyHotelProvider);
    const bookFlight = tools.find((t) => t.name === 'book_flight')!;

    const flightArgs = {
      origin: 'BLR',
      destination: 'DXB',
      departureDate: '2026-11-15',
      airline: 'Emirates',
      flightNumber: 'EK-565',
      passengerName: 'Awan Warsi',
      price: 24500,
      currency: 'INR',
    };

    await expect(bookFlight.execute(flightArgs, dummyContext(false))).rejects.toThrow(
      ApprovalRequiredError
    );

    try {
      await bookFlight.execute(flightArgs, dummyContext(false));
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApprovalRequiredError);
      expect(err.confirmationPrompt).toContain('EK-565');
      expect(err.confirmationPrompt).toContain('Emirates');
      expect(err.confirmationPrompt).toContain('Awan Warsi');
      expect(err.confirmationPrompt).toContain('24500');
    }
  });

  it('book_flight does NOT fabricate fake confirmation when provider credentials are unconfigured', async () => {
    const liveFlightBooking = new LiveFlightBookingProvider();
    expect(liveFlightBooking.isConfigured()).toBe(false);

    const tools = createTravelTools(
      dummyFlightProvider,
      dummyHotelProvider,
      liveFlightBooking
    );
    const bookFlight = tools.find((t) => t.name === 'book_flight')!;

    const result = await bookFlight.execute(
      {
        origin: 'BLR',
        destination: 'DXB',
        departureDate: '2026-11-15',
        airline: 'Emirates',
        flightNumber: 'EK-565',
        passengerName: 'Awan Warsi',
        price: 24500,
        currency: 'INR',
      },
      dummyContext(true) // Confirmed by user
    );

    expect(result.success).toBe(false);
    expect((result.data as any).confirmationStatus).toBe('failed');
    // Must NOT contain fake PNR like "CONFIRMED-XYZ"
    expect((result.data as any).bookingReference).toBeUndefined();
    expect(result.userFacingMessage).toContain('Direct automated airline ticketing is not connected');
  });

  it('book_flight completes booking with confirmed status and verified reference when provider is configured', async () => {
    const mockProvider: FlightBookingProvider = {
      isConfigured: () => true,
      bookFlight: vi.fn(async (params) => ({
        success: true,
        bookingReference: 'EK-LIVE-789012',
        confirmationStatus: 'confirmed' as const,
        providerStatus: 'amadeus_live',
        userFacingMessage: `🎉 Confirmed! Your flight ${params.flightNumber} is booked under reference EK-LIVE-789012.`,
      })),
    };

    const tools = createTravelTools(
      dummyFlightProvider,
      dummyHotelProvider,
      mockProvider
    );
    const bookFlight = tools.find((t) => t.name === 'book_flight')!;

    const result = await bookFlight.execute(
      {
        origin: 'BLR',
        destination: 'DXB',
        departureDate: '2026-11-15',
        airline: 'Emirates',
        flightNumber: 'EK-565',
        passengerName: 'Awan Warsi',
        price: 24500,
        currency: 'INR',
      },
      dummyContext(true)
    );

    expect(result.success).toBe(true);
    expect((result.data as any).bookingReference).toBe('EK-LIVE-789012');
    expect((result.data as any).confirmationStatus).toBe('confirmed');
    expect(result.userFacingMessage).toContain('EK-LIVE-789012');
  });

  it('book_hotel raises ApprovalRequiredError when unconfirmed, and reports clear status when executed', async () => {
    const mockHotelBooking: HotelBookingProvider = {
      isConfigured: () => true,
      bookHotel: vi.fn(async (params) => ({
        success: true,
        bookingReference: 'HTL-PARIS-4455',
        confirmationStatus: 'confirmed' as const,
        providerStatus: 'booking_com_live',
        userFacingMessage: `🏨 Booking confirmed at ${params.hotelName} for ${params.guestName}. Confirmation: HTL-PARIS-4455.`,
      })),
    };

    const tools = createTravelTools(
      dummyFlightProvider,
      dummyHotelProvider,
      undefined,
      mockHotelBooking
    );
    const bookHotel = tools.find((t) => t.name === 'book_hotel')!;

    const hotelArgs = {
      hotelName: 'Le Grand Hotel',
      city: 'Paris',
      checkInDate: '2026-12-01',
      checkOutDate: '2026-12-05',
      guestName: 'Awan Warsi',
      rooms: 1,
      totalPrice: 45000,
      currency: 'INR',
    };

    // Unconfirmed MUST throw
    await expect(bookHotel.execute(hotelArgs, dummyContext(false))).rejects.toThrow(
      ApprovalRequiredError
    );

    // Confirmed succeeds
    const result = await bookHotel.execute(hotelArgs, dummyContext(true));
    expect(result.success).toBe(true);
    expect((result.data as any).bookingReference).toBe('HTL-PARIS-4455');
    expect(result.userFacingMessage).toContain('HTL-PARIS-4455');
  });
});
