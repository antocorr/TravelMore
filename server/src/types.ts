export type NodeType = 'trip' | 'stop' | 'place';
export type TripNode = {
  id: string; parentId: string | null; title: string; type: NodeType;
  description: string; notes: string; lat: number | null; lng: number | null; address: string | null;
  startDate: string | null; endDate: string | null; position: number;
  createdAt: string; updatedAt: string;
};
export type Todo = { id: string; nodeId: string; title: string; done: boolean; position: number; createdAt: string; updatedAt: string };
export type TravelImage = { id: string; nodeId: string; url: string; caption: string; sourceUrl: string | null; provenance: string | null; isPrimary: boolean; createdAt: string };
export type FlightSearchInput = {
  tripId?: string; origins: string[]; destinations: string[];
  departure: { from: string; to: string }; return?: { from: string; to: string };
  adults?: number; currency?: string;
};
export type FlightSearch = FlightSearchInput & { id: string; createdAt: string; updatedAt: string; status: 'observed' | 'unavailable'; sources: FlightSource[] };
export type FlightSource = { provider: 'google-flights' | 'skyscanner'; url: string; status: 'unavailable' | 'observed'; fetchedAt: string | null; message?: string };
export type FlightCandidate = {
  id: string; searchId: string; selected: boolean; note: string; origin: string; destination: string;
  departureAt: string | null; returnAt: string | null; price: number | null; currency: string | null;
  provider: string; status: 'observed'; sourceUrl: string; provenance: string; fetchedAt: string; createdAt: string; updatedAt: string;
};
export type ProviderConnection = { id: string; name: string; provider: string; model: string; apiKey: string; baseUrl: string; createdAt: string; updatedAt: string };
export type ChatEntry = { id: string; scope?: string; tripId?: string; role: 'user' | 'assistant' | 'tool'; text: string; createdAt: string; meta?: Record<string, unknown> };
import type { FlightWatch } from './services/flights/matrix.js';
import type { FlightOffer, FlightPricePoint, FlightRun } from './services/flights/history.js';

export type TravelStoreData = { version: 1; revision: number; nodes: TripNode[]; todos: Todo[]; images: TravelImage[]; flightSearches: FlightSearch[]; flightCandidates: FlightCandidate[]; providers: ProviderConnection[]; tripProviders: Record<string, string>; chats: ChatEntry[]; flightWatches: FlightWatch[]; flightRuns: FlightRun[]; flightOffers: FlightOffer[]; flightPrices: FlightPricePoint[] };
