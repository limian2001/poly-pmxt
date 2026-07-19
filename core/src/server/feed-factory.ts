import { IDataFeed } from '../feeds/interfaces';
import { BinanceFeed } from '../feeds/binance';
import { ChainlinkFeed } from '../feeds/chainlink/chainlink-feed';

const feedInstances = new Map<string, IDataFeed>();

/**
 * Create or retrieve a singleton IDataFeed instance by name.
 */
export function getFeed(name: string): IDataFeed {
    const key = name.toLowerCase();
    const cached = feedInstances.get(key);
    if (cached) return cached;

    let feed: IDataFeed;
    switch (key) {
        case 'binance':
            feed = new BinanceFeed({
                apiKey: process.env.OBDATA_API_KEY,
            });
            break;
        case 'chainlink':
            feed = new ChainlinkFeed({
                apiKey: process.env.OBDATA_API_KEY || '',
            });
            break;
        default:
            throw new Error(`Unknown feed: ${name}. Available: binance, chainlink`);
    }

    feedInstances.set(key, feed);
    return feed;
}

export const AVAILABLE_FEEDS = ['binance', 'chainlink'] as const;
